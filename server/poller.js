import { api } from './panel.js';
import { mapLimit } from './util.js';

/** 周期性拉取各服务器状态并缓存，前端只读缓存，不会放大对面板的请求 */
export function createPoller(cfg, store) {
  const cache = new Map(); // serverId -> status
  let timer = null;
  let running = false;

  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

  async function pollOne(server, { checkUpgrade = false } = {}) {
    const prev = cache.get(server.id) || {};
    const status = { ...prev, checkedAt: new Date().toISOString() };
    let s;
    try {
      s = store.resolve(server);
    } catch (e) {
      Object.assign(status, { state: 'offline', error: e.message });
      cache.set(server.id, status);
      return status;
    }
    const opt = { timeout: cfg.requestTimeoutMs };
    const [base, settings, containers] = await Promise.all([
      settle(api.base(s, opt)),
      settle(api.settings(s, opt)),
      settle(api.containerStatus(s, opt)),
    ]);

    if (!base.ok) {
      Object.assign(status, { state: 'offline', error: base.e.message });
      cache.set(server.id, status);
      return status;
    }
    const b = base.v || {};
    const cur = b.currentInfo || {};
    Object.assign(status, {
      state: 'online',
      error: '',
      hostname: b.hostname || '',
      os: b.prettyDistro || [b.platform, b.platformVersion].filter(Boolean).join(' '),
      arch: b.kernelArch || '',
      kernel: b.kernelVersion || '',
      cpuCores: b.cpuLogicalCores || b.cpuCores || 0,
      cpu: cur.cpuUsedPercent ?? null,
      mem: { used: cur.memoryUsed || 0, total: cur.memoryTotal || 0, percent: cur.memoryUsedPercent ?? null },
      load: [cur.load1, cur.load5, cur.load15].map((n) => n ?? null),
      uptime: cur.uptime || 0,
      disks: (cur.diskData || []).map((d) => ({ path: d.path, total: d.total, used: d.used, percent: d.usedPercent })),
      counts: {
        websites: b.websiteNumber || 0,
        databases: b.databaseNumber || 0,
        apps: b.appInstalledNumber || 0,
        cronjobs: b.cronjobNumber || 0,
      },
    });
    if (settings.ok && settings.v) {
      status.version = settings.v.systemVersion || '';
      status.edition = settings.v.edition || '';
    }
    status.containers = containers.ok && containers.v
      ? { running: containers.v.running || 0, total: containers.v.containerCount || 0, exited: containers.v.exited || 0 }
      : null;

    const stale = !prev.upgrade || Date.now() - new Date(prev.upgrade.checkedAt).getTime() > cfg.upgradeCheckMs;
    if (checkUpgrade || stale) {
      const up = await settle(api.upgradeInfo(s));
      status.upgrade = {
        checkedAt: new Date().toISOString(),
        newVersion: up.ok ? up.v?.newVersion || '' : '',
        latestVersion: up.ok ? up.v?.latestVersion || '' : '',
        error: up.ok ? '' : up.e.message,
      };
    }
    cache.set(server.id, status);
    return status;
  }

  async function pollAll(opts) {
    if (running) return;
    running = true;
    try {
      await mapLimit(store.listServers(), cfg.concurrency, (s) => pollOne(s, opts).catch(() => null));
    } finally {
      running = false;
    }
  }

  return {
    get: (id) => cache.get(id) || { state: 'unknown' },
    forget: (id) => cache.delete(id),
    pollOne,
    pollAll,
    start() {
      pollAll();
      if (cfg.pollIntervalMs > 0) {
        timer = setInterval(pollAll, cfg.pollIntervalMs);
        timer.unref();
      }
    },
    stop: () => clearInterval(timer),
  };
}
