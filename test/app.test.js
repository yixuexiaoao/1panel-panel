import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp, buildContainerSpec } from '../server/app.js';
import { sign, request, diagnoseAuth, clockSkew, describeNonJson } from '../server/panel.js';
import { createStore } from '../server/store.js';
import { createMockPanel } from './mock-panel.js';

const API_KEY = 'test-api-key-not-real';
const PASSWORD = 'test-password';
let dataDir, app, base, panel, panelUrl, cookie;

function makeApp(extra = {}) {
  const cfg = { ...loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, POLL_INTERVAL: '0' }), upgradePollMs: 50, upgradeTimeoutMs: 5000, ...extra };
  return createApp(cfg, () => {});
}

async function call(method, url, body, { auth = true, headers = {}, origin = base } = {}) {
  const res = await fetch(origin + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'opf', ...(auth ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), res };
}

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const { json } = await call('GET', `/api/jobs/${id}`);
    if (json.data.status !== 'running') return json.data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job timeout');
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opf-test-'));
  panel = createMockPanel({ apiKey: API_KEY });
  panelUrl = await panel.listen();
  app = makeApp();
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});

after(async () => {
  await app.close();
  await panel.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sign 与官方算法一致：md5("1panel"+key+timestamp)', () => {
  // 期望值由 printf '1panelabc1700000000' | md5sum 独立算出
  assert.equal(sign('abc', '1700000000'), '5e3f595789bd0e3d08669ea5e1f97219');
  assert.notEqual(sign('abc', '1700000000'), sign('abc', '1700000001'));
});

test('401 诊断：识别中 / 繁 / 英文案与键名，"API" 中的 "IP" 不会误判为白名单', () => {
  const cases = [
    ['Invalid API key', /API Key 不正确/],
    ['API 接口密钥错误', /API Key 不正确/],
    ['API 金鑰錯誤', /API Key 不正确/],
    ['ErrApiConfigKeyInvalid', /API Key 不正确/],
    ['API 接口时间戳错误', /时间戳无效/],
    ['Invalid API timestamp', /时间戳无效/],
    ['调用 API 接口 IP 不在白名单', /白名单内/],
    ['The API request IP is not on the whitelist', /白名单内/],
    ['API 接口禁止访问', /API Key 不正确，或面板未开启 API 接口/],
    ['API access disabled', /未开启 API 接口/],
    ['此接口禁止使用 API 接口调用', /不允许通过 API 调用/],
    ['API Key 已到期，请在面板的 API Key 管理中调整有效期或更换密钥。', /已过期/],
  ];
  for (const [msg, re] of cases) {
    const out = diagnoseAuth(msg);
    assert.match(out, re, msg);
    if (!/白名单/.test(msg) && !/whitelist/.test(msg)) assert.doesNotMatch(out, /白名单内/, msg);
  }
  // 未知文案：保留原文并给出排查清单
  assert.match(diagnoseAuth('ErrNotLogin'), /ErrNotLogin.*请确认面板已开启 API 接口/);
  // 识别成功时附带面板原文，便于排查
  assert.match(diagnoseAuth('API 接口禁止访问'), /（面板返回：API 接口禁止访问）$/);
  // 时间差：超过 60 秒才提示
  assert.match(diagnoseAuth('API 接口时间戳错误', 300), /本机时间比面板快约 300 秒/);
  assert.match(diagnoseAuth('API 接口时间戳错误', -90), /慢约 90 秒/);
  assert.doesNotMatch(diagnoseAuth('API 接口时间戳错误', 30), /约 \d+ 秒/);
  assert.equal(clockSkew('Thu, 01 Jan 2026 00:00:00 GMT', Date.parse('2026-01-01T00:05:00Z')), 300);
  assert.equal(clockSkew(undefined), null);
  assert.match(describeNonJson(401, 'text/html', ''), /安全入口路径/);
  assert.match(describeNonJson(200, '', '<!DOCTYPE html><html>'), /反向代理/);
  assert.match(describeNonJson(502, 'text/plain', 'bad gateway'), /非 JSON/);
});

test('401 诊断：对模拟面板逐项触发鉴权失败', async () => {
  const mock = createMockPanel({ apiKey: API_KEY });
  const url = await mock.listen();
  const fails = async (apiKey) => {
    try {
      await request({ url, apiKey }, 'POST', '/core/settings/search', {});
    } catch (e) {
      return e.message;
    }
    throw new Error('预期失败');
  };
  try {
    assert.match(await fails('wrong'), /API Key 不正确/);
    mock.state.auth.ipAllowed = false;
    assert.match(await fails(API_KEY), /出口 IP 不在面板的 API 白名单内/);
    mock.state.auth.enabled = false;
    assert.match(await fails(API_KEY), /未开启 API 接口/);
    Object.assign(mock.state.auth, { enabled: true, ipAllowed: true, clockOffsetSec: -600 });
    assert.match(await fails(API_KEY), /时间戳无效.*本机时间比面板快约 (59\d|60\d) 秒/);
    Object.assign(mock.state.auth, { clockOffsetSec: 0, html: true });
    assert.match(await fails(API_KEY), /返回了网页/);
    mock.state.auth.html = false;
    assert.equal((await request({ url, apiKey: API_KEY }, 'POST', '/core/settings/search', {})).systemVersion, 'v2.0.5');
  } finally {
    await mock.close();
  }
});

test('store 加解密往返，且密文不含明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opf-store-'));
  const store = createStore({ dataDir: dir, secretKey: '' });
  const enc = store.encrypt('s3cret-value');
  assert.ok(!enc.includes('s3cret-value'));
  assert.equal(store.decrypt(enc), 's3cret-value');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未登录访问受保护接口返回 401', async () => {
  const r = await call('GET', '/api/servers', undefined, { auth: false });
  assert.equal(r.status, 401);
});

test('登录：错误密码 401，正确密码下发 HttpOnly Cookie', async () => {
  const bad = await call('POST', '/api/login', { username: 'admin', password: 'wrong' }, { auth: false });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/api/login', { username: 'admin', password: PASSWORD }, { auth: false });
  assert.equal(good.status, 200);
  const set = good.res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  const me = await call('GET', '/api/me');
  assert.equal(me.json.data.user, 'admin');
});

test('缺少自定义请求头的写请求被拒绝（CSRF 防护）', async () => {
  const r = await call('POST', '/api/refresh', {}, { headers: { 'X-Requested-With': '' } });
  assert.equal(r.status, 403);
});

test('添加服务器：校验输入，成功后在线，响应与落盘都不含明文 API Key', async () => {
  assert.equal((await call('POST', '/api/servers', { name: '', url: panelUrl, apiKey: API_KEY })).status, 400);
  assert.equal((await call('POST', '/api/servers', { name: 'a', url: 'ftp://x', apiKey: API_KEY })).status, 400);
  assert.equal((await call('POST', '/api/servers', { name: 'a', url: panelUrl })).status, 400);

  const r = await call('POST', '/api/servers', { name: '测试机', url: panelUrl + '/some/entrance', apiKey: API_KEY, group: '生产' });
  assert.equal(r.status, 200);
  const s = r.json.data;
  assert.equal(s.url, panelUrl, '地址应归一化为 origin');
  assert.equal(s.status.state, 'online');
  assert.equal(s.status.version, 'v2.0.5');
  assert.equal(s.status.hostname, 'mock-host');
  assert.equal(s.status.mem.percent, 25);
  assert.deepEqual(s.status.containers, { running: 1, total: 2, exited: 1 });
  assert.equal(s.status.upgrade.newVersion, 'v2.0.6');
  assert.ok(!JSON.stringify(r.json).includes(API_KEY));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8').includes(API_KEY));
});

test('API Key 错误的服务器显示离线并给出可读原因', async () => {
  const r = await call('POST', '/api/servers', { name: '坏密钥', url: panelUrl, apiKey: 'wrong-key' });
  assert.equal(r.json.data.status.state, 'offline');
  assert.match(r.json.data.status.error, /API Key 不正确/);
  assert.equal((await call('DELETE', `/api/servers/${r.json.data.id}`)).status, 200);
});

test('连接不上的服务器显示离线', async () => {
  const r = await call('POST', '/api/servers', { name: '不可达', url: 'http://127.0.0.1:1', apiKey: 'x' });
  assert.equal(r.json.data.status.state, 'offline');
  assert.ok(r.json.data.status.error);
  await call('DELETE', `/api/servers/${r.json.data.id}`);
});

test('编辑服务器时 API Key 留空则保留原值', async () => {
  const [s] = (await call('GET', '/api/servers')).json.data;
  const r = await call('PUT', `/api/servers/${s.id}`, { name: '测试机-改', url: panelUrl, apiKey: '', group: '生产' });
  assert.equal(r.json.data.name, '测试机-改');
  assert.equal(r.json.data.status.state, 'online');
});

test('容器：列表、筛选、启停、升级镜像、创建、删除', async () => {
  const [s] = (await call('GET', '/api/servers')).json.data;
  let list = (await call('GET', '/api/containers?server=all')).json.data;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].items.map((c) => c.name), ['nginx', 'redis']);

  list = (await call('GET', `/api/containers?server=${s.id}&state=running`)).json.data;
  assert.deepEqual(list[0].items.map((c) => c.name), ['nginx']);

  let job = (await call('POST', '/api/containers/operate', { operation: 'stop', targets: [{ serverId: s.id, names: ['nginx'] }] })).json.data;
  assert.equal(job.status, 'success');
  assert.equal(panel.state.containers.find((c) => c.name === 'nginx').state, 'exited');

  assert.equal((await call('POST', '/api/containers/operate', { operation: 'rm -rf', targets: [{ serverId: s.id, names: ['nginx'] }] })).status, 400);

  job = (await call('POST', '/api/containers/operate', { operation: 'start', targets: [{ serverId: s.id, names: ['nope'] }] })).json.data;
  assert.equal(job.status, 'failed');
  assert.match(job.items[0].message, /not found/);

  job = (await call('POST', '/api/containers/upgrade', { image: 'nginx:1.28', forcePull: true, targets: [{ serverId: s.id, names: ['nginx'] }] })).json.data;
  assert.equal(job.status, 'success');
  assert.equal(panel.state.containers.find((c) => c.name === 'nginx').imageName, 'nginx:1.28');

  job = (await call('POST', '/api/containers/create', {
    serverIds: [s.id],
    spec: { name: 'web', image: 'caddy:2', ports: '8080:80\n127.0.0.1:5353:53/udp', volumes: '/opt/web:/data:ro\nvol1:/cache', env: 'TZ=Asia/Shanghai', restartPolicy: 'always' },
  })).json.data;
  assert.equal(job.status, 'success');
  const created = panel.state.calls.findLast((c) => c.key === 'POST /containers').body;
  assert.ok(created.taskID);
  assert.deepEqual(created.exposedPorts[1], { hostIP: '127.0.0.1', hostPort: '5353', containerPort: '53', protocol: 'udp' });
  assert.deepEqual(created.volumes.map((v) => [v.type, v.mode]), [['bind', 'ro'], ['volume', 'rw']]);
  assert.equal(created.restartPolicy, 'always');

  job = (await call('POST', '/api/containers/operate', { operation: 'remove', targets: [{ serverId: s.id, names: ['web'] }] })).json.data;
  assert.equal(job.status, 'success');
  assert.ok(!panel.state.containers.some((c) => c.name === 'web'));
});

test('buildContainerSpec 拒绝格式错误的输入', () => {
  assert.throws(() => buildContainerSpec({ name: 'bad name', image: 'a' }), /容器名称/);
  assert.throws(() => buildContainerSpec({ name: 'a', image: '' }), /镜像/);
  assert.throws(() => buildContainerSpec({ name: 'a', image: 'b', ports: '80' }), /端口映射/);
  assert.throws(() => buildContainerSpec({ name: 'a', image: 'b', volumes: 'nocolon' }), /挂载/);
  assert.throws(() => buildContainerSpec({ name: 'a', image: 'b', env: 'NOEQ' }), /环境变量/);
});

test('Compose：部署、列表、操作', async () => {
  const [s] = (await call('GET', '/api/servers')).json.data;
  assert.equal((await call('POST', '/api/composes/create', { serverIds: [s.id], name: 'Bad Name', file: 'services: {}' })).status, 400);
  assert.equal((await call('POST', '/api/composes/create', { serverIds: [], name: 'stack', file: 'services: {}' })).status, 400);
  let job = (await call('POST', '/api/composes/create', { serverIds: [s.id], name: 'stack', file: 'services:\n  a:\n    image: nginx' })).json.data;
  assert.equal(job.status, 'success');
  const list = (await call('GET', '/api/composes?server=all')).json.data;
  assert.equal(list[0].items[0].name, 'stack');
  job = (await call('POST', '/api/composes/operate', { serverId: s.id, name: 'stack', path: list[0].items[0].path, operation: 'restart' })).json.data;
  assert.equal(job.status, 'success');
  assert.equal((await call('POST', '/api/composes/operate', { serverId: s.id, name: 'stack', operation: 'delete' })).status, 400);
});

test('批量拉取镜像', async () => {
  const [s] = (await call('GET', '/api/servers')).json.data;
  const job = (await call('POST', '/api/images/pull', { serverIds: [s.id], image: 'redis:7' })).json.data;
  assert.equal(job.status, 'success');
  assert.deepEqual(panel.state.calls.findLast((c) => c.key === 'POST /containers/image/pull').body.imageName, ['redis:7']);
});

test('批量升级：提交后轮询到新版本才算成功，再次升级提示已是最新', async () => {
  const [s] = (await call('GET', '/api/servers')).json.data;
  let job = (await call('POST', '/api/upgrade', { serverIds: [s.id] })).json.data;
  assert.equal(job.status, 'running');
  job = await waitJob(job.id);
  assert.equal(job.status, 'success');
  assert.match(job.items[0].message, /升级成功：v2\.0\.5 → v2\.0\.6/);
  assert.equal(panel.state.version, 'v2.0.6');

  job = await waitJob((await call('POST', '/api/upgrade', { serverIds: [s.id] })).json.data.id);
  assert.match(job.items[0].message, /已是最新版本/);
});

test('升级超时判定为失败', async () => {
  const slow = createMockPanel({ apiKey: API_KEY, upgradeDelayMs: 60_000 });
  const url = await slow.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opf-slow-'));
  const cfg = { ...loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: PASSWORD, POLL_INTERVAL: '0' }), upgradePollMs: 30, upgradeTimeoutMs: 200 };
  const app2 = createApp(cfg, () => {});
  const origin = `http://127.0.0.1:${await app2.listen(0, '127.0.0.1')}`;
  const login = await call('POST', '/api/login', { username: 'admin', password: PASSWORD }, { auth: false, origin });
  const headers = { Cookie: login.res.headers.get('set-cookie').split(';')[0] };
  const s = (await call('POST', '/api/servers', { name: 'slow', url, apiKey: API_KEY }, { auth: false, headers, origin })).json.data;
  const job = (await call('POST', '/api/upgrade', { serverIds: [s.id] }, { auth: false, headers, origin })).json.data;
  let final;
  for (let i = 0; i < 100; i++) {
    final = (await call('GET', `/api/jobs/${job.id}`, undefined, { auth: false, headers, origin })).json.data;
    if (final.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(final.status, 'failed');
  assert.match(final.items[0].message, /超时/);
  await app2.close();
  await slow.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('只读模式：可查看和刷新，变更操作被拒绝', async () => {
  await app.close();
  app = makeApp({ readOnly: true });
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  const login = await call('POST', '/api/login', { username: 'admin', password: PASSWORD }, { auth: false });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  const servers = (await call('GET', '/api/servers')).json.data;
  assert.equal(servers.length, 1, '重启后服务器记录应保留');
  assert.equal((await call('POST', '/api/refresh', {})).status, 200);
  assert.equal((await call('POST', '/api/upgrade', { serverIds: [servers[0].id] })).status, 403);
  assert.equal((await call('DELETE', `/api/servers/${servers[0].id}`)).status, 403);
  assert.equal((await call('POST', '/api/containers/operate', { operation: 'stop', targets: [] })).status, 403);
});

test('操作日志有记录，静态资源与安全响应头正常', async () => {
  const audit = (await call('GET', '/api/audit')).json.data;
  assert.ok(audit.some((a) => a.action === '升级 1Panel'));
  assert.ok(audit.some((a) => a.action === '登录失败'));
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  assert.equal((await fetch(base + '/server/app.js')).status, 404);
});

test('连续登录失败后锁定', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/login', { username: 'admin', password: 'nope' }, { auth: false });
  assert.equal(last.status, 429);
});
