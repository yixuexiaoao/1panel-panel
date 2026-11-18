import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createPoller } from './poller.js';
import { createJobs } from './jobs.js';
import { api, PanelError } from './panel.js';
import { downloadFile, MAX_UPLOAD_BYTES, uploadFile } from './file-transfer.js';
import { fileActions } from './file-actions.js';
import { createRunner, TEMP_PREFIX } from './runner.js';
import { BUILTIN_TEMPLATES, renderScript, parseTemplate, clampTimeout, MAX_SCRIPT } from './templates.js';
import { HttpError, mapLimit, sleep, str } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/server-tools.js': ['server-tools.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CONTAINER_OPS = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'remove'];
const COMPOSE_OPS = ['up', 'start', 'restart', 'stop', 'down'];
const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'];
const MAX_JSON = 1024 * 1024;

const lines = (v) => String(v || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** 面板上的绝对路径 */
function absPath(v) {
  const p = typeof v === 'string' ? v : '';
  if (!p.startsWith('/') || p.length > 4096 || p.includes('\0')) throw new HttpError(400, '路径必须是以 / 开头的绝对路径');
  return p;
}

function filePath(value) {
  const p = absPath(value);
  if (p !== '/' && p.slice(1).split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new HttpError(400, '请提供规范的绝对路径');
  }
  return p;
}
const posInt = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'ID 无效');
  return n;
};
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
  const runCommand = createRunner(cfg);

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
    const names = targets.map((t) => t.name).join('、');
    store.audit({ user: ctx.user, ip: ctx.ip, action: meta.title, detail: meta.detail ? `${names}；${meta.detail}` : names });
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
  const STREAM_WRITE = { write: true, streamBody: true };

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

  // ---- 单台服务器：文件 ----
  /** 单台的变更操作：直接执行并记审计日志 */
  async function auditDo(ctx, action, detail, fn) {
    const server = mustServer(ctx.params.id);
    await fn(store.resolve(server));
    store.audit({ user: ctx.user, ip: ctx.ip, action, detail: `${server.name}：${detail}` });
  }
  const q = { timeout: 30_000 };
  const uploading = new Set();

  async function findFile(s, parent, name) {
    const target = path.posix.join(parent, name);
    const pageSize = 500;
    for (let page = 1; ; page++) {
      const info = await api.listFiles(s, parent, { search: name, page, pageSize }, q);
      const entry = info?.items?.find((item) => item.name === name && item.path === target);
      if (entry || !info?.items?.length || page * pageSize >= (info.itemTotal ?? 0)) return entry;
    }
  }

  async function verifyFilePath(s, target, isDir) {
    if (target === '/' && isDir === true) return { isDir: true };
    if (target === '/') throw new HttpError(409, '不能操作根目录');
    const parts = target.slice(1).split('/');
    let parent = '/';
    let entry;
    for (const [index, name] of parts.entries()) {
      entry = await findFile(s, parent, name);
      const expected = index < parts.length - 1 ? true : isDir;
      if (!entry || entry.isSymlink !== false || (expected !== undefined && entry.isDir !== expected)) {
        throw new HttpError(409, '无法确认路径或文件类型，路径不得包含符号链接');
      }
      parent = path.posix.join(parent, name);
    }
    return entry;
  }

  function startFileJob(ctx, title, detail, submit) {
    const job = startJob(ctx, { type: 'file', title, detail, concurrency: 1 }, targetsOf([ctx.params.id]), async (target, report) => {
      const s = panelOf(target.serverId);
      let id;
      try {
        id = (await submit(s)).taskID;
      } catch (e) {
        if (!e.taskID || !e.network) throw e;
        id = e.taskID;
      }
      report('面板处理中…');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const r = await fileActions.task(s, id).catch((e) => {
          if (!(e instanceof PanelError && (e.network || e.status >= 500 || e.code >= 500))) throw e;
          return null;
        });
        const item = r?.items?.find((entry) => entry.id === id);
        const status = String(item?.status || '').toLowerCase();
        if (status === 'success') return '面板任务已完成';
        if (['failed', 'canceled', 'cancelled'].includes(status)) {
          const detail = item.errorMsg ? `：${String(item.errorMsg).slice(0, 400)}` : '';
          throw new Error(`面板任务${status === 'failed' ? '失败' : '已取消'}${detail}（${id}）`);
        }
        await sleep(cfg.commandPollMs ?? 2000);
      }
      throw new Error(`等待面板结果超时，请在原面板核对后再操作（${id}）`);
    });
    return jobs.view(job);
  }

  route('GET', '/api/servers/:id/files', READ, async ({ params, query }) => {
    const p = absPath(query.get('path') || '/');
    const page = Number(query.get('page') ?? 1);
    const pageSize = 100;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * pageSize)) throw new HttpError(400, '页码无效');
    const search = str(query.get('q'), 255);
    const showHidden = query.get('showHidden') !== 'false';
    const info = await api.listFiles(panelOf(params.id), p, { page, pageSize, search, showHidden }, q);
    return {
      path: info?.path || p,
      page, pageSize, uploadMaxBytes: MAX_UPLOAD_BYTES,
      total: info?.itemTotal ?? (info?.items || []).length,
      items: (info?.items || []).map((f) => ({
        name: f.name, path: f.path, isDir: !!f.isDir, isSymlink: !!f.isSymlink, linkPath: f.linkPath || '',
        size: f.size || 0, mode: f.mode || '', user: f.user || '', group: f.group || '', modTime: f.modTime || '',
      })),
    };
  });

  route('POST', '/api/servers/:id/files/upload', STREAM_WRITE, (ctx) => {
    const directory = filePath(ctx.query.get('path'));
    const filename = ctx.query.get('name');
    if (!filename || !filename.trim() || filename === '.' || filename === '..' || /[\/\\\u0000-\u001f\u007f]/u.test(filename) || Buffer.byteLength(filename) > 255) {
      throw new HttpError(400, '文件名无效');
    }
    const target = filePath(path.posix.join(directory, filename));
    const length = ctx.req.headers['content-length'];
    if (length === undefined) throw new HttpError(411, '上传需要 Content-Length');
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '文件长度无效');
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, `单个文件最多 ${MAX_UPLOAD_BYTES / 1024 ** 2} MiB`);
    const key = `${ctx.params.id}\0${target}`;
    return auditDo(ctx, '上传文件', target, async (s) => {
      if (uploading.has(key)) throw new HttpError(409, '同名文件正在上传');
      uploading.add(key);
      const abort = new AbortController();
      const disconnect = () => abort.abort();
      ctx.res.once('close', disconnect);
      try {
        await verifyFilePath(s, directory, true);
        if (await findFile(s, directory, filename)) throw new HttpError(409, '当前目录已有同名文件');
        await uploadFile(s, { directory, filename, body: ctx.req, size, signal: abort.signal });
      } finally {
        ctx.res.off('close', disconnect);
        uploading.delete(key);
      }
    });
  });

  route('GET', '/api/servers/:id/files/download', READ, async ({ params, query, res }) => {
    const p = filePath(query.get('path'));
    if (p === '/') throw new HttpError(400, '请选择单个文件下载');
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.once('close', disconnect);
    try {
      const stream = await downloadFile(panelOf(params.id), p, { signal: abort.signal });
      const filename = encodeURIComponent(path.posix.basename(p)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
        'Cache-Control': 'no-store',
      };
      if (/^\d+$/.test(stream.headers['content-length'] || '')) headers['Content-Length'] = stream.headers['content-length'];
      res.writeHead(200, headers);
      await pipeline(stream, res);
    } finally {
      res.off('close', disconnect);
    }
  });

  route('GET', '/api/servers/:id/files/favorites', READ, async ({ params }) => {
    const s = panelOf(params.id);
    const items = [];
    for (let page = 1; ; page++) {
      const r = await fileActions.listFavorites(s, page);
      const records = r?.items || [];
      items.push(...records.filter((item) => item.isDir).map(({ id, path, name }) => ({ id, path, name })));
      if (records.length < 100 || page * 100 >= Number(r?.total)) return items;
    }
  });

  route('POST', '/api/servers/:id/files/favorites', WRITE, (ctx) => {
    const p = filePath(ctx.body.path);
    return auditDo(ctx, '收藏目录', p, async (s) => {
      await verifyFilePath(s, p, true);
      await fileActions.addFavorite(s, p);
    });
  });

  route('DELETE', '/api/servers/:id/files/favorites/:fid', WRITE, (ctx) => {
    const id = posInt(ctx.params.fid);
    return auditDo(ctx, '移除目录收藏', `#${id}`, (s) => fileActions.removeFavorite(s, id));
  });

  route('POST', '/api/servers/:id/files/transfer', WRITE, (ctx) => {
    const source = filePath(ctx.body.path);
    const destination = filePath(ctx.body.destination);
    const operation = ctx.body.operation;
    if (!['copy', 'move'].includes(operation)) throw new HttpError(400, '请选择复制或移动');
    if (source === '/' || (operation === 'move' && path.posix.dirname(source) === '/')) throw new HttpError(400, '不能移动根目录或一级路径');
    if (destination === source || destination.startsWith(`${source}/`) || destination === path.posix.dirname(source)) {
      throw new HttpError(400, '请选择其他目标目录');
    }
    return startFileJob(ctx, operation === 'move' ? '移动文件' : '复制文件', `${source} → ${destination}`, async (s) => {
      await verifyFilePath(s, source);
      await verifyFilePath(s, destination, true);
      if (await findFile(s, destination, path.posix.basename(source))) throw new HttpError(409, '目标目录已有同名条目');
      return fileActions.move(s, { operation: operation === 'move' ? 'cut' : 'copy', sources: [source], destination });
    });
  });

  route('POST', '/api/servers/:id/files/mode', WRITE, (ctx) => {
    const p = filePath(ctx.body.path);
    const mode = ctx.body.mode;
    if (path.posix.dirname(p) === '/') throw new HttpError(400, '不能修改根目录或一级路径权限');
    if (typeof mode !== 'string' || !/^[0-7]{3,4}$/u.test(mode)) throw new HttpError(400, '权限须为三位或四位八进制数字');
    return auditDo(ctx, '修改文件权限', `${p}（${mode}）`, async (s) => {
      await verifyFilePath(s, p);
      await fileActions.changeMode(s, p, mode);
    });
  });

  route('POST', '/api/servers/:id/files/owner', WRITE, (ctx) => {
    const p = filePath(ctx.body.path);
    const { user, group } = ctx.body;
    const identity = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,98}\$?$/u;
    if (path.posix.dirname(p) === '/') throw new HttpError(400, '不能修改根目录或一级路径属主');
    if (typeof user !== 'string' || typeof group !== 'string' || !identity.test(user) || !identity.test(group)) throw new HttpError(400, '用户或用户组无效');
    return auditDo(ctx, '修改文件属主', p, async (s) => {
      await verifyFilePath(s, p);
      await fileActions.changeOwner(s, p, user, group);
    });
  });

  route('POST', '/api/servers/:id/files/compress', WRITE, (ctx) => {
    const source = filePath(ctx.body.path);
    const destination = filePath(ctx.body.destination);
    const { name, format } = ctx.body;
    if (!['zip', 'tar.gz'].includes(format) || typeof name !== 'string' || !name.endsWith(`.${format}`) ||
      name.length <= format.length + 1 || /[\/\\\u0000-\u001f\u007f]/u.test(name) || Buffer.byteLength(name) > 255) {
      throw new HttpError(400, '请输入带对应格式后缀的归档名称');
    }
    const output = filePath(path.posix.join(destination, name));
    if (source === '/' || output === source || output.startsWith(`${source}/`)) throw new HttpError(400, '归档不能保存到源目录内部');
    return startFileJob(ctx, '压缩文件', `${source} → ${output}`, async (s) => {
      await verifyFilePath(s, source);
      await verifyFilePath(s, destination, true);
      if (await findFile(s, destination, name)) throw new HttpError(409, '已存在同名归档');
      return fileActions.compress(s, { sources: [source], destination, name, type: format });
    });
  });

  route('POST', '/api/servers/:id/files/decompress', WRITE, (ctx) => {
    const source = filePath(ctx.body.path);
    const destination = filePath(ctx.body.destination);
    const { format } = ctx.body;
    if (!['zip', 'tar.gz', 'tar', '7z', 'rar', 'tar.bz2'].includes(format)) throw new HttpError(400, '请选择支持的解压格式');
    if (destination === '/') throw new HttpError(400, '请选择新的或空的目标目录');
    return startFileJob(ctx, '解压文件', `${source} → ${destination}`, async (s) => {
      await verifyFilePath(s, source, false);
      const parent = path.posix.dirname(destination);
      await verifyFilePath(s, parent, true);
      if (!await findFile(s, parent, path.posix.basename(destination))) await api.createFile(s, { path: destination, isDir: true });
      await verifyFilePath(s, destination, true);
      const r = await api.listFiles(s, destination, { page: 1, pageSize: 1 }, q);
      if (r?.items?.length || r?.itemTotal > 0) throw new HttpError(409, '目标目录必须为空');
      return fileActions.decompress(s, { source, destination, type: format });
    });
  });

  route('GET', '/api/servers/:id/files/content', READ, async ({ params, query }) => {
    const p = absPath(query.get('path'));
    const info = await api.fileContent(panelOf(params.id), p, q);
    return { path: p, content: info?.content ?? '', size: info?.size ?? 0 };
  });

  route('POST', '/api/servers/:id/files/save', WRITE, (ctx) => {
    const p = absPath(ctx.body.path);
    if (typeof ctx.body.content !== 'string') throw new HttpError(400, '缺少文件内容');
    return auditDo(ctx, '保存文件', p, (s) => api.saveFile(s, p, ctx.body.content));
  });

  route('POST', '/api/servers/:id/files/create', WRITE, (ctx) => {
    const p = absPath(ctx.body.path);
    const isDir = !!ctx.body.isDir;
    return auditDo(ctx, isDir ? '新建目录' : '新建文件', p, (s) => api.createFile(s, { path: p, isDir }));
  });

  route('POST', '/api/servers/:id/files/delete', WRITE, (ctx) => {
    const p = filePath(ctx.body.path);
    const parts = p.slice(1).split('/');
    if (parts.length < 2) throw new HttpError(400, '为避免误删，不允许删除根目录或一级目录');
    const isDir = ctx.body.isDir ?? false;
    if (typeof isDir !== 'boolean') throw new HttpError(400, '文件类型无效');
    return auditDo(ctx, '删除文件', p, async (s) => {
      await verifyFilePath(s, p, isDir);
      await api.deleteFile(s, p, isDir);
    });
  });

  route('POST', '/api/servers/:id/files/rename', WRITE, (ctx) => {
    const from = absPath(ctx.body.oldName);
    const to = absPath(ctx.body.newName);
    return auditDo(ctx, '重命名文件', `${from} → ${to}`, (s) => api.renameFile(s, from, to));
  });

  // ---- 单台服务器：定时任务 ----
  route('GET', '/api/servers/:id/cronjobs', READ, async ({ params }) => {
    const r = await api.searchCronjobs(panelOf(params.id), '', q);
    // 只返回展示需要的字段；不外传 secret 等敏感配置
    return (r?.items || []).map((j) => ({
      id: j.id, name: j.name, type: j.type, spec: j.spec, status: j.status,
      lastRecordStatus: j.lastRecordStatus || '', lastRecordTime: j.lastRecordTime || '',
      script: j.type === 'shell' ? String(j.script || '').slice(0, 4000) : '',
      temp: String(j.name || '').startsWith(TEMP_PREFIX),
    }));
  });

  route('GET', '/api/servers/:id/cronjobs/:cid/records', READ, async ({ params }) => {
    const r = await api.searchRecords(panelOf(params.id), posInt(params.cid), { pageSize: 20 }, q);
    return (r?.items || []).map((x) => ({ id: x.id, startTime: x.startTime, status: x.status, message: x.message || '', interval: x.interval || 0 }));
  });

  route('GET', '/api/servers/:id/records/:rid/log', READ, async ({ params }) =>
    String((await api.recordLog(panelOf(params.id), posInt(params.rid), q)) || ''));

  route('POST', '/api/servers/:id/cronjobs/:cid/run', WRITE, (ctx) =>
    auditDo(ctx, '手动执行定时任务', `#${ctx.params.cid}`, (s) => api.handleCronjob(s, posInt(ctx.params.cid))));

  route('POST', '/api/servers/:id/cronjobs/:cid/status', WRITE, (ctx) => {
    const status = ctx.body.enable ? 'Enable' : 'Disable';
    return auditDo(ctx, ctx.body.enable ? '启用定时任务' : '停用定时任务', `#${ctx.params.cid}`, (s) => api.cronjobStatus(s, posInt(ctx.params.cid), status));
  });

  route('POST', '/api/servers/:id/cronjobs/:cid/delete', WRITE, (ctx) =>
    auditDo(ctx, '删除定时任务', `#${ctx.params.cid}`, (s) => api.deleteCronjobs(s, [posInt(ctx.params.cid)], !!ctx.body.cleanData)));

  // ---- 操作模板与批量命令 ----
  const findTemplate = (id) => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id) || store.getTemplate(id);
    if (!t) throw new HttpError(404, '操作模板不存在');
    return t;
  };

  route('GET', '/api/templates', READ, () => [
    ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })),
    ...store.listTemplates().map((t) => ({ ...t, builtin: false })),
  ]);

  route('POST', '/api/templates', WRITE, ({ body, user, ip }) => {
    const t = store.addTemplate(parseTemplate(body));
    store.audit({ user, ip, action: '新建操作模板', detail: t.id });
    return t;
  });

  route('PUT', '/api/templates/:id', WRITE, ({ params, body, user, ip }) => {
    if (!store.getTemplate(params.id)) throw new HttpError(404, '操作模板不存在（内置模板不能修改，可复制后再改）');
    const t = store.updateTemplate(params.id, parseTemplate(body));
    store.audit({ user, ip, action: '修改操作模板', detail: t.id });
    return t;
  });

  route('DELETE', '/api/templates/:id', WRITE, ({ params, user, ip }) => {
    const t = store.getTemplate(params.id);
    if (!t) throw new HttpError(404, '操作模板不存在');
    store.removeTemplate(params.id);
    store.audit({ user, ip, action: '删除操作模板', detail: t.id });
  });

  route('POST', '/api/commands/run', WRITE, (ctx) => {
    const b = ctx.body;
    let script, templateId, timeoutSec;
    if (b.templateId) {
      const tpl = findTemplate(str(b.templateId, 100));
      script = renderScript(tpl, b.params && typeof b.params === 'object' ? b.params : {});
      templateId = tpl.id;
      timeoutSec = clampTimeout(b.timeoutSec, tpl.timeoutSec || 600);
    } else {
      script = typeof b.script === 'string' ? b.script.replace(/\r\n/g, '\n') : '';
      if (!script.trim()) throw new HttpError(400, '命令不能为空');
      timeoutSec = clampTimeout(b.timeoutSec);
    }
    if (Buffer.byteLength(script) > MAX_SCRIPT) throw new HttpError(400, '命令过长（上限 64KB）');
    const job = startJob(
      ctx,
      { type: 'command', title: '执行命令', concurrency: cfg.concurrency, detail: templateId ? `模板 ${templateId}` : '' },
      targetsOf(b.serverIds),
      async (t, report) => {
        const r = await runCommand(panelOf(t.serverId), script, { timeoutSec, report });
        return { message: '执行成功', output: r.output };
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
      const body = req.method === 'GET' || r.opts.streamBody ? {} : await readJson(req);
      const data = await r.fn({ req, res, params, query: url.searchParams, body, user, ip: clientIp(req) });
      if (!res.headersSent && !res.destroyed) send(res, 200, { data: data ?? null });
    } catch (e) {
      if (res.destroyed) return;
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
