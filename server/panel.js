// 1Panel v2 API 客户端。路径与请求体依据官方仓库 dev-v2 分支的路由与 DTO 定义。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const MAX_BODY = 20 * 1024 * 1024;

export class PanelError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/** Token = md5("1panel" + apiKey + 秒级时间戳)，所有 v2 版本均接受 */
export function sign(apiKey, timestamp) {
  return crypto.createHash('md5').update(`1panel${apiKey}${timestamp}`).digest('hex');
}

const NET_ERRORS = {
  ECONNREFUSED: '连接被拒绝，请检查地址和端口',
  ECONNRESET: '连接被重置',
  ENOTFOUND: '域名无法解析',
  EAI_AGAIN: '域名解析失败',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EPROTO: 'TLS 握手失败，请确认协议是 http 还是 https',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书为自签名，可在服务器设置中开启“跳过证书校验”',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链含自签名证书，可开启“跳过证书校验”',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书无法验证，可开启“跳过证书校验”',
  CERT_HAS_EXPIRED: '证书已过期',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配，可开启“跳过证书校验”',
};

const AUTH_ERRORS = [
  ['IP', 'API 鉴权失败：本程序的出口 IP 不在面板的 IP 白名单内'],
  ['Time', 'API 鉴权失败：时间戳无效，请检查两端时间是否同步'],
  ['Status', 'API 鉴权失败：面板未开启 API 接口'],
  ['Key', 'API 鉴权失败：API Key 不正确'],
];

export function request(server, method, path, body, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(`/api/v2${path}`, server.url);
    } catch {
      return reject(new PanelError('面板地址无效'));
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      Accept: 'application/json',
      '1Panel-Token': sign(server.apiKey, ts),
      '1Panel-Timestamp': ts,
    };
    if (server.keyId) headers['1Panel-Key-ID'] = server.keyId;
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const lib = url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = lib.request(url, { method, headers, rejectUnauthorized: !server.skipTls }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          return finish(reject, new PanelError('响应过大'));
        }
        chunks.push(c);
      });
      res.on('error', (e) => finish(reject, new PanelError(NET_ERRORS[e.code] || e.message, { network: true })));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return finish(
            reject,
            new PanelError(`面板返回非 JSON 内容（HTTP ${res.statusCode}），请确认地址指向 1Panel v2`, {
              status: res.statusCode,
            }),
          );
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && json.code === 200) {
          return finish(resolve, json.data);
        }
        let message = json.message || `HTTP ${res.statusCode}`;
        if (res.statusCode === 401 || json.code === 401) {
          const hit = AUTH_ERRORS.find(([k]) => String(message).includes(k));
          message = hit ? hit[1] : `API 鉴权失败：${message}`;
        }
        finish(reject, new PanelError(message, { status: res.statusCode, code: json.code }));
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new PanelError('请求超时', { network: true, timeout: true }));
    }, timeout);
    req.on('error', (e) => finish(reject, new PanelError(NET_ERRORS[e.code] || e.message, { network: true })));
    req.end(payload);
  });
}

const taskID = () => crypto.randomUUID();
const LONG = { timeout: 120_000 };

export const api = {
  // ---- 状态 ----
  base: (s, o) => request(s, 'GET', '/dashboard/base/all/all', undefined, o),
  settings: (s, o) => request(s, 'POST', '/core/settings/search', {}, o),
  containerStatus: (s, o) => request(s, 'GET', '/containers/status', undefined, o),

  // ---- 面板升级 ----
  upgradeInfo: (s, o) => request(s, 'GET', '/core/settings/upgrade', undefined, { timeout: 30_000, ...o }),
  upgrade: (s, version, o) => request(s, 'POST', '/core/settings/upgrade', { version }, { timeout: 60_000, ...o }),

  // ---- 容器 ----
  searchContainers: (s, { name = '', state = 'all' } = {}, o) =>
    request(
      s,
      'POST',
      '/containers/search',
      { page: 1, pageSize: 500, name, state, orderBy: 'name', order: 'ascending', filters: '', excludeAppStore: false },
      o,
    ),
  operateContainers: (s, names, operation) =>
    request(s, 'POST', '/containers/operate', { taskID: taskID(), names, operation }, LONG),
  upgradeContainer: (s, names, image, forcePull) =>
    request(s, 'POST', '/containers/upgrade', { taskID: taskID(), names, image, forcePull: !!forcePull }, LONG),
  createContainer: (s, spec) => request(s, 'POST', '/containers', { ...spec, taskID: taskID() }, LONG),
  pullImage: (s, imageName) =>
    request(s, 'POST', '/containers/image/pull', { taskID: taskID(), repoID: 0, imageName: [imageName] }, LONG),

  // ---- Compose ----
  searchCompose: (s, info = '', o) =>
    request(s, 'POST', '/containers/compose/search', { page: 1, pageSize: 200, info, excludeAppStore: false }, o),
  createCompose: (s, { name, file, env, forcePull }) =>
    request(
      s,
      'POST',
      '/containers/compose',
      { taskID: taskID(), name, dirName: name, from: 'edit', file, path: '', template: 0, env: env || '', forcePull: !!forcePull },
      LONG,
    ),
  operateCompose: (s, { name, path, operation }) =>
    request(s, 'POST', '/containers/compose/operate', { name, path, operation, withFile: false, force: false }, LONG),
};
