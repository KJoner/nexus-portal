# 统一身份与共享数据库（Keycloak + PostgreSQL）

LiteSync 与 Nexus Portal 共用一个账号：用户只注册一次，邮箱验证、找回登录密码、账号安全都由这里的 Keycloak 负责；两个产品各自是一个 OIDC 客户端，只在自己的服务端完成登录（授权码 + PKCE），各自保持独立的会话和权限。决策依据见 ADR-011（统一身份与产品会话）与 ADR-018（数据库路线与邮件）。

> 状态：**已在本机容器环境实测，尚未在生产环境运行过**。2026-11-21 用本目录的 compose（Keycloak 26.8.1 + PostgreSQL 17.10，合成数据、随机密钥，只绑 127.0.0.1）完成：realm 导入与 28 项设置回读、数据库角色隔离、Nexus 真实浏览器登录 / 注册（经本机收信器的真实验证邮件）/ back-channel logout / 退出所有设备 / 旧管理员认领，见下文「本机冒烟」。同日（ADR-019）用一次性 Keycloak 26.8.1（start-dev）：新模板导入后回读 52/52；旧模板导入后 `configure.sh revocation`（执行两次）再回读 52/52；Nexus 生产构建对它跑动作 C / D 14/14。真实域名与 HTTPS、真实邮件投递（各家邮箱的收件箱/垃圾箱）、与 LiteSync 的跨产品联调仍需按「上线前验证」逐项实测并记录。

## 组成

| 服务 | 镜像 | 说明 |
|---|---|---|
| postgres | `postgres:17.10-alpine` | 一个实例，三个库三个角色：`keycloak/keycloak`、`nexus/nexus_app`、`litesync/litesync_app`（预留给批次 G）。角色之间没有连接权限 |
| keycloak | `quay.io/keycloak/keycloak:26.8.1` | realm `accounts`：自助注册、邮箱验证（30 分钟）、找回密码（15 分钟）、暴力破解防护、中文界面；两个 client：`nexus-web`、`litesync-web` |

两个端口都只绑定 `127.0.0.1`，由本机反向代理对外提供 HTTPS（例如 `accounts.example.com → 127.0.0.1:8180`）。数据库不对公网开放。

## 第一次部署

1. `cp .env.example .env && chmod 600 .env`，填写：
   - 三个对外地址（必须是 https，与浏览器里看到的完全一致）；
   - 数据库密码与 Keycloak 临时管理员密码（`openssl rand -base64 32`）；
   - 两个 client secret（随机值；稍后分别写进两个产品的配置）；
   - SMTP（事务邮件服务商的 SMTP relay，发件人用已验证的独立发信子域）。
2. 配置反向代理：`accounts.example.com` → `127.0.0.1:8180`，并传递 `X-Forwarded-For/Proto/Host`（Keycloak 以 `KC_PROXY_HEADERS=xforwarded` 读取它们，所以**不要**让外部请求直接打到 8180）。
3. `docker compose up -d`。首次启动时 postgres 执行 `postgres-init/01-databases.sh` 建库建角色，Keycloak 导入 `realm/accounts-realm.json`（其中的 `${…}` 取自 `.env`）。日志出现 `Realm 'accounts' imported` 才算完成；健康检查同时检查 realm 的发现文档，所以容器变成 healthy 时 realm 一定已经可用（实测 Keycloak 26.8 的 `/health/ready` 会在导入完成前就报告 UP）。realm 只在不存在时导入，之后对模板的修改不会自动生效，日常调整用 `./configure.sh`。
4. 打开 `https://accounts.example.com/admin`，用临时管理员登录 → 在 master realm 建立正式管理员（启用 OTP）→ 删除临时管理员。
5. 在 realm `accounts` 的 Realm settings › Email 点「Test connection」，确认能收到测试邮件。
6. 配置两个产品（见下节）并重启。

## 产品侧配置

**Nexus Portal**（本仓库根目录的 `.env` / compose）：

```
NEXUS_PUBLIC_URL=https://home.example.com
NEXUS_OIDC_ISSUER=https://accounts.example.com/realms/accounts
NEXUS_OIDC_CLIENT_ID=nexus-web
NEXUS_OIDC_CLIENT_SECRET=<与本目录 .env 中相同>
NEXUS_REGISTRATION_MODE=invite          # closed / invite / open，先邀请试运行
NEXUS_DATABASE_URL=postgres://nexus_app:<NEXUS_DB_PASSWORD>@<数据库地址>:5432/nexus
# 已有单用户部署：先按 docs/deploy.md「迁移到 PostgreSQL」演练并迁移，再切换
# 账号撤销（ADR-019，开放公众注册前配置，见下文「会话与退出」）
NEXUS_PEER_REVOCATION_URL=http://litesync:8080      # LiteSync 的内部地址
NEXUS_PEER_REVOCATION_SECRET=<与 LiteSync 相同，openssl rand -hex 32>
NEXUS_IDENTITY_STATUS_CHECK=on                       # 只读服务账号查询停用 / 删除
# NEXUS_IDENTITY_ADMIN_URL=https://accounts.example.com/admin/realms/accounts   # 默认由 issuer 推导
```

**LiteSync**（litesync-server 的 `.env`；变量名以该仓库为准）：

```
OBSYNC_PUBLIC_URL=https://sync.example.com
OBSYNC_OIDC_ISSUER=https://accounts.example.com/realms/accounts
OBSYNC_OIDC_CLIENT_ID=litesync-web
OBSYNC_OIDC_CLIENT_SECRET=<与本目录 .env 中相同>
OBSYNC_REGISTRATION_MODE=invite
OBSYNC_LEGACY_TOKEN_LOGIN=true          # 管理员认领统一账号前保留 API Token 网页登录
OBSYNC_PEER_REVOCATION_URL=http://nexus:8787         # Nexus 的内部地址
OBSYNC_PEER_REVOCATION_SECRET=<与 Nexus 相同>
# 中心停用检查的开关以 litesync-server 的文档为准
```

两个 client 在 realm 模板中已固定为：只允许授权码流程、PKCE 必须 S256、精确回调地址 `https://<产品>/auth/callback`、back-channel logout 地址 `https://<产品>/auth/backchannel-logout`（需要会话 id）、关闭隐式流程、密码直授与设备授权。`fullScopeAllowed=false`：令牌里不带 realm 角色——两个产品都**不从令牌读取角色**，管理员身份只来自各产品自己的「旧管理员认领」。

账号撤销（ADR-019）另外需要三项，模板已经包含，已部署的 realm 用 `./configure.sh revocation` 增量补上（可重复执行）：

| 设置 | 作用 | 权限边界 |
|---|---|---|
| 两个 client 的作用域映射加 `account` 客户端角色 `manage-account`，默认作用域加 `roles` | 用户本人的 access token 带 `aud: account` 与 `manage-account`，产品服务端用它调 Account REST `DELETE {issuer}/account/sessions?current=true`，结束这个用户在**所有浏览器**的会话（动作 C） | 只能管理用户**自己的**账号；令牌只在产品服务端，浏览器拿不到 |
| 两个 client 开启服务账号，服务账号用户只授 realm-management 的 `view-users` | client credentials 换出只读令牌，查询 `GET /admin/realms/accounts/users/{sub}` 的 `enabled`（停用）与 404（删除）（动作 D） | 不能修改用户、不能结束会话（实测都是 403）；不授 `manage-users` |
| 两个 client 的作用域映射加 realm-management 的 `view-users` | `fullScopeAllowed=false` 时令牌只带映射里的角色，服务账号令牌要靠它带上 `view-users` | 普通用户没有这个角色，映射不会给他们任何权限（用户令牌里没有 view-users） |

账号中心自带的「设备活动」页只列出、只退出**浏览器里的账号中心登录**（结束后两个产品的网页随之退出）；已连接的 Obsidian 与浏览器扩展是产品自己发的设备凭据，不在那里，点它不会断开它们。Keycloak 原文「登出所有设备 / 此操作将登出所有已登入您帐号的设备」会让人误以为连 Obsidian 也断开了（2026-11-22 预发布真机验收：点了之后 Obsidian 照常同步）。模板用 realm 本地化覆盖（`localizationTexts`，内容与 `realm/account-texts.<语言>.json` 相同）把这一页改成「网页登录 / 已登录的浏览器 / 退出所有浏览器」，并在说明与确认框里指向产品里的「退出所有产品与设备」；已部署的 realm 用 `./configure.sh texts` 补上（按键合并，可重复执行）。一次性 Keycloak 26.8.1 实测：导入与补设两条路径，账号控制台的导航、标题、按钮和确认框都显示覆盖后的文字。

## 注册开关与紧急关闭

注册是两层：身份服务决定能不能创建账号，各产品决定新身份第一次进入时能不能建立产品账号。

| 模式 | 身份服务（`./configure.sh registration <模式>`） | 产品（`*_REGISTRATION_MODE`） |
|---|---|---|
| `closed` | 关闭自助注册 | 新身份一律「暂未开放注册」，已有账号照常登录 |
| `invite` | 允许注册 | 新身份第一次进入需要一次性邀请码（管理员在产品中生成） |
| `open` | 允许注册 | 新身份直接建立产品账号（空收藏 / 零仓库） |

紧急关闭：两层都切到 `closed` 并重启产品。已登录的会话不受影响；要让某个账号立即失效，在产品中停用它（会撤销该账号的会话、设备与待领取授权），并在 Keycloak 中禁用用户（两个产品都开启了中心停用检查时，只在 Keycloak 中禁用也会在 60 秒内传到两个产品）。

注册流程（Keycloak 26.8 的默认行为，实测）：注册表单只填邮箱和姓名，**没有密码框**；用户点开验证邮件里的链接后才设置登录密码。这样别人无法用你的邮箱预先注册并设好密码。验证链接 30 分钟内有效。

## 会话与退出

退出分四种范围，互不混用（ADR-019）。每个产品为每个账号保存一个只增不减的**授权代次**：网页会话、设备凭据（Nexus 扩展、Obsidian 设备）和待领取授权（Nexus 已批准未领取的配对、LiteSync 未兑换的连接授权）都记下签发时的代次，每次使用都核对；B、C、D 在一个事务里把代次加一，之前签发的一切——包括与退出同时发生的兑换——在下一次请求时失效。

| 动作 | 入口 | 结束什么 | 不影响 |
|---|---|---|---|
| **A 退出此会话** | 产品里的「退出此设备」；Keycloak 的 back-channel logout（带 `sid` 或只带 `sub`） | 本产品的这个网页会话（只带 `sub` 时为本产品该用户的全部网页会话） | 设备、待领取授权、账号中心、另一个产品 |
| **B 退出本产品的全部设备** | 产品账户页「退出 Nexus 的全部设备」/ LiteSync 的同名操作；产品管理员停用账号 | 本产品的全部网页会话 + 全部设备 + 全部待领取授权 | 账号中心、另一个产品 |
| **C 退出所有产品与设备** | 任一产品账户页「退出所有产品与设备」 | B，加上账号中心在**所有浏览器**的会话（用户本人令牌调 Account REST），加上另一个产品的 B（签名的撤销事件） | — |
| **D 中心停用 / 删除** | 管理员在 Keycloak 停用或删除用户 | 每个产品经只读服务账号发现后执行自己的 B | — |

- **A 只是 A**：Keycloak 结束会话（包括 C 之后它对每个会话发出的 back-channel）只结束网页会话，从不撤销设备——普通退出不会断开全部 Obsidian 和扩展。
- **C 的结果逐项如实返回**：本产品（立即完成）、账号中心（失败时给出原因，并提示到账号中心「设备活动」手动退出）、另一个产品（已送达 / 等待确认 / 失败）。另一个产品暂时不可达时，事件留在发件箱里按 5 秒、15 秒、30 秒……重试 7 天；账户页能看到状态并重新发送。签名被拒（两边密钥不一致）不再重试，管理员页面显示原因。
- **跨产品事件**：`POST {对方内部地址}/api/internal/v1/account-revocations`，头 `X-Revocation-Timestamp`（Unix 秒）与 `X-Revocation-Signature: v1=<hex(HMAC-SHA256(密钥的 UTF-8 字节, 时间戳 + "." + 原始请求体))>`；以 `(issuer, subject)` 找账号，绝不使用对方的本地 user_id；时间戳与本机相差超过 5 分钟拒绝；`eventId` 去重；事件只能撤销，不能授予任何权限。地址可以是 compose 网络里的内部地址；挂在公开地址上时依靠签名，并单独限流。两个产品各自只配对方，接收方不转发。
- **中心停用检查（D）**：任一已认证请求到达时，如果该账号上一次成功检查已超过 60 秒，先同步查一次（同一账号并发请求只查一次，3 秒超时）；停用或删除即执行 B，本次请求按撤销返回——中心停用后在线请求最迟 60 秒（加一次检查耗时）内被拒绝。Keycloak 不可达时，上一次成功检查在 15 分钟内则放行并在 60 秒后再试；超过 15 分钟，设备请求返回 `503 IDENTITY_UNAVAILABLE`（可重试，扩展保留待发内容），网页会话按下面的 refresh 复核处理。服务账号缺角色（403）是配置错误，不会被当成停用。
- **未配置时的退化**（启动日志、账户页与管理员页面都会写明）：没有跨产品撤销时，C 只能完成本产品与账号中心两部分，另一个产品显示「未配置」，需要在那边另行执行 B；另一个产品发来的事件一律被拒。没有中心停用检查时，账号在 Keycloak 被停用或删除后，网页会话最迟在下一次 refresh 复核时结束，**设备不会自动撤销**，需要在产品里停用账号或执行 B。**开放公众注册之前两项都必须配置。**
- 产品会话每 5 分钟用 refresh token 向 Keycloak 复核一次：refresh 被拒（会话被结束、账号被停用）时这个网页会话结束（动作 A）；Keycloak 不可达时最多宽限 1 小时。
- SSO 会话空闲 7 天、最长 30 天：超过之后两个产品都需要重新登录。这是可调的取舍（`ssoSessionIdleTimeout` / `ssoSessionMaxLifespan`）。
- 产品内管理员「停用账号」等于对该账号执行 B，并拒绝之后的登录与领取；重新启用只恢复登录资格，不复活任何旧凭据（代次不回退）。
- 已离线的设备（浏览器扩展、Obsidian 插件）无法被远程擦除：它们下一次联网时收到撤销错误，提示「授权已被撤销，请重新连接」，保留本地待发内容，不会换用其他凭据提交。

新增的产品配置（全部可选，未配置时如上退化）：

| Nexus | LiteSync | 说明 |
|---|---|---|
| `NEXUS_PEER_REVOCATION_URL` | `OBSYNC_PEER_REVOCATION_URL` | 对方产品的内部地址（如 `http://litesync:8080` / `http://nexus:8787`） |
| `NEXUS_PEER_REVOCATION_SECRET` | `OBSYNC_PEER_REVOCATION_SECRET` | 两边相同，至少 32 字节随机（`openssl rand -hex 32`），按原样（UTF-8 字节）作为 HMAC 密钥 |
| `NEXUS_IDENTITY_STATUS_CHECK=on` | 以 litesync-server 文档为准 | 开启中心停用检查（用本 client 自己的只读服务账号） |
| `NEXUS_IDENTITY_ADMIN_URL` | 以 litesync-server 文档为准 | 管理接口地址，默认由 issuer 推导：`https://host/realms/accounts` → `https://host/admin/realms/accounts` |

## 邮件与 DNS

- `.env` 中的 SMTP 设置只在首次导入时生效（固定 starttls + 认证）；之后改发信用 `./configure.sh smtp`：`SMTP_SECURITY` 取 `starttls`（587）/ `ssl`（465）/ `none`（仅本机测试收信器），留空按端口选择；`SMTP_USER` 为空时不做 SMTP 认证。
- 身份邮件（验证、找回、换邮箱）由 Keycloak 通过 SMTP 发出；两个产品的通知邮件（新设备连接、退出所有设备等）由各自服务端的发信适配层发出（`NEXUS_MAIL_*` / `OBSYNC_MAIL_*`），可以用同一个服务商。
- 使用独立发信子域（例如 `mail.accounts.example.com`），按服务商给出的记录配置 SPF 与 DKIM，再配置 DMARC。根域已有的 MX 不要替换；同一名称不要出现两条 SPF。
- 「服务商已接收」不等于「进了收件箱」：上线前用 QQ、163、Gmail、Outlook 实测收件箱/垃圾箱与延迟，记录在验收执行记录里。

## LiteSync 库的排序规则（C）

`litesync` 库以字节序（`LC_COLLATE 'C'`、`LC_CTYPE 'C'`，从 `template0` 创建）建立：LiteSync 的文件路径排序和分页游标必须与它的 SQLite（BINARY）逐字节一致，按语言区域排序会让对账漂移，所以 LiteSync 的 PostgreSQL 模式在启动时检查 `datcollate ∈ {C, POSIX, C.UTF-8}`，不满足就拒绝启动。`nexus` 与 `keycloak` 库保持实例默认，不受影响。

用早期模板建过 `litesync` 库的部署（当时库在 LiteSync 迁移前是空的），先检查：

```
docker compose exec -T postgres psql -U postgres -tAc "SELECT datcollate FROM pg_database WHERE datname='litesync'"
```

结果不是 `C` 时，在 LiteSync 迁移进来**之前**删掉重建（库里不能已有数据）：

```
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
DROP DATABASE litesync;
CREATE DATABASE litesync OWNER litesync_app TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
REVOKE CONNECT, TEMPORARY ON DATABASE litesync FROM PUBLIC;
GRANT CONNECT ON DATABASE litesync TO litesync_app;
\c litesync
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO litesync_app;
ALTER SCHEMA public OWNER TO litesync_app;
SQL
```

## 备份与恢复

```
docker compose exec -T postgres pg_dump -U postgres -Fc keycloak > keycloak-$(date +%F).dump
docker compose exec -T postgres pg_dump -U postgres -Fc nexus    > nexus-$(date +%F).dump
```

- 每个库单独备份、单独恢复（`pg_restore -U postgres -d <库> --clean --if-exists`），互不影响。
- Nexus 的壁纸与图标文件仍在 Nexus 的数据卷里，必须与 `nexus` 库**同一时间点**备份；恢复后按「Nexus 迁移报告」核对行数与文件。
- 恢复演练要在一台隔离机器上做，并记录实际耗时（不预填 RTO）。

## 升级

- 本仓库的 realm 模板有了新内容时（例如 ADR-019 账号撤销），已部署的 realm 不会自动变化：按说明运行对应的 `./configure.sh` 子命令（ADR-019 是 `./configure.sh revocation`，可重复执行），再用 `verify-realm.mjs` 在一次性实例上演练回读。
- Keycloak：先备份 `keycloak` 库，再改 compose 中的镜像版本；跨大版本前阅读官方升级说明。
- PostgreSQL：同一大版本内直接换镜像；跨大版本需要 `pg_dump` / `pg_restore`。

## 本机冒烟（合成数据，可重复）

在开发机上用一次性容器把整条链路跑一遍，不需要域名和真实邮箱：

1. 把本目录复制到临时目录，写一个只含随机值的 `.env`：`ACCOUNTS_PUBLIC_URL=http://localhost:28180`、`NEXUS_PUBLIC_URL=http://host.docker.internal:28787`（容器内的 Keycloak 要能回调 Nexus 的 back-channel logout；浏览器端由冒烟脚本把这个名字映射到 127.0.0.1）、`KEYCLOAK_PORT=28180`、`POSTGRES_PORT` 选一个空闲端口（Windows 上避开 `netsh interface ipv4 show excludedportrange protocol=tcp` 列出的保留段）。
2. `COMPOSE_PROJECT_NAME=nexus-idtest docker compose up -d`，等 keycloak 变成 healthy。
3. 本机收信器：`docker run -d --name nexus-mailpit --network nexus-idtest_default -p 127.0.0.1:28025:8025 axllent/mailpit:v1.33.0`；`.env` 里设 `SMTP_HOST=nexus-mailpit`、`SMTP_PORT=1025`、`SMTP_SECURITY=none`、`SMTP_USER=`，再 `./configure.sh smtp`（Windows 的 Git Bash 需加 `MSYS_NO_PATHCONV=1`，否则容器内路径会被改写）。
4. 在 Nexus 仓库根目录 `npm run build`，然后：
   - `node scripts/smoke/verify-realm.mjs <临时目录>`：经管理 API 回读 realm 与两个 client 的安全设置，并实测密码直授、隐式流程、未登记回调地址、缺 PKCE 都会被拒绝；ADR-019 部分回读作用域映射（只有 account/manage-account 与 realm-management/view-users）、服务账号角色（只有 view-users），用管理 API 生成一个合成用户的示例令牌核对 `aud: account` 与 `manage-account`、没有管理角色，再用服务账号实测读到 `enabled`、停用后 `enabled:false`、删除后 404，以及修改用户、结束会话都是 403（共 52 项）；
   - `node scripts/smoke/revocation-smoke.mjs <临时目录> <输出目录>`：Nexus 生产构建（SQLite 临时目录）对这个 Keycloak 跑动作 C 与 D——两个浏览器登录、配对扩展，在账户页执行「退出所有产品与设备」：账号中心该用户的会话 2 → 0、另一个浏览器要重新输密码、扩展令牌失效、签名事件按 ADR 字段顺序送达本机收信器；在 Keycloak 停用用户后扩展在 60 秒内被拒、恢复后旧扩展仍无效（要求 `.env` 里 `NEXUS_PUBLIC_URL=http://127.0.0.1:39410`，占用 39410、39413 端口）；
   - `node scripts/smoke/identity-smoke.mjs <临时目录> <输出目录>`：真实 Chrome 走完登录、回调重放、back-channel logout、退出所有设备、旧管理员认领、注册→验证邮件→设密码→进入 Nexus，并检查 Nexus 日志里没有密钥、令牌和授权码；
   - `node scripts/smoke/pg-migrate-smoke.mjs <输出目录> <PostgreSQL 管理连接串> <新库名>`：SQLite 部署写入合成数据 → `migrate-to-pg` 演练/正式/重复 → 切到 PostgreSQL 后核对配置、文件与设备令牌。
5. 用完清理：`docker rm -f nexus-mailpit && COMPOSE_PROJECT_NAME=nexus-idtest docker compose down -v`。

只验证 realm 与 ADR-019 时不需要 PostgreSQL 和收信器：`docker run -d -p 127.0.0.1:39480:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=temp-admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=… -e NEXUS_PUBLIC_URL=http://127.0.0.1:39410 …（模板里的其余占位符）-v <realm 目录>:/opt/keycloak/data/import:ro quay.io/keycloak/keycloak:26.8.1 start-dev --import-realm`，然后运行上面的 `verify-realm.mjs` 与 `revocation-smoke.mjs`。已有 realm 的增量升级同样可以这样演练：先导入旧模板，再 `KC_EXEC="docker exec -i <容器>" ./configure.sh revocation`（Git Bash 加 `MSYS_NO_PATHCONV=1`），回读应全部通过。

## 上线前验证（逐项实测并记录，未做的写「未执行」）

1. `docker compose config` 通过；首次启动日志里 realm `accounts` 导入成功。
2. 注册 → 收到验证邮件 → 验证 → 在 Nexus 登录 → 在 LiteSync 免密进入（同一浏览器）。
3. 找回密码邮件 15 分钟内有效、只能用一次；重置后旧仓库密码不受影响。
4. 用 `nexus_app` 角色连接 `keycloak` 库 → 被拒绝（MG-02）。
5. 在 Keycloak 中结束用户会话 → 两个产品的会话随即失效（back-channel logout），设备不受影响（动作 A）。
6. 禁用用户 → 两个产品的会话与设备最迟 60 秒内失效（中心停用检查已开启；未开启时会话最迟 5 分钟、设备不自动撤销）。
6a. 在一个产品执行「退出所有产品与设备」→ 账号中心所有浏览器的会话、两个产品的会话、设备与待领取授权全部失效；结果页逐项显示已完成。另一个产品暂停时显示「等待确认」，恢复后在 7 天内自动送达。
7. 四家邮箱的投递结果与 SPF/DKIM/DMARC 检查。
