const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8080, 1, 65535),
    dataDir: env.DATA_DIR || './data',
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    secretKey: env.SECRET_KEY || '',
    readOnly: bool(env.READ_ONLY),
    trustProxy: bool(env.TRUST_PROXY),
    cookieSecure: bool(env.COOKIE_SECURE),
    sessionTtlMs: num(env.SESSION_TTL_HOURS, 12, 1, 720) * 3600_000,
    // 状态轮询间隔（秒）；0 表示关闭后台轮询，仅手动刷新
    pollIntervalMs: num(env.POLL_INTERVAL, 60, 0, 3600) * 1000,
    // 升级信息检查间隔（小时）。该接口会让面板访问官方源，不宜频繁
    upgradeCheckMs: num(env.UPGRADE_CHECK_HOURS, 6, 1, 168) * 3600_000,
    requestTimeoutMs: num(env.REQUEST_TIMEOUT, 15, 3, 120) * 1000,
    upgradeTimeoutMs: num(env.UPGRADE_TIMEOUT, 900, 60, 3600) * 1000,
    upgradePollMs: 5000,
    upgradeConcurrency: num(env.UPGRADE_CONCURRENCY, 3, 1, 20),
    concurrency: 6,
  };
}
