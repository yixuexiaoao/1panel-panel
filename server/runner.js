// 通过面板的“定时任务（shell 类型）”在服务器上执行一次脚本并取回输出：
// 创建临时任务 → 停用其调度 → 立即执行一次 → 轮询执行记录 → 读取日志 → 删除任务与记录。
// 依据上游 agent/app/service/cronjob.go：Create 不返回 ID，按唯一名称查回；HandleOnce 不检查启用状态。
import crypto from 'node:crypto';
import { api, PanelError } from './panel.js';
import { sleep } from './util.js';

export const TEMP_PREFIX = 'fleet-cmd-';
const MAX_OUTPUT = 128 * 1024;
// 1Panel 使用 robfig/cron。2 月 31 日匹配不到任何执行时间，即使停用前失联也不会自动执行。
const NEVER = '0 0 31 2 *';
const TERMINAL = new Set(['Success', 'Failed', 'Canceled']);
const retryable = (e) => e instanceof PanelError && (e.network || e.status >= 500 || e.code >= 500);

export function cronjobBody(name, script, timeoutSec) {
  return {
    name, type: 'shell', groupID: 0, specCustom: true, spec: NEVER,
    executor: 'bash', scriptMode: 'input', script, command: '', containerName: '', user: '',
    scriptID: 0, appID: '', website: '', exclusionRules: '', dbType: '', dbName: '', url: '', urlItems: [],
    isDir: false, sourceDir: '', snapshotRule: { withImage: false, ignoreAppIDs: [] },
    sourceAccountIDs: '', downloadAccountID: 0, retainCopies: 1, retryTimes: 0, timeout: timeoutSec,
    ignoreErr: false, secret: '', args: '', alertCount: 0, alertTitle: '', alertMethod: '', scopes: [],
  };
}

const truncate = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出过长，已截断）` : s);

export class CommandError extends Error {
  constructor(message, output = '') {
    super(message);
    this.output = output;
  }
}

/**
 * @param cfg 需含 commandPollMs
 * @returns {(server, script:string, opts:{timeoutSec:number, report?:(m:string)=>void}) => Promise<{status:string, output:string}>}
 */
export function createRunner(cfg) {
  const interval = cfg.commandPollMs ?? 2000;
  const find = async (s, name) => (await api.searchCronjobs(s, name))?.items?.find((j) => j.name === name);

  async function findCreated(s, name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(interval);
      try {
        const job = await find(s, name);
        if (job) return job;
      } catch (e) {
        if (!retryable(e)) break;
      }
    }
    throw new CommandError(`无法确认面板是否已创建临时任务 ${name}，请在面板核对`);
  }

  return async function run(s, script, { timeoutSec, report = () => {} }) {
    const name = `${TEMP_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
    let job, rec, result, error;
    let submitted = false;
    try {
      try {
        await api.createCronjob(s, cronjobBody(name, script, timeoutSec));
      } catch (e) {
        // 请求可能已经提交。按原名称确认，避免再次创建。
        if (!retryable(e)) throw e;
      }
      job = await findCreated(s, name);
      await api.cronjobStatus(s, job.id, 'Disable');
      const deadline = Date.now() + timeoutSec * 1000 + 30_000;
      try {
        await api.handleCronjob(s, job.id);
        submitted = true;
      } catch (e) {
        if (!retryable(e)) throw e;
        submitted = true;
      }
      report('执行中…');
      while (Date.now() < deadline) {
        await sleep(Math.min(interval, deadline - Date.now()));
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          const records = await api.searchRecords(s, job.id, { pageSize: 1 }, { timeout: Math.min(15_000, remaining) });
          rec = records?.items?.[0] || rec;
        } catch (e) {
          if (!retryable(e)) throw e;
          continue;
        }
        if (TERMINAL.has(rec?.status)) break;
      }
      if (!TERMINAL.has(rec?.status)) throw new CommandError(`等待执行结果超时（脚本时限 ${timeoutSec} 秒）`);
      let output;
      try {
        output = truncate(String((await api.recordLog(s, rec.id)) || ''));
      } catch {
        throw new CommandError(`脚本执行结果为 ${rec.status}，但读取输出失败`);
      }
      if (rec.status !== 'Success') throw new CommandError(`执行失败${rec.message ? `：${rec.message}` : ''}`, output);
      result = { status: rec.status, output };
    } catch (e) {
      error = e;
    }

    if (job && submitted && !TERMINAL.has(rec?.status)) {
      if (rec?.id) await api.stopCronjobRecord(s, rec.id).catch(() => {});
      throw new CommandError(`${error.message}；已保留停用的临时任务 ${name}，请在面板确认执行状态并清理`);
    }
    if (job) {
      try {
        await api.deleteCronjobs(s, [job.id]);
      } catch {
        // 删除响应也可能丢失。只有查到任务已消失时才视为清理完成。
        const removed = await find(s, name).then((found) => !found, () => false);
        if (!removed) {
          throw new CommandError(`${error?.message || '脚本已执行成功'}；临时任务 ${name} 清理未确认，请在面板核对`,
            result?.output ?? error?.output);
        }
      }
    }
    if (error) throw error;
    return result;
  };
}
