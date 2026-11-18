# 1Panel Fleet

用一个 Web 界面批量管理多台 **1Panel v2** 服务器：查看运行状态、批量升级面板、管理与部署容器。

- 无 agent：只调用各面板自带的 HTTP API，服务器上不需要装任何东西
- 单容器部署，零第三方依赖（Node.js 标准库 + 原生 JS 前端）
- 适用于 1Panel 社区版，不依赖 Pro 的多节点功能

## 功能

| 模块 | 内容 |
|---|---|
| 服务器 | 分组、搜索；在线状态、面板版本、系统、CPU / 内存 / 磁盘 / 负载、容器数；离线时显示具体原因 |
| 单机管理 | 点击服务器名称进入概览、容器、Compose、文件及定时任务，提供原面板入口 |
| 面板升级 | 检查可用更新；勾选多台批量升级，逐台显示进度，升级后轮询确认版本号才算成功 |
| 容器 | 跨服务器查看与筛选；启动 / 停止 / 重启 / 删除（可多选批量）；更换或更新镜像；向多台服务器创建同一容器 |
| Compose | 跨服务器查看编排；up / restart / stop / down；把同一份 compose 文件部署到多台服务器 |
| 镜像 | 向多台服务器批量拉取镜像 |
| 文件 | 目录导航、收藏、筛选、上传与下载、文本编辑、新建、重命名、复制、移动、权限与属主、压缩、解压及删除 |
| 定时任务 | 单机查看和启停任务、手动运行，查看执行记录与日志，删除任务 |
| 任务 | 所有批量操作逐台记录成功 / 失败及原因，单台失败不影响其余 |
| 操作日志 | 记录登录与全部变更操作（时间、用户、来源 IP） |

## 部署

需要 Docker 与 Docker Compose。

```bash
cp .env.example .env
```

编辑 `.env`，至少设置 `ADMIN_PASSWORD`，然后：

```bash
docker compose up -d --build
```

访问 `http://127.0.0.1:8080`，用 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。

`docker-compose.yml` 默认只监听本机 `127.0.0.1`。需要远程访问时，建议在前面加一层 HTTPS 反向代理，并在 `.env` 中设置 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。本程序保存着所有面板的 API Key，不要直接以明文 HTTP 暴露到公网。

### 在每台 1Panel 上的准备

1. 进入 **面板设置 → API 接口**，开启 API，复制 API Key。
2. 在 **IP 白名单** 中加入运行本程序的机器的出口 IP。
3. 保证两端时间同步（面板会校验时间戳）。

然后在本程序中点击“添加服务器”，填写面板地址（如 `https://example.com:10086`，不带安全入口路径）和 API Key。面板用自签名证书时勾选“跳过 TLS 证书校验”。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USER` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | 空 | 管理员密码。留空时首次启动生成随机密码并打印到容器日志（只打印一次） |
| `SECRET_KEY` | 空 | 加密 API Key 的主密钥。留空则自动生成并保存到 `/data/secret.key`。设置后不要更改 |
| `READ_ONLY` | `false` | 为 `true` 时禁止一切变更，只能查看与刷新 |
| `POLL_INTERVAL` | `60` | 状态轮询间隔（秒），`0` 关闭后台轮询 |
| `UPGRADE_CHECK_HOURS` | `6` | 自动检查面板更新的间隔（小时） |
| `UPGRADE_TIMEOUT` | `900` | 单台升级等待上限（秒） |
| `UPGRADE_CONCURRENCY` | `3` | 同时升级的服务器数 |
| `REQUEST_TIMEOUT` | `15` | 状态查询超时（秒） |
| `COOKIE_SECURE` | `false` | 经 HTTPS 访问时设为 `true` |
| `TRUST_PROXY` | `false` | 位于反向代理之后时设为 `true`，用 `X-Forwarded-For` 作为来源 IP |
| `SESSION_TTL_HOURS` | `12` | 登录有效期 |

### 数据与备份

所有数据在卷 `fleet-data`（容器内 `/data`）：`data.json`（服务器列表、加密后的 API Key 和自定义模板、操作日志）和 `secret.key`（未设置 `SECRET_KEY` 时的主密钥）。备份时两者要一起保存。升级到 0.1.2 时会加密已有模板并清除历史命令审计中的脚本正文。旧备份仍可能含有明文。

## 安全设计

- 面板 API Key 以 AES-256-GCM 加密落盘，任何接口都不会把它返回给浏览器
- 登录会话使用 `HttpOnly` + `SameSite=Strict` Cookie；写请求要求自定义请求头以防 CSRF；同一 IP 连续 5 次登录失败锁定 15 分钟
- 页面启用严格 CSP，来自面板的内容一律按纯文本渲染
- 容器以非 root 用户、只读根文件系统、去除全部 capabilities 运行
- `READ_ONLY=true` 可作为只看不动的巡检模式

## 已知限制

- 仅支持 1Panel v2（接口前缀 `/api/v2`），不支持 v1
- 创建容器、部署 Compose、拉取镜像在面板侧是后台任务：本程序显示“已提交”，实际拉取与启动结果需在列表刷新后或面板任务中心确认
- 容器日志和终端可通过单机管理页的“打开原面板”使用。操作模板和批量命令目前提供后端接口
- 文件编辑限文本，保存请求含文件路径和 JSON 编码在内最多 1 MiB
- 单文件上传上限 100 MiB。反向代理和面板可能配置更小的上限。压缩支持 ZIP 和 TAR.GZ，解压格式取决于面板所在主机安装的工具
- 文件删除先查询远端路径再提交删除，依赖面板在执行删除时处理两次调用之间的远端文件变化
- 批量任务记录只在内存中，程序重启后清空（操作日志会保留）
- 单管理员账号，无多用户与权限分级

### API 覆盖范围

Fleet 目前集成服务器状态与升级、容器与 Compose、镜像拉取、定时任务，以及上表中的文件操作。回收站、文件历史和分享，以及网站、证书、数据库、应用商店、备份、防火墙、运行环境和面板设置等功能仍通过原面板操作。API 可用性由面板版本、版本授权和 API Key 权限共同决定。

## 开发

需要 Node.js 22 及以上，无需 `npm install`。

```bash
npm test
```

测试使用 `test/mock-panel.js` 模拟 1Panel v2 接口，不会连接任何真实服务器。

```bash
node test/demo.js
```

启动带 3 个模拟面板的本地演示（端口 8090，演示密码见 `test/demo.js`）。

## 参考

接口路径与请求体依据 [1Panel-dev/1Panel](https://github.com/1Panel-dev/1Panel)（GPL-3.0）`dev-v2` 分支的路由与 DTO 定义编写，仅参考接口契约，未复制其源码。设计上借鉴了 [1Panel-dev/mcp-1panel](https://github.com/1Panel-dev/mcp-1panel) 的只读 / 读写分级，以及 [IsKenKenYa/1Panel-Client](https://github.com/IsKenKenYa/1Panel-Client) 的按模块组织 API 客户端的思路。
