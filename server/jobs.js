import crypto from 'node:crypto';
import { mapLimit } from './util.js';

const KEEP = 50;

/** 批量任务：逐台执行、互不影响、可查询进度。任务只保存在内存中，重启后清空。 */
export function createJobs() {
  const jobs = [];

  /**
   * @param {{type:string,title:string,user:string,concurrency:number}} meta
   * @param {{serverId:string,name:string}[]} targets
   * @param {(target, report:(message:string)=>void)=>Promise<string|void>} worker 返回值作为成功信息
   */
  function run(meta, targets, worker) {
    const job = {
      id: crypto.randomUUID(),
      type: meta.type,
      title: meta.title,
      user: meta.user,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      items: targets.map((t) => ({ serverId: t.serverId, name: t.name, status: 'pending', message: '' })),
    };
    jobs.unshift(job);
    if (jobs.length > KEEP) jobs.length = KEEP;

    job.promise = mapLimit(targets, meta.concurrency || 3, async (target, i) => {
      const item = job.items[i];
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      try {
        const msg = await worker(target, (m) => (item.message = m));
        item.status = 'success';
        if (msg) item.message = msg;
      } catch (e) {
        item.status = 'failed';
        item.message = e.message || String(e);
      }
      item.finishedAt = new Date().toISOString();
    }).then(() => {
      job.status = job.items.every((it) => it.status === 'success') ? 'success' : 'failed';
      job.finishedAt = new Date().toISOString();
      return job;
    });
    return job;
  }

  const view = ({ promise, ...job }) => job;

  return {
    run,
    view,
    list: () => jobs.map(view),
    get: (id) => jobs.find((j) => j.id === id),
  };
}
