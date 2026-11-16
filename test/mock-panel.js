// 模拟 1Panel v2 的最小实现，只用于测试：校验鉴权头、请求体必填字段，维护内存状态。
import http from 'node:http';
import crypto from 'node:crypto';

export function createMockPanel({ apiKey, version = 'v2.0.5', newVersion = 'v2.0.6', upgradeDelayMs = 150 } = {}) {
  const state = {
    version,
    newVersion,
    calls: [],
    containers: [
      { name: 'nginx', imageName: 'nginx:1.27', state: 'running', ports: ['0.0.0.0:80->80/tcp'], runTime: 'Up 3 days', isFromApp: false, isFromCompose: false },
      { name: 'redis', imageName: 'redis:7', state: 'exited', ports: [], runTime: 'Exited', isFromApp: true, appName: 'redis', isFromCompose: false },
    ],
    composes: [],
  };

  const ok = (res, data = null) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, message: '', data }));
  };
  const fail = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: status, message }));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const ts = req.headers['1panel-timestamp'];
      const expect = crypto.createHash('md5').update(`1panel${apiKey}${ts}`).digest('hex');
      if (req.headers['1panel-token'] !== expect) return fail(res, 401, 'ErrApiConfigKeyInvalid');
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 120) return fail(res, 401, 'ErrApiConfigKeyTimeInvalid');

      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const key = `${req.method} ${req.url.replace('/api/v2', '')}`;
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
            else c.state = { start: 'running', restart: 'running', stop: 'exited', kill: 'exited', pause: 'paused', unpause: 'running' }[body.operation];
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
