import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createPoller } from './poller.js';
import { createJobs } from './jobs.js';
import { api, PanelError } from './panel.js';
import { HttpError, mapLimit, sleep, str } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CONTAINER_OPS = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'remove'];
const COMPOSE_OPS = ['up', 'start', 'restart', 'stop', 'down'];
const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'];
const MAX_JSON = 1024 * 1024;

const lines = (v) => String(v || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const ver = (v) => String(v || '').replace(/^v/i, '');

/** 把表单里的简写（每行一条）转换成 1Panel 的 ContainerOperate 请求体 */
export function buildContainerSpec(b) {
  const name = str(b.name, 100);
  const image = str(b.image, 300);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new HttpError(400, '容器名称只能包含字母、数字、_ . -');
  if (!image || /\s/.test(image)) throw new HttpError(400, '镜像名称无效');
  const exposedPorts = lines(b.ports).map((l) => {
    const m = l.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d+(?:-\d+)?):(\d+(?:-\d+)?)(?:\/(tcp|udp))?$/);
    if (!m) throw new HttpError(400, `端口映射格式错误：${l}（应为 主机端口:容器端口[/udp]）`);
    return { hostIP: m[1] || '', hostPort: m[2], containerPort: m[3], protocol: m[4] || 'tcp' };
  });
  const volumes = lines(b.volumes).map((l) => {
    const m = l.match(/^([^:]+):(\/[^:]*)(?::(ro|rw))?$/);
    if (!m) throw new HttpError(400, `挂载格式错误：${l}（应为 主机目录或卷名:/容器目录[:ro]）`);
    return { type: m[1].startsWith('/') ? 'bind' : 'volume', sourceDir: m[1], containerDir: m[2], mode: m[3] || 'rw', shared: '' };
  });
  const env = lines(b.env);
  for (const e of env) if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) throw new HttpError(400, `环境变量格式错误：${e.split('=')[0]}（应为 KEY=VALUE）`);
  const restartPolicy = RESTART_POLICIES.includes(b.restartPolicy) ? b.restartPolicy : 'unless-stopped';
  return {
    name, image, forcePull: !!b.forcePull,
    hostname: '', domainName: '', dns: [],
    networks: [{ network: str(b.network, 100) || 'bridge' }],
    publishAllPorts: false, exposedPorts,
    tty: false, openStdin: false, workingDir: '', user: '', cmd: [], entrypoint: [],
    cpuShares: 1024, nanoCPUs: 0, memory: 0, privileged: false, autoRemove: false,
    volumes, extraHosts: [], labels: [], env, restartPolicy,
  };
}

export function createApp(cfg, log = console.log) {
  const store = createStore(cfg);
  const auth = createAuth(cfg, store, log);
  const poller = createPoller(cfg, store);
  const jobs = createJobs();

  // ---------- helpers ----------
  const mustServer = (id) => {
    const s = store.getServer(id);
    if (!s) throw new HttpError(404, '服务器不存在');
    return s;
  };
  const publicServer = (s) => ({
    id: s.id, name: s.name, url: s.url, group: s.group || '', note: s.note || '',
    skipTls: !!s.skipTls, keyId: s.keyId || '', status: poller.get(s.id),
  });
  const targetsOf = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, '请至少选择一台服务器');
    return [...new Set(ids)].map((id) => ({ serverId: id, name: mustServer(id).name }));
  };
  const panelOf = (id) => store.resolve(mustServer(id));

  function parseServer(b, existing) {
    const name = str(b.name, 60);
    if (!name) throw new HttpError(400, '名称不能为空');
    let u;
    try {
      u = new URL(str(b.url, 300));
    } catch {
      throw new HttpError(400, '面板地址无效，示例：https://example.com:10086');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, '面板地址必须以 http:// 或 https:// 开头');
    const fields = {
      name, url: u.origin, group: str(b.group, 40), note: str(b.note, 200),
      keyId: str(b.keyId, 100), skipTls: !!b.skipTls,
    };
    const apiKey = str(b.apiKey, 500);
    if (apiKey) fields.apiKeyEnc = store.encrypt(apiKey);
    else if (!existing) throw new HttpError(400, 'API Key 不能为空');
    return fields;
  }

  /** 对一台或全部服务器执行查询，单台失败只影响该台 */
  async function collect(serverParam, fn) {
    const servers = serverParam && serverParam !== 'all' ? [mustServer(serverParam)] : store.listServers();
    return mapLimit(servers, cfg.concurrency, async (sv) => {
      const out = { serverId: sv.id, serverName: sv.name, items: [] };
      try {
        const data = await fn(store.resolve(sv));
        out.items = data?.items || [];
      } catch (e) {
        out.error = e.message;
      }
      return out;
    });
  }

  function startJob(ctx, meta, targets, worker) {
    store.audit({ user: ctx.user, ip: ctx.ip, action: meta.title, detail: targets.map((t) => t.name).join('、') });
    const job = jobs.run({ ...meta, user: ctx.user }, targets, worker);
    job.promise.then((j) => {
      const ok = j.items.filter((i) => i.status === 'success').length;
      store.audit({ user: ctx.user, ip: ctx.ip, action: `${meta.title}（完成）`, detail: `成功 ${ok} / 失败 ${j.items.length - ok}` });
    });
    return job;
  }
  /** 快速操作等一小会儿再返回，前端可以直接拿到结果；超时则转为后台任务 */
  const settled = async (job, ms = 15_000) => {
    await Promise.race([job.promise, sleep(ms)]);
    return jobs.view(job);
  };

  const upgrading = new Set(); // 正在升级的服务器，防止对同一台重复提交

  async function upgradeWorker(target, report, channel) {
    if (upgrading.has(target.serverId)) throw new Error('该服务器已有升级任务在进行');
    upgrading.add(target.serverId);
    try {
      return await doUpgrade(target, report, channel);
    } finally {
      upgrading.delete(target.serverId);
    }
  }

  async function doUpgrade(target, report, channel) {
    const server = mustServer(target.serverId);
    const s = store.resolve(server);
    const before = (await api.settings(s))?.systemVersion || '';
    const info = await api.upgradeInfo(s);
    const version = channel === 'latest' ? info?.latestVersion || info?.newVersion : info?.newVersion;
    if (!version || ver(version) === ver(before)) return `已是最新版本 ${before}`;
    report(`${before} → ${version}，已提交升级`);
    try {
      await api.upgrade(s, version);
    } catch (e) {
      if (!e.network) throw e; // 面板重启导致的连接中断不算失败，继续轮询确认
    }
    const deadline = Date.now() + cfg.upgradeTimeoutMs;
    let sawDown = false;
    let backOld = 0;
    while (Date.now() < deadline) {
      await sleep(cfg.upgradePollMs);
      let cur;
      try {
        cur = (await api.settings(s, { timeout: 8000 }))?.systemVersion || '';
      } catch {
        sawDown = true;
        report('面板重启中…');
        continue;
      }
      if (ver(cur) === ver(version)) {
        poller.pollOne(server, { checkUpgrade: true }).catch(() => {});
        return `升级成功：${before} → ${version}`;
      }
      if (sawDown && ++backOld >= 3) throw new Error(`面板重启后版本仍为 ${cur}，升级失败（面板可能已自动回滚）`);
      report(`升级中（当前 ${cur}，目标 ${version}）`);
    }
    throw new Error(`等待升级完成超时（目标 ${version}），请登录面板确认`);
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, opts, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, opts, fn });
  };
  const PUBLIC_R = { public: true };
  const READ = {};
  const WRITE = { write: true };

  route('GET', '/api/health', PUBLIC_R, () => ({ ok: true }));

  route('POST', '/api/login', PUBLIC_R, ({ body, ip, res }) => {
    const r = auth.login(ip, body.username || '', body.password || '');
    if (r.locked) throw new HttpError(429, `登录失败次数过多，请 ${Math.ceil(r.retryAfter / 60)} 分钟后再试`);
    if (!r.ok) {
      store.audit({ user: str(body.username, 40), ip, action: '登录失败', detail: '' });
      throw new HttpError(401, '用户名或密码错误');
    }
    res.setHeader('Set-Cookie', auth.setCookie(r.token));
    store.audit({ user: cfg.adminUser, ip, action: '登录', detail: '' });
    return { user: cfg.adminUser };
  });

  route('POST', '/api/logout', READ, ({ req, res }) => {
    auth.logout(req);
    res.setHeader('Set-Cookie', auth.clearCookie());
  });

  route('GET', '/api/me', READ, ({ user }) => ({ user, readOnly: cfg.readOnly, version: VERSION }));

  // ---- 服务器 ----
  route('GET', '/api/servers', READ, () => store.listServers().map(publicServer));

  route('POST', '/api/servers', WRITE, async ({ body, user, ip }) => {
    const server = store.addServer(parseServer(body));
    store.audit({ user, ip, action: '添加服务器', detail: server.name });
    await poller.pollOne(server, { checkUpgrade: true }).catch(() => {});
    return publicServer(server);
  });

  route('PUT', '/api/servers/:id', WRITE, async ({ params, body, user, ip }) => {
    const existing = mustServer(params.id);
    const server = store.updateServer(params.id, parseServer(body, existing));
    store.audit({ user, ip, action: '修改服务器', detail: server.name });
    await poller.pollOne(server, { checkUpgrade: true }).catch(() => {});
    return publicServer(server);
  });

  route('DELETE', '/api/servers/:id', WRITE, ({ params, user, ip }) => {
    const server = mustServer(params.id);
    store.removeServer(params.id);
    poller.forget(params.id);
    store.audit({ user, ip, action: '删除服务器', detail: server.name });
  });

  // 刷新只读取状态，只读模式下也允许
  route('POST', '/api/servers/:id/refresh', READ, async ({ params }) => {
    const server = mustServer(params.id);
    await poller.pollOne(server, { checkUpgrade: true });
    return publicServer(server);
  });

  route('POST', '/api/refresh', READ, async ({ body }) => {
    await mapLimit(store.listServers(), cfg.concurrency, (s) =>
      poller.pollOne(s, { checkUpgrade: !!body.checkUpgrade }).catch(() => null));
    return store.listServers().map(publicServer);
  });

  // ---- 面板升级 ----
  route('POST', '/api/upgrade', WRITE, (ctx) => {
    const channel = ctx.body.channel === 'latest' ? 'latest' : 'new';
    const job = startJob(
      ctx,
      { type: 'upgrade', title: '升级 1Panel', concurrency: cfg.upgradeConcurrency },
      targetsOf(ctx.body.serverIds),
      (t, report) => upgradeWorker(t, report, channel),
    );
    return jobs.view(job);
  });

  // ---- 容器 ----
  route('GET', '/api/containers', READ, ({ query }) => {
    const state = query.get('state') || 'all';
    return collect(query.get('server'), (s) =>
      api.searchContainers(s, { name: str(query.get('name'), 100), state }, { timeout: cfg.requestTimeoutMs }));
  });

  route('POST', '/api/containers/operate', WRITE, (ctx) => {
    const { operation, targets } = ctx.body;
    if (!CONTAINER_OPS.includes(operation)) throw new HttpError(400, '不支持的操作');
    if (!Array.isArray(targets) || !targets.length) throw new HttpError(400, '请选择容器');
    const byServer = new Map();
    for (const t of targets) {
      const names = (Array.isArray(t.names) ? t.names : []).map((n) => str(n, 200)).filter(Boolean);
      if (!names.length) continue;
      byServer.set(t.serverId, [...(byServer.get(t.serverId) || []), ...names]);
    }
    const job = startJob(
      ctx,
      { type: 'container', title: `容器 ${operation}`, concurrency: cfg.concurrency },
      targetsOf([...byServer.keys()]),
      async (t) => {
        const names = byServer.get(t.serverId);
        await api.operateContainers(panelOf(t.serverId), names, operation);
        return `${operation}：${names.join('、')}`;
      },
    );
    return settled(job);
  });

  route('POST', '/api/containers/upgrade', WRITE, (ctx) => {
    const { targets, forcePull } = ctx.body;
    const image = str(ctx.body.image, 300);
    if (!image || /\s/.test(image)) throw new HttpError(400, '镜像名称无效');
    if (!Array.isArray(targets) || !targets.length) throw new HttpError(400, '请选择容器');
    const byServer = new Map(targets.map((t) => [t.serverId, (t.names || []).map((n) => str(n, 200)).filter(Boolean)]));
    const job = startJob(
      ctx,
      { type: 'container', title: `容器升级镜像 ${image}`, concurrency: cfg.concurrency },
      targetsOf([...byServer.keys()]),
      async (t) => {
        await api.upgradeContainer(panelOf(t.serverId), byServer.get(t.serverId), image, forcePull);
        return `已提交：${byServer.get(t.serverId).join('、')} → ${image}`;
      },
    );
    return settled(job);
  });

  route('POST', '/api/containers/create', WRITE, (ctx) => {
    const spec = buildContainerSpec(ctx.body.spec || {});
    const job = startJob(
      ctx,
      { type: 'container', title: `创建容器 ${spec.name}`, concurrency: cfg.concurrency },
      targetsOf(ctx.body.serverIds),
      async (t) => {
        await api.createContainer(panelOf(t.serverId), spec);
        return '已提交创建，拉取镜像与启动由面板在后台完成';
      },
    );
    return settled(job);
  });

  route('POST', '/api/images/pull', WRITE, (ctx) => {
    const image = str(ctx.body.image, 300);
    if (!image || /\s/.test(image)) throw new HttpError(400, '镜像名称无效');
    const job = startJob(
      ctx,
      { type: 'image', title: `拉取镜像 ${image}`, concurrency: cfg.concurrency },
      targetsOf(ctx.body.serverIds),
      async (t) => {
        await api.pullImage(panelOf(t.serverId), image);
        return '已提交拉取，进度见面板任务中心';
      },
    );
    return settled(job);
  });

  // ---- Compose ----
  route('GET', '/api/composes', READ, ({ query }) =>
    collect(query.get('server'), (s) => api.searchCompose(s, str(query.get('name'), 100), { timeout: cfg.requestTimeoutMs })));

  route('POST', '/api/composes/create', WRITE, (ctx) => {
    const name = str(ctx.body.name, 60);
    const file = typeof ctx.body.file === 'string' ? ctx.body.file : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new HttpError(400, '编排名称只能包含小写字母、数字、_ -');
    if (!file.trim()) throw new HttpError(400, 'Compose 内容不能为空');
    const payload = { name, file, env: typeof ctx.body.env === 'string' ? ctx.body.env : '', forcePull: !!ctx.body.forcePull };
    const job = startJob(
      ctx,
      { type: 'compose', title: `部署 Compose ${name}`, concurrency: cfg.concurrency },
      targetsOf(ctx.body.serverIds),
      async (t) => {
        await api.createCompose(panelOf(t.serverId), payload);
        return '已提交部署，拉取镜像与启动由面板在后台完成';
      },
    );
    return settled(job);
  });

  route('POST', '/api/composes/operate', WRITE, (ctx) => {
    const { serverId, operation } = ctx.body;
    const name = str(ctx.body.name, 100);
    const p = str(ctx.body.path, 500);
    if (!COMPOSE_OPS.includes(operation)) throw new HttpError(400, '不支持的操作');
    if (!name) throw new HttpError(400, '缺少编排名称');
    const job = startJob(
      ctx,
      { type: 'compose', title: `Compose ${operation} ${name}`, concurrency: 1 },
      targetsOf([serverId]),
      async (t) => {
        await api.operateCompose(panelOf(t.serverId), { name, path: p, operation });
        return `${operation} 完成`;
      },
    );
    return settled(job);
  });

  // ---- 任务与审计 ----
  route('GET', '/api/jobs', READ, () => jobs.list());
  route('GET', '/api/jobs/:id', READ, ({ params }) => {
    const job = jobs.get(params.id);
    if (!job) throw new HttpError(404, '任务不存在');
    return jobs.view(job);
  });
  route('GET', '/api/audit', READ, () => store.listAudit());

  // ---------- http ----------
  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || '';
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_JSON) {
          reject(new HttpError(413, '请求体过大'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('error', reject);
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new HttpError(400, '请求体不是合法 JSON'));
        }
      });
    });
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        const hit = STATIC[url.pathname];
        if (!hit || !['GET', 'HEAD'].includes(req.method)) throw new HttpError(404, 'Not Found');
        res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC, hit[0])));
      }
      let match;
      const r = routes.find((x) => x.method === req.method && (match = url.pathname.match(x.re)));
      if (!r) throw new HttpError(404, '接口不存在');
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      } catch {
        throw new HttpError(400, '路径参数无效');
      }

      let user = '';
      if (!r.opts.public) {
        const s = auth.session(req);
        if (!s) throw new HttpError(401, '未登录或登录已过期');
        user = s.user;
      }
      if (req.method !== 'GET') {
        // 自定义请求头无法由跨站表单发出，配合 SameSite=Strict 防 CSRF
        if (req.headers['x-requested-with'] !== 'opf') throw new HttpError(403, '请求被拒绝');
        if (r.opts.write && cfg.readOnly) throw new HttpError(403, '当前为只读模式（READ_ONLY），不能执行变更操作');
      }
      const body = req.method === 'GET' ? {} : await readJson(req);
      const data = await r.fn({ req, res, params, query: url.searchParams, body, user, ip: clientIp(req) });
      send(res, 200, { data: data ?? null });
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof PanelError) return send(res, 502, { error: e.message });
      log('[error]', e);
      send(res, 500, { error: '服务器内部错误' });
    }
  }

  const server = http.createServer(handle);
  return {
    server, poller, store, jobs,
    listen(port = cfg.port, host) {
      return new Promise((resolve) => server.listen(port, host, () => {
        poller.start();
        resolve(server.address().port);
      }));
    },
    close() {
      poller.stop();
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
