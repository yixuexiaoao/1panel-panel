import crypto from 'node:crypto';

const COOKIE = 'opf_session';
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export function createAuth(cfg, store, log = console.log) {
  const sessions = new Map(); // token -> { user, expires }
  const fails = new Map(); // ip -> { count, until }

  // 未通过环境变量指定密码时，首次启动生成随机密码，只打印一次
  if (!cfg.adminPassword && !store.getAdmin()) {
    const password = crypto.randomBytes(12).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    store.setAdmin({ salt, hash: hashPassword(password, salt) });
    log(`[auth] 未设置 ADMIN_PASSWORD，已生成初始密码（仅显示这一次）：${password}`);
  }

  function checkPassword(username, password) {
    if (!safeEqual(String(username), cfg.adminUser)) return false;
    if (cfg.adminPassword) return safeEqual(String(password), cfg.adminPassword);
    const admin = store.getAdmin();
    return !!admin && safeEqual(hashPassword(String(password), admin.salt), admin.hash);
  }

  function login(ip, username, password) {
    const now = Date.now();
    const f = fails.get(ip) || { count: 0, until: 0 };
    if (f.until > now) {
      return { ok: false, locked: true, retryAfter: Math.ceil((f.until - now) / 1000) };
    }
    if (!checkPassword(username, password)) {
      f.count += 1;
      if (f.count >= MAX_FAILS) {
        f.count = 0;
        f.until = now + LOCK_MS;
      }
      fails.set(ip, f);
      return { ok: false };
    }
    fails.delete(ip);
    for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { user: cfg.adminUser, expires: now + cfg.sessionTtlMs });
    return { ok: true, token };
  }

  function tokenFrom(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === COOKIE) return v;
    }
    return '';
  }

  function session(req) {
    const token = tokenFrom(req);
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return s;
  }

  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${cfg.cookieSecure ? '; Secure' : ''}`;

  return {
    login,
    session,
    logout: (req) => sessions.delete(tokenFrom(req)),
    setCookie: (token) => `${COOKIE}=${token}; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}; ${cookieAttrs}`,
    clearCookie: () => `${COOKIE}=; Max-Age=0; ${cookieAttrs}`,
  };
}
