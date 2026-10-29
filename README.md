# Nexus Portal

个人数字入口：统一 Chrome / Edge / iPhone Safari 的浏览器首页，集中打开常用网站与自部署服务。

- 设计基线：`docs/UI style comparison pages (3)` 中的 R1.5（首页）与 R2（设置中心）
- 实施方案：[`docs/phase1-plan.md`](docs/phase1-plan.md)
- 部署细节：[`docs/deploy.md`](docs/deploy.md)（反向代理、备份、浏览器入口设置）
- 验收清单：[`docs/acceptance.md`](docs/acceptance.md)
- 更新日志：[`CHANGELOG.md`](CHANGELOG.md)

## 快速部署（VPS + Docker Compose）

```bash
mkdir -p ~/nexus && cd ~/nexus
curl -fsSLO https://raw.githubusercontent.com/KJoner/nexus-portal/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/KJoner/nexus-portal/main/.env.example -o .env
nano .env               # 填 NEXUS_PASSWORD、NEXUS_SECRET（openssl rand -base64 32），NEXUS_VERSION 写具体版本
docker compose up -d
docker compose ps       # STATUS 显示 healthy 即可
```

容器只监听宿主机的 `127.0.0.1:8787`，再由 Nginx / Caddy 提供 HTTPS，配置见 [`docs/deploy.md`](docs/deploy.md)。

## 镜像

`kjoner/nexus-portal`，一个镜像同时包含前端和服务端，支持 `linux/amd64` 与 `linux/arm64`。

| 标签 | 含义 |
| --- | --- |
| `0.1.0` | 固定版本，生产环境推荐写这个 |
| `0.1` | 0.1.x 的最新补丁版本 |
| `latest` | 最新的**稳定**版本；预发布版本不会覆盖它 |
| `0.2.0-rc.1` | 预发布版本，只有这一个标签 |

- 以非 root 用户（uid 1000）运行，根文件系统只读；所有数据都在 `/data` 卷中（SQLite、上传的壁纸和图标、图标缓存）
- 端口 `8787`，内置健康检查 `GET /api/healthz`
- 前后端同源，所以登录 Cookie、同源校验和实时推送都不需要额外配置跨域

## 目录

```
apps/web         前端（React + TypeScript + Vite + Tailwind）
apps/server      服务端（Hono + SQLite）：配置同步、登录、健康检查、Linkwarden、图标缓存
packages/shared  前后端共用：配置模式、操作归约、搜索模型、状态汇总
e2e              Playwright 端到端测试
scripts          镜像冒烟测试（CI 与本地共用）
.github          CI、发布工作流与 Dependabot
```

## 本地开发

需要 Node.js ≥ 22.12。

```bash
npm install
NEXUS_PASSWORD=至少8位的密码 npm run dev:server   # 服务端 http://127.0.0.1:8787（数据在 ./data）
npm run dev                                      # 前端 http://127.0.0.1:5173，/api 代理到服务端
npm test                                         # 单元 / 组件 / 服务端测试
npm run test:e2e                                 # 构建后跑 Playwright（Chrome、Edge、iPhone WebKit）
npm run typecheck                                # 类型检查
npm run build && npm start                       # 生产构建并由服务端托管前端
```

开发模式下不设 `NEXUS_PASSWORD` 时，服务端会生成临时密码并打印在控制台。

在本机构建并运行镜像：

```bash
docker compose -f compose.yaml -f compose.build.yaml --env-file .env up -d --build
sh scripts/smoke-container.sh nexus-portal:local     # 与 CI 相同的容器冒烟测试
```

## 日常开发流程

1. 在分支上开发，或直接提交到 `main`。推送前建议在本地跑一遍 `npm run typecheck && npm test`。
2. 推送到 `main` 或开 Pull Request 后，**CI** 工作流会自动执行以下检查，**不会发布镜像**：
   - 类型检查、单元测试、生产构建
   - Playwright 端到端测试：Chromium 与 WebKit 模拟的 iPhone。Edge 只在本地 Windows 上测
   - 构建 amd64 镜像并做冒烟测试，再构建一次 arm64 镜像确认能编译通过
3. 只改了 `docs/` 或 Markdown 文件时不会触发 CI。

## 发布新版本

```bash
# 1. 在 CHANGELOG.md 中写好新版本条目：## [0.2.0] - 2026-11-15
git commit -am "发布 0.2.0" && git push origin main
# 2. 等 main 上的 CI 通过后再打标签（标签必须指向 main 上已有的提交）
git tag -a v0.2.0 -m "Nexus Portal v0.2.0"
git push origin v0.2.0
```

推送标签后，**Release** 工作流会依次执行：

1. 校验标签格式，并确认它指向的提交已经在 `main` 上
2. 重新跑完整的 CI 检查
3. 构建镜像，通过冒烟测试之后，才推送 amd64 + arm64 镜像到 Docker Hub
4. 从 Docker Hub 拉取刚推送的镜像，再测一遍
5. 创建 GitHub Release，说明取自 `CHANGELOG.md` 中对应版本的段落，并附上自动生成的变更列表

任何一步失败都不会推送镜像。

- **预发布版本**：用 `v0.2.0-rc.1` 这样的标签。只会推送 `0.2.0-rc.1` 一个标签，GitHub 上标为 Pre-release，不会更新 `latest`。
- **发布失败**：
  - 如果失败发生在推送镜像之前（例如 Secret 没配好），修好配置后在 Actions 页面点 **Re-run failed jobs** 即可。
  - 如果是代码有问题，在 `main` 上修复后发布下一个补丁版本，例如 `v0.2.1`。**不要移动或复用已发布的标签。**

## 更新部署

```bash
cd ~/nexus
# 先备份数据卷（见下方「备份」）
sed -i 's/^NEXUS_VERSION=.*/NEXUS_VERSION=0.2.0/' .env
docker compose pull
docker compose up -d
docker compose ps                      # healthy
docker compose logs --tail 20 nexus    # 第一行会显示「[nexus] 0.2.0 已启动」
```

数据库迁移会在启动时自动执行。浏览器端的 Service Worker 会在下次打开页面时自动更新。

**备份**（升级前务必做一次）：

```bash
docker compose stop
docker run --rm -v nexus_nexus-data:/data -v "$PWD":/backup alpine tar czf /backup/nexus-$(date +%F).tgz -C /data .
docker compose start
```

## 回滚

```bash
sed -i 's/^NEXUS_VERSION=.*/NEXUS_VERSION=0.1.0/' .env
docker compose pull && docker compose up -d
```

如果新版本执行过数据库迁移，旧版本会拒绝启动，日志中显示「数据库版本（N）比当前程序（M）新」。这是为了防止旧程序损坏新格式的数据。此时需要先恢复升级前的备份，再启动旧版本：

```bash
docker compose down
docker run --rm -v nexus_nexus-data:/data -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/nexus-2026-11-15.tgz -C /data'
docker compose up -d
```

## 常见问题排查

| 现象 | 原因与处理 |
| --- | --- |
| `docker compose up` 提示「在 .env 中设置 NEXUS_PASSWORD」 | `.env` 不在 `compose.yaml` 同一目录，或密码、密钥没有填写 |
| 容器反复重启或一直 `unhealthy` | 先看 `docker compose logs nexus`：密码至少 8 位，`NEXUS_SECRET` 至少 16 位 |
| 能登录，但保存时提示「来源不受信任」（403） | 反向代理没有保留 `Host` 请求头。按 `docs/deploy.md` 配置，或在 `.env` 中填写 `NEXUS_PUBLIC_URL` |
| 另一台设备要刷新页面才能看到改动，或服务状态不实时更新 | Nginx 没有对 `/api/events` 关闭缓冲（见 `docs/deploy.md`） |
| 改用宿主机目录挂载后提示无权写入 | 执行 `sudo chown -R 1000:1000 ./data`，因为容器以 uid 1000 运行 |
| 回滚后启动失败，提示「数据库版本……比当前程序新」 | 见上方「回滚」：先恢复升级前的备份 |
| `exec format error` | 宿主机架构不受支持。镜像只提供 amd64 和 arm64，不支持 32 位 ARM |
| 所有服务的健康检查都显示「目标地址不允许检查」 | 检查目标是回环或云元数据地址，这类地址一律拒绝；局域网地址需要 `NEXUS_HEALTH_ALLOW_PRIVATE=true` |
| Release 工作流提示「不在 main 分支上」 | 标签打在了未合并的提交上。此时还没有发布任何东西，可以删除远端标签后重新打：`git push origin :refs/tags/vX.Y.Z` |
| Release 工作流提示「缺少 DOCKERHUB_…」，或 Docker Hub 返回 401 / denied | 在 Settings › Secrets and variables › Actions 中检查 `DOCKERHUB_USERNAME`（变量或 Secret 均可）和 Secret `DOCKERHUB_TOKEN`；令牌权限需要是 Read & Write，且未过期 |
| CI 的端到端测试失败 | 在本次运行页面下载 `playwright-traces`，用 `npx playwright show-trace <文件>` 查看失败过程 |

## 服务端环境变量

| 变量 | 说明 |
| --- | --- |
| `NEXUS_PASSWORD` | 访问密码（≥ 8 位）。生产环境必填；修改后重启即生效，旧会话全部失效 |
| `NEXUS_DATA_DIR` | 数据目录（SQLite、壁纸、图标），生产默认 `/data` |
| `PORT` / `HOST` | 监听地址，默认 `8787`；生产默认监听 `0.0.0.0` |
| `NEXUS_TRUST_PROXY` | 位于反向代理之后时设为 `1`，信任 `X-Forwarded-*`（客户端地址取代理追加的最后一项）。直接对外暴露端口时必须为 `0` |
| `NEXUS_ALLOWED_ORIGINS` | 反代改写了 `Host` 时，填写对外访问地址（如 `https://home.example.com`），逗号分隔 |
| `NEXUS_COOKIE_SECURE` | `auto`（默认，按 https 判断）/ `always` / `never` |
| `NEXUS_SESSION_DAYS` | 会话有效天数，默认 30，使用中自动续期 |
| `NEXUS_SECRET` | 加密服务凭据（Linkwarden 令牌）的密钥，≥ 16 位；未设置时在数据目录生成 `secret.key` |
| `NEXUS_HEALTH_ALLOW_PRIVATE` | 健康检查与集成是否可访问局域网 / Tailscale 地址，默认 `true` |
| `NEXUS_HEALTH_ALLOW_LOOPBACK` | 是否允许访问回环地址，默认 `false` |

Compose 额外读取 `NEXUS_VERSION`（镜像标签）、`NEXUS_IMAGE`、`NEXUS_BIND`、`NEXUS_PORT` 和 `NEXUS_PUBLIC_URL`（会传给 `NEXUS_ALLOWED_ORIGINS`），说明见 [`.env.example`](.env.example)。

## 许可证

[MIT](LICENSE)
