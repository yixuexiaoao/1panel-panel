# Changelog

## 0.1.1 - 2026-11-16

### 修复
- 面板鉴权失败原因识别错误：原先用 `IP`、`Key` 等短词匹配面板返回的文案，而 “API” 本身含 “IP”，在真实面板上会把所有鉴权失败都误报为“IP 不在白名单”。现按上游 `ErrApiConfig*` 键名及中 / 繁 / 英文案识别

### 新增
- 401 诊断：区分 API Key 不正确、已过期、时间戳无效、IP 不在白名单、未开启 API 接口、接口禁止 API 调用；识别成功时附带面板原文；无法识别时给出排查清单
- 根据面板响应的 `Date` 头估算两端时间差，超过 60 秒时在提示中写明“本机比面板快 / 慢约 N 秒”
- 面板返回 HTML 页面时，提示检查地址是否带了安全入口路径、反向代理是否转发 `/api/v2`
- GitHub Actions 工作流 `.github/workflows/docker.yml`：推送到 main 时先跑测试，再构建 amd64 + arm64 镜像并推送到 Docker Hub（`<DOCKERHUB_USERNAME>/1panel-panel`，标签为版本号和 `latest`），需要 `DOCKERHUB_USERNAME`（Variables 或 Secrets）与 `DOCKERHUB_TOKEN`（建议放 Secrets，放在 Variables 时运行日志会给出警告）

### 行为调整
- 请求面板时固定发送 `Accept-Language: zh`，面板错误信息统一为中文
- 1Panel v2.5 起支持多 API Key：Key 匹配不到时会回退到旧版单 Key 配置，此时面板返回“API 接口禁止访问”。对应提示改为“API Key 不正确，或面板未开启 API 接口 / 该 Key 已停用”
- 模拟面板与上游保持一致：鉴权失败返回 HTTP 200 + `code: 401` 及翻译后的文案，检查顺序为 开关 → 时间戳 → 密钥 → IP；可模拟时钟偏差、API 关闭、IP 不在白名单、返回 HTML 页面

### 测试与验证
- `npm test`：20 项全部通过（新增 401 诊断纯函数用例、对模拟面板逐项触发鉴权失败的用例）
- 真实面板联调（1Panel v2.5.1，单台）：状态（版本、系统、CPU / 内存 / 磁盘 / 负载、容器数、升级检查）读取正常；容器与 Compose 列表读取正常（该机暂无容器，列表为空）；用无效 Key 验证鉴权失败提示准确。仅做只读操作，未在真实面板上执行升级、容器或 Compose 变更
- GUI 验证：已在内置浏览器对本地演示实例查看服务器列表，离线原因显示新文案；真实面板服务器在线状态显示正常
- `/code-review`（low）：无问题

### 未解决 / 风险
- 时间戳无效、IP 不在白名单、Key 过期三种情况只在模拟面板上验证过，未在真实面板上触发
- 变更类接口（升级、容器、Compose、拉取镜像）仍未在真实面板上验证

### 开源参考
- [IsKenKenYa/1Panel-Client](https://github.com/IsKenKenYa/1Panel-Client)，GPL-3.0：借鉴 401 诊断思路（时间偏差、HTML 响应识别、排查清单），未引用源码
- [1Panel-dev/1Panel](https://github.com/1Panel-dev/1Panel) `dev-v2`，GPL-3.0：依据 `core/app/auth/api_auth.go`、`api_key.go`、`core/i18n/lang/*.yaml` 确认鉴权检查顺序与返回文案，未引用源码

## 0.1.0 - 2026-11-16（首个版本，尚未在真实 1Panel 上验证，不视为稳定版）

### 新增
- 服务器管理：添加 / 编辑 / 删除、分组、搜索；后台轮询在线状态、版本、系统信息、CPU / 内存 / 磁盘 / 负载、容器数
- 面板批量升级：检查更新、多选升级、逐台进度、升级后轮询版本确认、超时与疑似回滚判定、同一服务器防重复提交
- 容器：跨服务器列表与筛选，启动 / 停止 / 重启 / 删除（支持批量），升级镜像，多服务器创建容器
- Compose：跨服务器列表，up / restart / stop / down，多服务器部署
- 多服务器批量拉取镜像
- 任务页与操作日志
- 单管理员登录、只读模式（`READ_ONLY`）
- Dockerfile 与 docker-compose.yml（非 root、只读根文件系统）

### 测试与验证
- `npm test`：18 项全部通过（基于模拟面板，覆盖鉴权签名、加密存储、登录与锁定、CSRF、服务器增改删、容器与 Compose 操作、升级成功 / 已最新 / 超时、只读模式、静态资源与安全头）
- GUI 验证：已在内置浏览器对本地演示实例（模拟面板）走通登录、服务器总览、批量升级、容器列表、创建容器
- 未执行：Docker 镜像构建（开发机未安装 Docker）；对真实 1Panel v2 面板的联调

### 未解决 / 风险
- 接口路径与请求体来自官方源码 `dev-v2` 分支，未在真实面板上实测；不同 v2 小版本的字段可能有差异
- 创建容器 / 部署 Compose / 拉取镜像只确认“已提交”，未跟踪面板侧后台任务的最终结果

### 开源参考
- [1Panel-dev/1Panel](https://github.com/1Panel-dev/1Panel)，GPL-3.0：参考 API 路由与 DTO 定义（接口契约），未引用源码
- [1Panel-dev/mcp-1panel](https://github.com/1Panel-dev/mcp-1panel)，GPL-3.0：借鉴访问级别分级（只读 / 读写）的思路
- [IsKenKenYa/1Panel-Client](https://github.com/IsKenKenYa/1Panel-Client)，GPL-3.0：借鉴 API 客户端按模块组织、统一鉴权与错误封装的思路
