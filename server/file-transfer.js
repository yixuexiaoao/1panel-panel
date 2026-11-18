// 依据 1Panel v2.5.1 agent/app/api/v2/file.go 的上传和下载契约。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sign, PanelError, diagnoseAuth, clockSkew, describeNonJson } from './panel.js';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

function options(server, method, pathname, headers = {}) {
  const url = new URL(`/api/v2${pathname}`, server.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new PanelError('面板地址无效');
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { url, method, rejectUnauthorized: !server.skipTls, headers: {
    Accept: 'application/json', 'Accept-Language': 'zh',
    '1Panel-Token': sign(server.apiKey, timestamp), '1Panel-Timestamp': timestamp,
    ...(server.keyId ? { '1Panel-Key-ID': server.keyId } : {}), ...headers,
  } };
}

function responseError(response, json) {
  const auth = response.statusCode === 401 || json?.code === 401;
  return new PanelError(auth ? diagnoseAuth(json?.message, clockSkew(response.headers.date)) :
    String(json?.message || `面板请求失败（HTTP ${response.statusCode}）`),
  { status: response.statusCode, code: json?.code, auth });
}

async function readResult(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new PanelError('面板传输响应过大');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PanelError(describeNonJson(response.statusCode, response.headers['content-type'], text.slice(0, 200)),
      { status: response.statusCode });
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || json?.code !== 200) throw responseError(response, json);
  return json.data;
}

/** 原始请求体作为单个文件上传。上游原子提交时拒绝覆盖同名文件。 */
export async function uploadFile(server, { directory, filename, body, size, signal }) {
  if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0') || directory.length > 4096) {
    throw new PanelError('上传目录必须为有效的绝对路径');
  }
  if (typeof filename !== 'string' || !filename.trim() || filename === '.' || filename === '..' || /[\\/\0-\x1f\x7f]/u.test(filename) || Buffer.byteLength(filename) > 255) {
    throw new PanelError('上传文件名无效');
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES) throw new PanelError('单个文件大小须在 0 到 100 MiB 之间');
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new PanelError('缺少上传文件内容');

  const boundary = `fleet-${crypto.randomBytes(24).toString('hex')}`;
  // multipart 参数保留 UTF-8 文件名，转义引号和反斜杠，目录放在表单内容中。
  const quotedName = filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const start = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${directory}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quotedName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const config = options(server, 'POST', '/files/upload', {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': start.length + size + end.length,
  });
  const request = (config.url.protocol === 'https:' ? https : http).request(config.url, config);
  const controller = new AbortController();
  const onAbort = () => controller.abort(new PanelError('上传已取消', { network: true }));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new PanelError('上传超时', { network: true, timeout: true })), TRANSFER_TIMEOUT_MS);
  const stopBody = () => body.destroy?.();
  controller.signal.addEventListener('abort', stopBody, { once: true });
  if (controller.signal.aborted) stopBody();
  let received = 0;
  // 字节计数只覆盖文件内容，避免把 multipart 头算进声明大小。
  async function* countedMultipart() {
    yield start;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > size) throw new PanelError('上传内容大于声明的文件大小');
      yield buffer;
    }
    if (received !== size) throw new PanelError('上传内容与声明的文件大小不一致');
    yield end;
  }
  const result = new Promise((resolve, reject) => {
    request.once('response', (response) => { readResult(response).then(resolve, reject); });
    request.once('error', reject);
  });
  const sending = pipeline(Readable.from(countedMultipart()), request, { signal: controller.signal });
  try {
    const [data] = await Promise.all([result, sending]);
    return data;
  } catch (error) {
    request.destroy();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof PanelError) throw error;
    throw new PanelError(`文件上传失败：${error.message}`, { network: true });
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', stopBody);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 下载成功返回暂停状态的原始响应流，调用方负责响应头、pipe 和下游取消。 */
export function downloadFile(server, filepath, { signal } = {}) {
  if (typeof filepath !== 'string' || !filepath.startsWith('/') || filepath.includes('\0') || filepath.length > 4096) {
    return Promise.reject(new PanelError('下载文件必须为有效的绝对路径'));
  }
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ path: filepath });
    const config = options(server, 'GET', `/files/download?${query}`, { Accept: '*/*' });
    const request = (config.url.protocol === 'https:' ? https : http).request(config.url, config);
    const abort = () => request.destroy(new PanelError('下载已取消', { network: true }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => request.destroy(new PanelError('等待下载响应超时', { network: true, timeout: true })), 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    request.once('error', (error) => {
      cleanup();
      reject(error instanceof PanelError ? error : new PanelError(`文件下载失败：${error.message}`, { network: true }));
    });
    request.once('response', (incoming) => {
      clearTimeout(timer);
      incoming.once('close', cleanup);
      incoming.setTimeout(60_000, () => incoming.destroy(new PanelError('下载连接超时', { network: true, timeout: true })));
      if (incoming.statusCode >= 200 && incoming.statusCode < 300 && /^attachment(?:;|$)/i.test(incoming.headers['content-disposition'] || '')) {
        resolve(incoming);
      } else {
        readResult(incoming).then(() => reject(new PanelError('面板未返回可下载的文件')), reject);
      }
    });
    request.end();
  });
}
