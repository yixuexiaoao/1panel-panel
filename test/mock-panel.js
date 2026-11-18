// 模拟 1Panel v2 的最小实现，只用于测试：校验鉴权头、请求体必填字段，维护内存状态。
import http from 'node:http';
import crypto from 'node:crypto';
import { posix } from 'node:path';

// 与上游 core/i18n/lang/{zh,en}.yaml 一致的鉴权失败文案（detail 为空时去掉 ": <no value>"）
const AUTH_MSG = {
  zh: {
    ErrApiConfigStatusInvalid: 'API 接口禁止访问',
    ErrApiConfigKeyTimeInvalid: 'API 接口时间戳错误',
    ErrApiConfigKeyInvalid: 'API 接口密钥错误',
    ErrApiConfigIPInvalid: '调用 API 接口 IP 不在白名单',
  },
  en: {
    ErrApiConfigStatusInvalid: 'API access disabled',
    ErrApiConfigKeyTimeInvalid: 'Invalid API timestamp',
    ErrApiConfigKeyInvalid: 'Invalid API key',
    ErrApiConfigIPInvalid: 'The API request IP is not on the whitelist',
  },
};

/**
 * state.auth 可在测试中修改：enabled（API 开关）、ipAllowed（白名单）、clockOffsetSec（面板时钟偏移）、
 * html（模拟地址指向了网页 / 反向代理登录页）。
 */
export function createMockPanel({ apiKey, version = 'v2.0.5', newVersion = 'v2.0.6', upgradeDelayMs = 150 } = {}) {
  const state = {
    version,
    newVersion,
    auth: { enabled: true, ipAllowed: true, clockOffsetSec: 0, html: false },
    calls: [],
    containers: [
      { name: 'nginx', imageName: 'nginx:1.27', state: 'running', ports: ['0.0.0.0:80->80/tcp'], runTime: 'Up 3 days', isFromApp: false, isFromCompose: false },
      { name: 'redis', imageName: 'redis:7', state: 'exited', ports: [], runTime: 'Exited', isFromApp: true, appName: 'redis', isFromCompose: false },
    ],
    composes: [],
    files: [],
    favorites: [],
    fileTasks: [],
    cronjobs: [],
    command: { statuses: ['Waiting', 'Running', 'Success'] },
  };

  const ok = (res, data = null) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, message: '', data }));
  };
  const fail = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: status, message }));
  };

  function submitFileTask(res, body, run) {
    if (!body.taskID) return fail(res, 400, 'taskID required');
    const task = { id: body.taskID, status: 'Executing' };
    state.fileTasks.push(task);
    setTimeout(() => { task.status = run() ? 'Success' : 'Failed'; }, 25).unref();
    return ok(res);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const a = state.auth;
      const now = Date.now() + a.clockOffsetSec * 1000;
      res.setHeader('Date', new Date(now).toUTCString());
      if (a.html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><body>login</body></html>');
      }
      // 与上游相同：HTTP 200 + code 401；检查顺序为 开关 → 时间戳 → 密钥 → IP
      const lang = String(req.headers['accept-language'] || '').startsWith('zh') ? 'zh' : 'en';
      const denied = (k) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 401, message: AUTH_MSG[lang][k] }));
      };
      const ts = req.headers['1panel-timestamp'];
      const expect = crypto.createHash('md5').update(`1panel${apiKey}${ts}`).digest('hex');
      if (!a.enabled) return denied('ErrApiConfigStatusInvalid');
      if (Math.abs(now / 1000 - Number(ts)) > 120) return denied('ErrApiConfigKeyTimeInvalid');
      if (req.headers['1panel-token'] !== expect) return denied('ErrApiConfigKeyInvalid');
      if (!a.ipAllowed) return denied('ErrApiConfigIPInvalid');

      const url = new URL(req.url, 'http://mock');
      const key = `${req.method} ${url.pathname.replace('/api/v2', '')}`;
      let body = {};
      try {
        if (key === 'POST /files/upload') {
          const data = new Request('http://mock', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) });
          const parts = await data.formData();
          const file = parts.get('file');
          if (!file || typeof file === 'string') return fail(res, 400, 'file required');
          body = { path: parts.get('path'), filename: file.name, overwrite: parts.get('overwrite'), content: Buffer.from(await file.arrayBuffer()) };
        } else if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return fail(res, 400, '请求体无效');
      }
      state.calls.push({ key, body });

      switch (key) {
        case 'GET /dashboard/base/all/all':
          return ok(res, {
            hostname: 'mock-host', prettyDistro: 'Debian GNU/Linux 12', kernelArch: 'x86_64', kernelVersion: '6.1.0',
            cpuCores: 2, cpuLogicalCores: 4, websiteNumber: 3, databaseNumber: 1, appInstalledNumber: 2, cronjobNumber: 0,
            currentInfo: {
              uptime: 90000, cpuUsedPercent: 12.5, memoryUsed: 2 * 2 ** 30, memoryTotal: 8 * 2 ** 30, memoryUsedPercent: 25,
              load1: 0.1, load5: 0.2, load15: 0.3,
              diskData: [{ path: '/', total: 100 * 2 ** 30, used: 40 * 2 ** 30, usedPercent: 40 }],
            },
          });
        case 'POST /core/settings/search':
          return ok(res, { systemVersion: state.version, edition: 'oss' });
        case 'GET /containers/status':
          return ok(res, {
            running: state.containers.filter((c) => c.state === 'running').length,
            exited: state.containers.filter((c) => c.state === 'exited').length,
            containerCount: state.containers.length,
          });
        case 'GET /core/settings/upgrade':
          return ok(res, state.version === state.newVersion ? { newVersion: '', latestVersion: '' } : { newVersion: state.newVersion, latestVersion: state.newVersion });
        case 'POST /core/settings/upgrade':
          if (!body.version) return fail(res, 400, 'version required');
          setTimeout(() => (state.version = body.version), upgradeDelayMs).unref();
          return ok(res);
        case 'POST /containers/search': {
          for (const k of ['page', 'pageSize', 'state', 'orderBy', 'order']) if (!body[k]) return fail(res, 400, `${k} required`);
          const items = state.containers.filter((c) => c.name.includes(body.name || '') && (body.state === 'all' || c.state === body.state));
          return ok(res, { total: items.length, items });
        }
        case 'POST /containers/operate': {
          if (!Array.isArray(body.names) || !body.operation) return fail(res, 400, 'names/operation required');
          for (const name of body.names) {
            const c = state.containers.find((x) => x.name === name);
            if (!c) return fail(res, 500, `container ${name} not found`);
            if (body.operation === 'remove') state.containers = state.containers.filter((x) => x !== c);
            else {
              c.state = { start: 'running', restart: 'running', stop: 'exited', kill: 'exited', pause: 'paused', unpause: 'running' }[body.operation];
              c.runTime = { running: 'Up 1 second', exited: 'Exited', paused: 'Paused' }[c.state];
            }
          }
          return ok(res);
        }
        case 'POST /containers/upgrade': {
          if (!Array.isArray(body.names) || !body.image) return fail(res, 400, 'names/image required');
          for (const name of body.names) state.containers.find((x) => x.name === name).imageName = body.image;
          return ok(res);
        }
        case 'POST /containers':
          if (!body.name || !body.image) return fail(res, 400, 'name/image required');
          if (state.containers.some((c) => c.name === body.name)) return fail(res, 500, '容器名称已存在');
          state.containers.push({ name: body.name, imageName: body.image, state: 'running', ports: body.exposedPorts.map((p) => `${p.hostPort}->${p.containerPort}/${p.protocol}`), runTime: 'Up 1 second' });
          return ok(res);
        case 'POST /containers/image/pull':
          if (!Array.isArray(body.imageName) || !body.imageName.length) return fail(res, 400, 'imageName required');
          return ok(res);
        case 'POST /containers/compose/search':
          if (!body.page || !body.pageSize) return fail(res, 400, 'page required');
          return ok(res, { total: state.composes.length, items: state.composes });
        case 'POST /containers/compose':
          if (!['edit', 'path', 'template'].includes(body.from)) return fail(res, 400, 'from invalid');
          state.composes.push({ name: body.name, path: `/opt/1panel/docker/compose/${body.name}/docker-compose.yml`, containerCount: 1, runningCount: 1, createdAt: '2026-01-01 00:00:00', createdBy: '1Panel' });
          return ok(res);
        case 'POST /containers/compose/operate':
          if (!body.name || !body.operation) return fail(res, 400, 'name/operation required');
          return ok(res);
        case 'POST /files/search': {
          const parent = body.path === '/' ? '/' : `${body.path}/`;
          const items = state.files.filter((entry) => entry.path.startsWith(parent) &&
            !entry.path.slice(parent.length).includes('/') && entry.name.toLowerCase().includes(body.search.toLowerCase()) &&
            (body.showHidden || !entry.name.startsWith('.')));
          const start = (body.page - 1) * body.pageSize;
          return ok(res, { path: body.path, itemTotal: items.length, items: items.slice(start, start + body.pageSize) });
        }
        case 'POST /files/upload': {
          const dest = posix.join(body.path || '/', body.filename);
          if (body.overwrite !== 'false' || state.files.some((item) => item.path === dest)) return fail(res, 409, '文件已存在');
          state.files.push({ path: dest, name: body.filename, isDir: false, isSymlink: false, size: body.content.length, content: body.content });
          return ok(res);
        }
        case 'GET /files/download': {
          const entry = state.files.find((item) => !item.isDir && item.path === url.searchParams.get('path'));
          if (!entry) return fail(res, 404, '文件不存在');
          const bytes = Buffer.from(entry.content ?? '');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="sample"', 'Content-Length': bytes.length });
          return res.end(bytes);
        }
        case 'POST /files/favorite/search': {
          const start = (body.page - 1) * body.pageSize;
          return ok(res, { total: state.favorites.length, items: state.favorites.slice(start, start + body.pageSize) });
        }
        case 'POST /files/favorite': {
          const entry = body.path === '/' ? { name: '/', path: '/', isDir: true } : state.files.find((item) => item.path === body.path);
          if (!entry || state.favorites.some((item) => item.path === body.path)) return fail(res, 409, '收藏已存在或路径不存在');
          const favorite = { id: state.calls.length, name: entry.name, path: entry.path, isDir: entry.isDir };
          state.favorites.push(favorite);
          return ok(res, favorite);
        }
        case 'POST /files/favorite/del':
          state.favorites = state.favorites.filter((item) => item.id !== body.id);
          return ok(res);
        case 'POST /files/mode':
        case 'POST /files/owner': {
          const entry = state.files.find((item) => item.path === body.path);
          if (!entry || body.sub) return fail(res, 400, '路径无效或递归修改');
          if (key === 'POST /files/mode') entry.mode = body.mode.toString(8);
          else Object.assign(entry, { user: body.user, group: body.group });
          return ok(res);
        }
        case 'POST /files/move':
          return submitFileTask(res, body, () => {
            const source = state.files.find((item) => item.path === body.oldPaths[0]);
            if (!source || body.cover) return false;
            const dest = posix.join(body.newPath, source.name);
            if (state.files.some((item) => item.path === dest)) return false;
            if (body.type === 'cut') source.path = dest;
            else state.files.push({ ...source, path: dest });
            return true;
          });
        case 'POST /files/compress':
          return submitFileTask(res, body, () => {
            if (body.replace || !state.files.some((item) => item.path === body.files[0])) return false;
            state.files.push({ name: body.name, path: posix.join(body.dst, body.name), isDir: false, isSymlink: false, content: '模拟归档' });
            return true;
          });
        case 'POST /files/decompress':
          return submitFileTask(res, body, () => {
            if (!state.files.some((item) => item.path === body.path)) return false;
            state.files.push({ name: '展开.txt', path: posix.join(body.dst, '展开.txt'), isDir: false, isSymlink: false, content: '模拟解压' });
            return true;
          });
        case 'POST /logs/tasks/search': {
          const items = state.fileTasks.filter((item) => item.id === body.taskID);
          return ok(res, { total: items.length, items });
        }
        case 'POST /files':
          if (!body.path || state.files.some((entry) => entry.path === body.path)) return fail(res, 400, '路径无效或已存在');
          state.files.push({ path: body.path, name: posix.basename(body.path), isDir: body.isDir, isSymlink: false, content: body.content });
          return ok(res);
        case 'POST /files/content':
        case 'POST /files/save': {
          const entry = state.files.find((item) => item.path === body.path && !item.isDir);
          if (!entry) return fail(res, 404, '文件不存在');
          if (key === 'POST /files/content') return ok(res, { content: String(entry.content ?? ''), size: Buffer.byteLength(entry.content ?? '') });
          if (typeof body.content !== 'string') return fail(res, 400, '缺少文件内容');
          entry.content = body.content;
          return ok(res);
        }
        case 'POST /files/rename': {
          const entry = state.files.find((item) => item.path === body.oldName);
          if (!entry || state.files.some((item) => item.path === body.newName)) return fail(res, 400, '路径无效');
          Object.assign(entry, { path: body.newName, name: posix.basename(body.newName) });
          return ok(res);
        }
        case 'POST /files/del': {
          const index = state.files.findIndex((entry) => entry.path === body.path && entry.isDir === body.isDir);
          if (index < 0) return fail(res, 404, '文件不存在');
          state.files.splice(index, 1);
          return ok(res);
        }
        case 'POST /cronjobs': {
          if (!body.spec || !body.name || !body.script || !body.timeout) return fail(res, 400, '任务字段缺失');
          state.cronjobs.push({ id: state.calls.length, name: body.name, status: 'Enable', spec: body.spec, type: body.type, script: body.script });
          if (state.command.dropCreateResponse) return res.destroy();
          return ok(res);
        }
        case 'POST /cronjobs/search':
          return ok(res, { items: state.cronjobs.filter((job) => job.name.includes(body.info)) });
        case 'POST /cronjobs/status': {
          const job = state.cronjobs.find((item) => item.id === body.id);
          if (!job) return fail(res, 404, '任务不存在');
          job.status = body.status;
          return ok(res);
        }
        case 'POST /cronjobs/handle': {
          const job = state.cronjobs.find((item) => item.id === body.id);
          if (!job || (job.name.startsWith('fleet-cmd-') && job.status !== 'Disable')) return fail(res, 400, '临时任务须先停用');
          job.runs = (job.runs ?? 0) + 1;
          job.statusIndex = 0;
          if (state.command.dropHandleResponse) return res.destroy();
          return ok(res);
        }
        case 'POST /cronjobs/search/records': {
          const job = state.cronjobs.find((item) => item.id === body.cronjobID);
          if (!job?.runs) return ok(res, { items: [] });
          if (state.command.dropRecordResponseAt === job.statusIndex) {
            delete state.command.dropRecordResponseAt;
            return res.destroy();
          }
          if (state.command.failRecordAt === job.statusIndex) return fail(res, 403, '无权读取记录');
          const status = state.command.statuses[Math.min(job.statusIndex++, state.command.statuses.length - 1)];
          return ok(res, { items: [{ id: job.id, status, message: status === 'Failed' ? '模拟失败' : '' }] });
        }
        case 'POST /cronjobs/records/log':
          return state.command.failLog ? fail(res, 500, '模拟读取日志失败') : ok(res, '模拟输出');
        case 'POST /cronjobs/stop':
          return ok(res);
        case 'POST /cronjobs/del':
          if (state.command.failDelete) return fail(res, 500, '模拟删除失败');
          state.cronjobs = state.cronjobs.filter((job) => !body.ids.includes(job.id));
          if (state.command.dropDeleteResponse) return res.destroy();
          return ok(res);
        default:
          return fail(res, 404, 'not found');
      }
    });
  });

  return {
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
