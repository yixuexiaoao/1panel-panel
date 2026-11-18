import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { uploadFile, downloadFile, MAX_UPLOAD_BYTES } from '../server/file-transfer.js';
import { sign } from '../server/panel.js';

async function mock(handler, run) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 500, message: error.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'transfer-test-key' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('上传保持二进制和中文文件名，发送鉴权并禁止覆盖', async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 34, 1]);
  const filename = '中文文件.bin';
  await mock(async (request, response) => {
    assert.equal(request.url, '/api/v2/files/upload');
    assert.equal(request.headers['1panel-token'], sign('transfer-test-key', request.headers['1panel-timestamp']));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(body.length, Number(request.headers['content-length']));
    const form = await new Request('http://mock/upload', { method: 'POST', headers: {
      'Content-Type': request.headers['content-type'],
    }, body }).formData();
    assert.equal(form.get('path'), '/tmp/中文目录');
    assert.equal(form.get('overwrite'), 'false');
    assert.equal(form.get('file').name, filename);
    assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), bytes);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 200, data: null }));
  }, async (server) => {
    assert.equal(await uploadFile(server, { directory: '/tmp/中文目录', filename, body: Readable.from([bytes]), size: bytes.length }), null);
  });
});

test('上传拒绝非法文件名、超限和实际大小不符', async () => {
  const opts = { directory: '/tmp', filename: 'ok.bin', body: Readable.from([]), size: 0 };
  const server = { url: 'http://127.0.0.1:1', apiKey: 'unused' };
  for (const filename of ['../file', '..', 'bad\r\nX-Injected: true', 'a\\b']) {
    await assert.rejects(uploadFile(server, { ...opts, filename }), /文件名无效/);
  }
  await assert.rejects(uploadFile(server, { ...opts, size: MAX_UPLOAD_BYTES + 1 }), /100 MiB/);
  await mock((request, response) => { request.resume(); }, async (target) => {
    await assert.rejects(uploadFile(target, { ...opts, body: Readable.from([Buffer.from('ab')]), size: 1 }), /大于声明/);
    await assert.rejects(uploadFile(target, { ...opts, body: Readable.from([Buffer.from('a')]), size: 2 }), /不一致/);
  });
});

test('上传取消和面板拒绝会结束传输并返回可读错误', async () => {
  await mock((request, response) => {
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 401, message: 'API 接口密钥错误' }));
  }, async (target) => {
    await assert.rejects(uploadFile(target, { directory: '/tmp', filename: 'empty', body: Readable.from([]), size: 0 }), /API Key 不正确/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(uploadFile(target, { directory: '/tmp', filename: 'empty', body: Readable.from([]), size: 0, signal: abort.signal }), /取消/);
  });
});

test('下载直接返回二进制流，鉴权错误不当作文件下载', async () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  await mock((request, response) => {
    if (new URL(request.url, 'http://mock').searchParams.get('path') === '/tmp/file.bin') {
      response.writeHead(200, { 'Content-Disposition': 'attachment; filename=file.bin', 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ code: 401, message: 'API 接口密钥错误' }));
    }
  }, async (target) => {
    const response = await downloadFile(target, '/tmp/file.bin');
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await assert.rejects(downloadFile(target, '/tmp/missing'), /API Key 不正确/);
  });
});

test('下载返回成功的 JSON 附件时保持文件内容', async () => {
  await mock((request, response) => {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename=data.json', 'Content-Type': 'application/json' });
    response.end('{"code":401,"test":true}');
  }, async (target) => {
    const response = await downloadFile(target, '/tmp/data.json');
    let value = '';
    for await (const chunk of response) value += chunk;
    assert.equal(value, '{"code":401,"test":true}');
  });
});

test('上传进行中取消会关闭源流，下载取消会中止远端响应', async () => {
  await mock((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Disposition': 'attachment; filename=data.bin' });
      response.write('first');
    } else request.resume();
  }, async (target) => {
    const body = new PassThrough();
    const uploadAbort = new AbortController();
    const uploading = uploadFile(target, { directory: '/tmp', filename: 'cancel.bin', body, size: 10, signal: uploadAbort.signal });
    body.write('first');
    uploadAbort.abort();
    await assert.rejects(uploading, /取消/);
    assert.equal(body.destroyed, true);

    const downloadAbort = new AbortController();
    const response = await downloadFile(target, '/tmp/data.bin', { signal: downloadAbort.signal });
    const failed = new Promise((resolve) => response.once('error', resolve));
    downloadAbort.abort();
    await failed;
    assert.equal(response.destroyed, true);
  });
});
