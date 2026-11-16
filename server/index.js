import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const app = createApp(cfg);
const port = await app.listen();
console.log(`[1panel-fleet] 已启动，端口 ${port}${cfg.readOnly ? '（只读模式）' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close().then(() => process.exit(0)));
}
