// 1Panel v2.5.1 文件接口适配，仅使用已核实的固定路径和字段。
// 来源：agent/app/dto/request/{file,favorite}.go、agent/app/service/file.go。
import crypto from 'node:crypto';
import path from 'node:path';
import { request } from './panel.js';
import { HttpError } from './util.js';

const READ = { timeout: 30_000 };
const COMPRESS_FORMATS = new Set(['zip', 'tar.gz']);
const EXTRACT_FORMATS = new Set(['zip', 'tar', 'tar.gz', '7z', 'rar', 'tar.bz2']);

function absolutePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) {
    throw new HttpError(400, '文件路径必须为有效的绝对路径');
  }
  if (path.posix.normalize(value) !== value) throw new HttpError(400, '请使用规范的绝对路径');
  return value;
}

function fileName(value) {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..' || /[\/\0]/u.test(value) || value.length > 255) {
    throw new HttpError(400, '文件名称无效');
  }
  return value;
}

function paths(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new HttpError(400, '请选择 1 至 100 个文件');
  return [...new Set(value.map(absolutePath))];
}

function format(value, supported) {
  if (!supported.has(value)) throw new HttpError(400, `支持 ${[...supported].join('、')} 格式`);
  return value;
}

function taskId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new HttpError(400, '任务 ID 无效');
  }
  return value;
}

async function submit(server, endpoint, body) {
  const id = crypto.randomUUID();
  try {
    await request(server, 'POST', endpoint, { ...body, taskID: id }, READ);
  } catch (error) {
    // 响应丢失时保留原 ID，调用方可查询任务，避免重复提交。
    error.taskID = id;
    throw error;
  }
  return { taskID: id, status: 'submitted' };
}

export const fileActions = {
  listFavorites(server, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, '收藏页码无效');
    return request(server, 'POST', '/files/favorite/search', { page, pageSize: 100 }, READ);
  },

  addFavorite(server, filePath) {
    return request(server, 'POST', '/files/favorite', { path: absolutePath(filePath) }, READ);
  },

  removeFavorite(server, id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, '收藏 ID 无效');
    return request(server, 'POST', '/files/favorite/del', { id }, READ);
  },

  changeMode(server, filePath, mode) {
    if (typeof mode !== 'string' || !/^[0-7]{3,4}$/u.test(mode)) throw new HttpError(400, '权限应为 3 或 4 位八进制数字');
    return request(server, 'POST', '/files/mode', { path: absolutePath(filePath), mode: parseInt(mode, 8), sub: false }, READ);
  },

  changeOwner(server, filePath, user, group) {
    if (typeof user !== 'string' || !user || typeof group !== 'string' || !group || user.length > 100 || group.length > 100) {
      throw new HttpError(400, '请选择有效的用户和用户组');
    }
    return request(server, 'POST', '/files/owner', { path: absolutePath(filePath), user, group, sub: false }, READ);
  },

  move(server, { operation, sources, destination }) {
    if (!['copy', 'cut'].includes(operation)) throw new HttpError(400, '不支持的文件操作');
    return submit(server, '/files/move', {
      type: operation, oldPaths: paths(sources), newPath: absolutePath(destination), name: '', cover: false, coverPaths: [],
    });
  },

  compress(server, { sources, destination, name, type }) {
    return submit(server, '/files/compress', {
      files: paths(sources), dst: absolutePath(destination), name: fileName(name), type: format(type, COMPRESS_FORMATS), replace: false, secret: '',
    });
  },

  decompress(server, { source, destination, type }) {
    return submit(server, '/files/decompress', {
      path: absolutePath(source), dst: absolutePath(destination), type: format(type, EXTRACT_FORMATS), secret: '',
    });
  },

  task(server, id) {
    return request(server, 'POST', '/logs/tasks/search', { page: 1, pageSize: 1, taskID: taskId(id) }, READ);
  },

};
