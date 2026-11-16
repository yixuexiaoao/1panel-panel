// 本地演示：启动 3 个模拟面板 + 本程序，数据放在临时目录，不接触任何真实服务器。
// 用法：node test/demo.js   然后访问 http://localhost:8090 ，账号 admin，密码见下方 DEMO_PASSWORD
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { createMockPanel } from './mock-panel.js';

const DEMO_PASSWORD = 'demo-only-password';
const KEY = 'demo-api-key';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opf-demo-'));
const cfg = { ...loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: DEMO_PASSWORD, PORT: process.env.PORT || '8090', POLL_INTERVAL: '20' }), upgradePollMs: 1000 };
const app = createApp(cfg);

const panels = [
  ['香港-01', '生产', createMockPanel({ apiKey: KEY, upgradeDelayMs: 4000 }), KEY],
  ['东京-02', '生产', createMockPanel({ apiKey: KEY, version: 'v2.0.6', upgradeDelayMs: 4000 }), KEY],
  ['测试机', '测试', createMockPanel({ apiKey: KEY, upgradeDelayMs: 4000 }), 'wrong-key'],
];
for (const [name, group, panel, key] of panels) {
  const url = await panel.listen();
  app.store.addServer({ name, url, group, note: '', keyId: '', skipTls: false, apiKeyEnc: app.store.encrypt(key) });
}
const port = await app.listen();
console.log(`demo ready: http://localhost:${port}`);
