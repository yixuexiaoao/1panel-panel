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

// 面板鉴权失败时返回 HTTP 200 + code 401，message 是按 Accept-Language 翻译后的文案
// （上游 core/app/auth/api_auth.go 与 core/i18n/lang/*.yaml）。同时识别键名与中 / 繁 / 英文案，
// 不能用 "IP"、"Key" 这类短词匹配——"API" 本身就包含 "IP"。
const AUTH_ERRORS = [
  [/ErrApiConfigKeyExpired|已到期|expired/i, 'API Key 已过期，请在面板的 API Key 管理中调整有效期或更换密钥'],
  [/ErrApiConfigKeyTimeInvalid|时间戳|時間戳|timestamp/i, '时间戳无效，请检查两端时间是否同步'],
  [/ErrApiConfigIPInvalid|白名单|白名單|whitelist/i, '本程序的出口 IP 不在面板的 API 白名单内'],
  [/ErrApiConfigDisable|禁止使用|prohibits API/i, '该接口不允许通过 API 调用'],
  // 多 Key 模式下 Key 匹配不到会回退到旧版单 Key 配置，旧配置未开启时同样返回此错误（已在 v2.5.1 实测）
  [/ErrApiConfigStatusInvalid|禁止访问|禁止訪問|access disabled/i, 'API Key 不正确，或面板未开启 API 接口 / 该 Key 已停用'],
  [/ErrApiConfigKeyInvalid|密钥错误|金鑰錯誤|invalid API key/i, 'API Key 不正确（可能已在面板中重置）'],
];
const AUTH_HINT = '请确认面板已开启 API 接口、API Key 正确且未重置、本程序的出口 IP 在白名单内，并且两端时间同步';
const SKEW_WARN_SEC = 60;

/** 由面板响应的 Date 头估算时间差（秒，正数表示本机比面板快）；无法判断时返回 null */
export function clockSkew(dateHeader, now = Date.now()) {
  const t = Date.parse(dateHeader || '');
  return Number.isNaN(t) ? null : Math.round((now - t) / 1000);
}

/** 把面板的 401 信息翻译为可操作的原因说明 */
export function diagnoseAuth(message, skew = null) {
  const msg = String(message || '');
  const hit = AUTH_ERRORS.find(([re]) => re.test(msg));
  let text = `API 鉴权失败：${hit ? hit[1] : `${msg || '未知原因'}。${AUTH_HINT}`}`;
  if (hit && msg) text += `（面板返回：${msg.slice(0, 100)}）`;
  if (skew !== null && Math.abs(skew) > SKEW_WARN_SEC) {
    text += `（本机时间比面板${skew > 0 ? '快' : '慢'}约 ${Math.abs(skew)} 秒）`;
  }
  return text;
}

/** 面板返回非 JSON 时的说明：HTML 多半是地址或反向代理指错了地方 */
export function describeNonJson(status, contentType, text) {
  const html = /text\/html/i.test(contentType || '') || /^\s*<(!doctype html|html)/i.test(text || '');
  if (!html) return `面板返回非 JSON 内容（HTTP ${status}），请确认地址指向 1Panel v2`;
  return `面板返回了网页而不是 API 响应（HTTP ${status}）：请确认地址只填协议、主机和端口（不带安全入口路径），且反向代理把 /api/v2 转发到了 1Panel；面板是 v1 也会出现此情况`;
}

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
      // 固定让面板返回中文错误信息，便于展示与识别
      'Accept-Language': 'zh',
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
            new PanelError(describeNonJson(res.statusCode, res.headers['content-type'], text.slice(0, 200)), {
              status: res.statusCode,
            }),
          );
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && json?.code === 200) {
          return finish(resolve, json.data);
        }
        let message = json?.message || `HTTP ${res.statusCode}`;
        const auth = res.statusCode === 401 || json?.code === 401;
        if (auth) message = diagnoseAuth(json?.message, clockSkew(res.headers.date));
        finish(reject, new PanelError(message, { status: res.statusCode, code: json?.code, auth }));
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
