import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUDIT_MAX = 500;

/** JSON 文件存储。数据量小（几十台服务器），同步原子写入即可。 */
export function createStore(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'data.json');
  let data = { servers: [], audit: [], admin: null };
  if (fs.existsSync(file)) {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  const key = loadKey();

  function loadKey() {
    if (cfg.secretKey) return crypto.scryptSync(cfg.secretKey, '1panel-fleet', 32);
    const kf = path.join(cfg.dataDir, 'secret.key');
    if (!fs.existsSync(kf)) {
      fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    const buf = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
    if (buf.length !== 32) throw new Error('secret.key 内容无效');
    return buf;
  }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }

  function decrypt(blob) {
    const [v, iv, tag, ct] = String(blob).split(':');
    if (v !== 'v1') throw new Error('密文格式无效');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }

  return {
    encrypt,
    decrypt,
    listServers: () => data.servers,
    getServer: (id) => data.servers.find((s) => s.id === id),
    /** 返回可直接用于请求面板的对象（含解密后的 apiKey） */
    resolve(server) {
      try {
        return { ...server, apiKey: decrypt(server.apiKeyEnc) };
      } catch {
        throw new Error('API Key 解密失败：SECRET_KEY 或 secret.key 与保存时不一致');
      }
    },
    addServer(fields) {
      const server = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...fields };
      data.servers.push(server);
      save();
      return server;
    },
    updateServer(id, fields) {
      const server = data.servers.find((s) => s.id === id);
      if (!server) return null;
      Object.assign(server, fields);
      save();
      return server;
    },
    removeServer(id) {
      const before = data.servers.length;
      data.servers = data.servers.filter((s) => s.id !== id);
      if (data.servers.length !== before) save();
      return data.servers.length !== before;
    },
    getAdmin: () => data.admin,
    setAdmin(admin) {
      data.admin = admin;
      save();
    },
    audit(entry) {
      data.audit.unshift({ time: new Date().toISOString(), ...entry });
      if (data.audit.length > AUDIT_MAX) data.audit.length = AUDIT_MAX;
      save();
    },
    listAudit: () => data.audit,
  };
}
