# Changelog

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
