# Nexus Portal

个人数字入口：统一 Chrome / Edge / iPhone Safari 的浏览器首页，集中打开常用网站与自部署服务。

- 设计基线：`docs/UI style comparison pages (3)` 中的 R1.5（首页）与 R2（设置中心）
- 实施方案：[`docs/phase1-plan.md`](docs/phase1-plan.md)
- 部署细节：[`docs/deploy.md`](docs/deploy.md)（反向代理、备份、浏览器入口设置）
- 验收清单：[`docs/acceptance.md`](docs/acceptance.md)
- 更新日志：[`CHANGELOG.md`](CHANGELOG.md)

## 一键部署（推荐）

需要一台装好 Docker Engine 与 Docker Compose v2 的 Linux 服务器，用 root 或 docker 组用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/KJoner/nexus-portal/main/scripts/deploy.sh -o deploy.sh
bash deploy.sh                       # 首次：询问域名，隐藏输入访问密码，生成 .env 并启动
bash ~/nexus/deploy.sh               # 以后：在任意目录执行都会找到原部署，备份 → 验证备份 → 更新
```

| 命令 | 作用 |
| --- | --- |
| `bash deploy.sh` | 没有部署就安装，已有部署就更新到最新正式版本；版本相同且服务健康时不做任何改动 |
| `--version 0.3.3` | 安装或更新到指定版本（不能低于当前版本，回滚请用 `--restore`） |
| `--install-dir DIR` | 指定部署目录。默认依次识别：正在运行的 Nexus 容器所在目录 → 当前目录 → `~/nexus`（root 为 `/opt/nexus`） |
| `--backup` / `--list-backups` | 立即备份 / 列出备份 |
| `--verify-backup [名称]` | 在隔离的临时容器中还原并启动备份，确认它真的可以恢复 |
| `--restore [名称]` | 恢复备份（默认最近一次）；恢复前会先备份当前状态 |
| `--password` | 修改访问密码（隐藏输入，所有设备需要重新登录） |
| `--status` | 查看部署目录、Compose 文件、容器、数据卷、密码存储方式与备份 |
| `--yes`、`--password-stdin`、`--domain` | 非交互运行时使用；密码只从标准输入读取，不放在命令参数里 |

脚本做了什么，以及它不会做什么：

- **更新流程**：
  1. 先拉取并检查新镜像。
  2. 备份，并在隔离的临时容器里还原、启动这份备份，确认可以恢复。
  3. 更新 `compose.yaml`，把 `.env` 中的版本固定为具体版本号。
  4. 启动并等待健康检查通过。
  5. 任何一步失败都会停下；启动失败时自动回滚到更新前的配置和数据库。
- **备份**：每次更新前一份，存放在部署目录的 `backups/`，只保留最近 3 份；目录权限 700，文件权限 600。备份内容包括：
  - `.env` 和所有 Compose 文件；
  - SQLite 的一致性快照：用 `VACUUM INTO` 生成，服务运行时也不会读到写了一半的数据，并做完整性检查；
  - 上传的壁纸和图标、`secret.key` 等持久化数据。
  - 首次安装不做备份。
- **数据库版本检查**：数据库版本比目标版本新时（即降级）会拒绝，避免旧程序读坏新数据。
- **访问密码**：只以 Argon2id 哈希的形式写入 `.env`（`NEXUS_PASSWORD_HASH`），不保存明文。
  - 旧部署 `.env` 里的明文 `NEXUS_PASSWORD`，会在更新时自动迁移成哈希，登录密码不变，各设备需要重新登录一次。
  - 明文只会留在当次的备份中，随备份轮换自动删除。
- **加密密钥**：`NEXUS_SECRET` 用于加密 Linkwarden 令牌，与访问密码无关。首次安装时自动生成，在终端里只显示一次，请另外保存。
- **Compose 文件**：`compose.yaml` 由脚本维护，本地修改请写在 `compose.override.yaml`，脚本会沿用它。如果 `compose.yaml` 被手动改过，脚本不会覆盖它，而是把新版另存为 `compose.yaml.v<版本>`。
- **不会做的事**：
  - 从不删除数据卷。
  - 不会在同一台主机上重复安装。
  - 不会把密码写进命令参数、日志或屏幕输出。

## 手动部署（VPS + Docker Compose）

```bash
mkdir -p ~/nexus && cd ~/nexus
curl -fsSLO https://raw.githubusercontent.com/KJoner/nexus-portal/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/KJoner/nexus-portal/main/.env.example -o .env && chmod 600 .env
docker run --rm -i --entrypoint node kjoner/nexus-portal:0.3.3 server/cli.mjs hash-password   # 输入密码后按 Ctrl+D，得到哈希
nano .env               # 填 NEXUS_PASSWORD_HASH='上一步的哈希'（单引号）、NEXUS_SECRET（openssl rand -base64 32）、NEXUS_VERSION
docker compose up -d
docker compose ps       # STATUS 显示 healthy 即可
```

容器只监听宿主机的 `127.0.0.1:8787`，再由 Nginx / Caddy 提供 HTTPS，配置见 [`docs/deploy.md`](docs/deploy.md)。

## 镜像

`kjoner/nexus-portal`，一个镜像同时包含前端和服务端，支持 `linux/amd64` 与 `linux/arm64`。

| 标签 | 含义 |
| --- | --- |
| `0.3.3` | 固定版本，生产环境推荐写这个 |
| `0.2` | 0.2.x 的最新补丁版本 |
| `latest` | 最新的**稳定**版本；预发布版本不会覆盖它 |
| `0.2.0-rc.1` | 预发布版本，只有这一个标签 |

- 以非 root 用户（uid 1000）运行，根文件系统只读；所有数据都在 `/data` 卷中（SQLite 及其升级前自动备份、壁纸（含精选图库）、每日一图的临时缓存、上传的图标、图标缓存）
- 端口 `8787`，内置健康检查 `GET /api/healthz`
- 前后端同源，所以登录 Cookie、同源校验和实时推送都不需要额外配置跨域
- 每个版本附带构建来源证明（provenance）和 SBOM

查看正在运行的版本：

```bash
docker compose logs nexus | head -1          # [nexus] 0.3.3 已启动 …
docker image inspect kjoner/nexus-portal:0.3.3 \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'   # 对应的 Git 提交
docker buildx imagetools inspect kjoner/nexus-portal:0.3.3                 # 包含的架构
```

## 目录

```
apps/web         前端（React + TypeScript + Vite + Tailwind）
apps/server      服务端（Hono + SQLite）：配置同步、登录、健康检查、Linkwarden、图标缓存
apps/chrome-extension  Chrome 新标签页扩展（Manifest V3），复用 apps/web 的首页组件，单独发版
packages/shared  前后端共用：配置模式、操作归约、搜索模型、状态汇总、应用目录（src/catalog）
e2e              Playwright 端到端测试
scripts          镜像冒烟测试（CI 与本地共用）
.github          CI、发布工作流与 Dependabot
```

## 应用目录

`packages/shared/src/catalog/catalog.json` 是运营者维护的公共网站模板（v0.4 起，约 140 个常用站点，覆盖搜索、邮箱、AI、办公文档、网盘、开发、学习、设计、视频、音乐、资讯、社区、购物与工具）。

- 用户在「应用目录」中搜索（中文名、英文名、别名、拼音、域名）、按分类筛选、多选后加入自己的收藏库；**默认不固定到首页**，可勾选「同时固定到首页」。
- 加入的是用户自己的副本（记录模板 id 与版本）。目录以后更新不会改动用户已添加的名称、网址、图标或分组。
- 运营者自己的私有服务（例如自托管的 LiteBox、Linkwarden）不进入公共目录、新用户模板或任何接口响应；LiteSync 的地址由 `NEXUS_LITESYNC_URL` 提供，未设置时不显示。
- 修改目录后运行 `npm run catalog:check`（构建与 CI 会自动执行，任何问题都会让构建失败）。`npm run catalog:verify` 联网核对图标是否存在、网址能否打开，并把结果写回 `verification` 字段；被反爬策略拦截的站点会如实记为未通过并注明原因。
- 站点名称与图标仅用于识别，商标归各自所有者；`icon_source` 记录图标来源（dashboard-icons、simple-icons、站点 favicon），发布前请按各图标集的许可核对。

## 收藏库（v0.4）

每个账号的收藏——应用和收藏的网页——保存在服务端的「我的收藏」里，首页只显示你固定的项目。

- 打开「收藏库」页面（首页收藏库面板右上角「管理收藏库」，或访问 `/library`）：按分组浏览、搜索（名称、拼音、域名、标签）、多选后批量移动/加标签/固定/删除，删除的条目进回收站可恢复；数千条也只渲染屏幕上的那几十行。
- **导入书签**：浏览器导出的书签 HTML 作为网页导入到你选的分组：先看预览（可导入、已存在、重复、不支持的地址），书签文件夹名可作为标签保留，导入后可以撤销本次导入。
- **备份与恢复**：「导出」得到 Nexus 收藏库备份（`nexus-collection` 第 2 版 JSON）：分组、条目 id、应用 / 网页类型、目录关联、标签、备注、首页设置（图标、内网地址、别名、隐藏等）、固定顺序，以及上传的自定义图标（PNG 随文件保存；图标库、网站图标、字母图标是无需数据的引用）。在任何账号「导入」这个文件是**恢复**：先预览新建的分组、条目、固定和图标，已在收藏库的网址可选跳过 / 用备份更新 / 两条都保留；恢复在一个事务里完成，失败什么都不留下；「撤销本次恢复」只撤回这次新建且之后没被编辑过的条目，以及这次新建、现在为空的分组和这次加上的固定。旧版本（第 1 版）的备份也能恢复，但没有首页设置和图标图片。
- 同一网址重复保存会提示「更新原来那条」或「另存一条」；网址的查询参数和锚点原样保留。
- 接口：`/api/v2/items`、`/api/v2/pins`、`/api/v2/snapshot`、`/api/v2/changes`（opId 幂等、字段级冲突检测、删除墓碑、增量游标），旧的首页配置接口继续可用。

## Chrome / Edge 浏览器扩展

`apps/chrome-extension` 把新标签页换成你的 Nexus 导航，并可以一键把网页收进收藏库。

- 页面随扩展打包，打开时直接读取本地缓存，再在后台与服务端同步。
- 工具栏按钮：预填当前页的标题和网址，选择分组、标签，可勾选「固定到首页」（默认不勾）。右键菜单「收藏当前页面到 Nexus」「收藏此链接到 Nexus」（取的是链接本身的地址）。断网时先存在本机，联网后用同一个 opId 发送，不会重复。
- 授权使用可撤销的设备令牌：扩展发起连接后，在门户中核对连接码、查看并确认申请的权限（可以只批准一部分）。0.1.x 的只读授权不会被自动扩大，需要在扩展设置里「授权收藏」。
- 权限只有 `storage`、`activeTab`、`contextMenus` 和你连接的那一个服务器地址。
- 需要服务端 0.3.0 或更高版本；收藏网页需要 0.4.0。Chrome、Edge 与 Firefox（桌面版 140+）分别打包（`nexus-portal-chrome-*.zip` / `nexus-portal-edge-*.zip` / `nexus-portal-firefox-*.zip`）；Firefox 版本已通过 Mozilla 附加组件检查，尚未在真实 Firefox 中安装验证。

安装（Windows / macOS 的 Chrome）：

1. 从 Releases 下载 `nexus-portal-chrome-vX.Y.Z.zip`（`ext-v` 前缀的版本）。
2. 打开 `chrome://extensions`，开启「开发者模式」，把 ZIP 拖到这个页面上。

更新时同样拖入新的 ZIP，连接和缓存都会保留。

连接方法、更新说明、缓存与安全设计、发布流程、手动验收与上架 Chrome Web Store 的准备，见 [docs/extension.md](docs/extension.md)。

## 本地开发

需要 Node.js ≥ 22.12。

```bash
npm install
NEXUS_PASSWORD=至少8位的密码 npm run dev:server   # 服务端 http://127.0.0.1:8787（数据在 ./data）
npm run dev                                      # 前端 http://127.0.0.1:5173，/api 代理到服务端
npm test                                         # 单元 / 组件 / 服务端测试
npm run test:e2e                                 # 构建后跑 Playwright（Chrome、Edge、iPhone WebKit）
npm run typecheck                                # 类型检查
npm run package -w @nexus/chrome-extension       # 构建 Chrome 扩展并打包 ZIP（apps/chrome-extension/release）
npx playwright test --project=extension          # 扩展端到端测试（先 npm run build）
npm run build && npm start                       # 生产构建并由服务端托管前端
```

开发模式下不设 `NEXUS_PASSWORD` 时，服务端会生成临时密码并打印在控制台。

在本机构建并运行镜像：

```bash
docker compose -f compose.yaml -f compose.build.yaml --env-file .env up -d --build
sh scripts/smoke-container.sh nexus-portal:local     # 与 CI 相同的容器冒烟测试（临时容器和数据卷，测完删除）
SMOKE_PASSWORD=… node scripts/smoke.mjs https://home.example.com   # 也可以检查正式实例：只写入一次并立即还原
```

## 日常开发流程

1. 在分支上开发，或直接提交到 `main`。推送前建议在本地跑一遍 `npm run typecheck && npm test`。
2. 推送到 `main` 或开 Pull Request 后，**CI** 工作流会自动执行以下检查，**不会发布镜像**：
   - 类型检查、单元测试、生产构建
   - Playwright 端到端测试：Chromium 与 WebKit 模拟的 iPhone。Edge 只在本地 Windows 上测
   - 构建 amd64 镜像并做冒烟测试，再构建一次 arm64 镜像确认能编译通过
3. 只改了 `docs/` 或 Markdown 文件时不会触发 CI。需要手动运行时，在 Actions › CI 中点 **Run workflow**。
   - Chrome 扩展有自己的工作流 **Chrome extension**：改动扩展、它复用的前端代码、`packages/shared` 或服务端时运行，检查、端到端测试并打包 ZIP（Artifacts 中下载）。
   - 只改扩展时不运行主 CI；`ext-vX.Y.Z` 标签只发布扩展的 GitHub Release，不会发布镜像。
4. 用户能感知到的改动，顺手记在 `CHANGELOG.md` 的「未发布」一节下，发布时再改成版本号。

## 发布新版本

**一次性配置**（已完成）：仓库 Settings › Secrets and variables › Actions 中，需要有 Secret `DOCKERHUB_TOKEN` 和 `DOCKERHUB_USERNAME`。

- `DOCKERHUB_TOKEN` 是 Docker Hub 的个人访问令牌，权限为 Read & Write。
- `DOCKERHUB_USERNAME` 也可以改成 Variable，这样日志里不会把 `kjoner` 显示为 `***`。
- 想更严格的话：新建 `release` 环境，只允许 `v*` 标签使用，再把令牌移到这个环境的 Secrets 中；还可以把自己设为审批人，每次推送镜像前手动批准。

```bash
# 1. 在 CHANGELOG.md 中把「未发布」的内容整理成新版本条目：## [0.2.0] - 2026-11-15
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

任何一步失败都不会推送镜像。整个过程大约 4～5 分钟，完成后检查：

- **镜像**：Docker Hub 上有 `X.Y.Z`、`X.Y`、`latest` 三个标签，指向同一个 digest，并包含 amd64 和 arm64。
- **Release**：GitHub 上出现对应的 Release，并标为 Latest。

- **预发布版本**：用 `v0.2.0-rc.1` 这样的标签。只会推送 `0.2.0-rc.1` 一个标签，GitHub 上标为 Pre-release，不会更新 `latest`。
- **发布失败**：
  - 如果失败发生在推送镜像之前（例如 Secret 没配好），修好配置后在 Actions 页面点 **Re-run failed jobs** 即可。
  - 如果是代码有问题，在 `main` 上修复后发布下一个补丁版本，例如 `v0.3.1`。**不要移动或复用已发布的标签。**

## 更新部署

推荐直接运行 `bash deploy.sh`（见上方「一键部署」）。下面是手动步骤：

```bash
cd ~/nexus
# 先备份数据卷（见下方「备份」）
sed -i 's/^NEXUS_VERSION=.*/NEXUS_VERSION=0.3.3/' .env
docker compose pull
docker compose up -d
docker compose ps                      # healthy
docker compose logs --tail 20 nexus    # 第一行会显示「[nexus] 0.3.3 已启动」
```

数据库迁移会在启动时自动执行。浏览器端的 Service Worker 会在下次打开页面时自动更新。

从 v0.2 起，需要迁移数据库时，Nexus 会先把旧数据库完整复制到数据卷里的 `backups/nexus-v<旧版本号>-<时间>.db`（只保留最近 5 份），日志中会显示「升级数据库前已自动备份」。这份备份只包含数据库（应用、分类、设置、壁纸记录等），不包含壁纸和图标文件，所以升级前仍建议做一次下面的完整备份。

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

**没有手动备份时，用升级前的自动备份回滚**（例如从 0.2.x 回到 0.1.0）：

```bash
docker compose down
docker run --rm -v nexus_nexus-data:/data alpine sh -c '
  ls -t /data/backups/
  cp "$(ls -t /data/backups/nexus-v3-*.db | head -1)" /data/nexus.db
  rm -f /data/nexus.db-wal /data/nexus.db-shm
  chown 1000:1000 /data/nexus.db'
sed -i 's/^NEXUS_VERSION=.*/NEXUS_VERSION=0.1.0/' .env
docker compose up -d
```

- `nexus-v3-…` 中的 3 是 v0.1.x 的数据库版本。
- 必须删除 `-wal` 和 `-shm` 两个文件：它们属于新版本的数据库。
- `chown` 是因为 alpine 以 root 身份复制，而 Nexus 以 uid 1000 运行。
- 升级之后做的修改（例如新增的固定项、壁纸）会随回滚一起丢失。
- 这一流程在发布 v0.2.0 前用真实的 0.1.0 镜像演练过：升级后数据完整；0.1.0 拒绝打开新数据库；恢复备份后，配置与升级前完全一致。

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
| 推送后 CI 没有运行 | 只改了文档（按设计跳过），或者是强制推送，GitHub 无法比较改动。在 Actions › CI 中点 **Run workflow** 手动运行 |
| 推送被拒：`refusing to allow an OAuth App to create or update workflow … without workflow scope` | 推送用的令牌没有 `workflow` 权限，无法修改 `.github/workflows`。执行 `gh auth refresh -s workflow`，或改用 Git 自带的凭据管理器 |

## 长期维护

- **GitHub Actions 版本**：Dependabot 每周检查一次，有新版本时自动开 PR 更新固定的提交 SHA。CI 通过后合并即可。
- **基础镜像安全更新**：每次发布都会重新拉取最新的 `node:22-alpine`。如果长时间没有新功能，也可以定期发一个补丁版本（如 `v0.1.1`）来获取系统安全修复。
- **Node.js 版本**：Node 22 维护期到 2027 年 4 月。到期前把 `Dockerfile` 里的 `NODE_IMAGE` 和 CI 中的 `node-version` 一起升级，再发布新版本。
- **Docker Hub 令牌**：到期前生成新令牌，更新仓库 Secret `DOCKERHUB_TOKEN`。

## 公开部署：多账号与统一身份（v0.4，可选）

不做任何设置时，Nexus 仍是自托管的单用户门户（SQLite + 访问密码），升级后数据、设置与已连接的扩展都不变。要让其他人注册使用：

1. 按 [`infra/identity/README.md`](infra/identity/README.md) 部署统一身份（Keycloak）与 PostgreSQL——LiteSync 与 Nexus 共用同一个账号中心，各自只在自己的服务端完成登录。
2. 已有数据先迁到 PostgreSQL（[`docs/deploy.md`](docs/deploy.md#8-迁移到-postgresql公开部署)：演练 → 正式 → 核对报告；SQLite 文件不会被改动，可随时回退）。
3. 设置 `NEXUS_PUBLIC_URL`、`NEXUS_OIDC_*`、`NEXUS_DATABASE_URL`，注册方式先用 `invite`。
4. 管理员用访问密码登录，在「设置 › 数据、同步与安全」点「绑定统一账号」（旧管理员认领）；之后用统一账号登录，口令登录自动关闭。邀请码、停用账号也在这一页。

账号之间完全隔离：收藏、图标、壁纸、设备、事件流和本机缓存都按账号分开。服务状态、健康检查和 Linkwarden 只属于管理员；公开部署默认不让服务器访问内网地址。浏览器扩展按连接时批准的范围（默认只读）访问，旧扩展的权限不会被自动扩大。

## 服务端环境变量

| 变量 | 说明 |
| --- | --- |
| `NEXUS_PASSWORD_HASH` | 访问密码的 Argon2id 哈希（PHC 格式，由 `deploy.sh` 或 `cli.mjs hash-password` 生成）。修改后重启即生效，旧会话全部失效 |
| `NEXUS_PASSWORD` | 旧版写法：明文访问密码（≥ 8 位），仍然兼容；同时设置了哈希时忽略它。两者都没有时，沿用数据库中已保存的密码 |
| `NEXUS_DATA_DIR` | 数据目录（SQLite、壁纸、图标），生产默认 `/data` |
| `PORT` / `HOST` | 监听地址，默认 `8787`；生产默认监听 `0.0.0.0` |
| `NEXUS_TRUST_PROXY` | 位于反向代理之后时设为 `1`，信任 `X-Forwarded-*`（客户端地址取代理追加的最后一项）。直接对外暴露端口时必须为 `0` |
| `NEXUS_ALLOWED_ORIGINS` | 反代改写了 `Host` 时，填写对外访问地址（如 `https://home.example.com`），逗号分隔 |
| `NEXUS_COOKIE_SECURE` | `auto`（默认，按 https 判断）/ `always` / `never` |
| `NEXUS_SESSION_DAYS` | 会话有效天数，默认 30，使用中自动续期 |
| `NEXUS_SECRET` | 加密服务凭据（Linkwarden 令牌）的密钥，≥ 16 位；未设置时在数据目录生成 `secret.key` |
| `NEXUS_HEALTH_ALLOW_PRIVATE` | 健康检查与集成是否可访问局域网 / Tailscale 地址。未设置时：自托管（未配置统一身份）为 `true`，公开部署为 `false` |
| `NEXUS_HEALTH_ALLOW_LOOPBACK` | 是否允许访问回环地址，默认 `false` |
| `NEXUS_UNSPLASH_ACCESS_KEY` | 可选。填写后，外观设置中出现 Unsplash 壁纸来源；Key 只在服务器使用，每个部署需自行申请 |
| `NEXUS_LITESYNC_URL` | 可选（v0.4）。本部署的 LiteSync 地址（https）。设置后应用目录里才出现 LiteSync，用户自己选择是否添加，任何人都不会被自动固定 |
| `NEXUS_PUBLIC_URL` | v0.4 起服务端也读取：统一身份的回调地址（`/auth/callback`）、退出后的回跳地址由它生成；配置了统一身份时必填，生产环境必须 https |
| `NEXUS_DATABASE_URL` | 可选（v0.4）。PostgreSQL 连接串；未设置时使用数据目录里的 SQLite。从 SQLite 迁移见 [`docs/deploy.md`](docs/deploy.md#8-迁移到-postgresql公开部署) |
| `NEXUS_OIDC_ISSUER` / `NEXUS_OIDC_CLIENT_ID` / `NEXUS_OIDC_CLIENT_SECRET` | 可选（v0.4）。统一身份（OIDC，授权码 + PKCE，只在服务端完成）。三者与 `NEXUS_PUBLIC_URL` 一起设置后开启多账号 |
| `NEXUS_REGISTRATION_MODE` | `closed` / `invite`（默认）/ `open`：新身份第一次进入时能否建立 Nexus 账号 |
| `NEXUS_LEGACY_PASSWORD_LOGIN` | `auto`（默认：管理员绑定统一账号后关闭访问密码登录）/ `on` / `off`；未配置统一身份时始终可用 |
| `NEXUS_QUOTA_ITEMS` / `NEXUS_QUOTA_WALLPAPERS` / `NEXUS_QUOTA_ICONS` / `NEXUS_QUOTA_STORAGE_MB` | v0.4：管理员以外每个账号的上限，默认 5000 条收藏、50 张壁纸、200 个图标、200 MB。超出返回 `QUOTA_EXCEEDED`（不重试）；请求过快返回 `429 RATE_LIMITED` + `Retry-After`。配置本身的上限固定：500 个应用、50 个分类、30 个搜索引擎、36 个固定 |
| `NEXUS_MAIL_PROVIDER` | 产品通知邮件：`log`（默认，只写日志）/ `smtp`（`NEXUS_SMTP_URL`）/ `resend`（`NEXUS_RESEND_API_KEY`）；发件人 `NEXUS_MAIL_FROM`，回复地址 `NEXUS_MAIL_REPLY_TO` |

Compose 额外读取 `NEXUS_VERSION`（镜像标签）、`NEXUS_IMAGE`、`NEXUS_BIND`、`NEXUS_PORT`；`NEXUS_PUBLIC_URL` 同时传给 `NEXUS_ALLOWED_ORIGINS`。说明见 [`.env.example`](.env.example)。

## 许可证

[MIT](LICENSE)
