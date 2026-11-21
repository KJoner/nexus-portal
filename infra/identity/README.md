# 统一身份与共享数据库（Keycloak + PostgreSQL）

LiteSync 与 Nexus Portal 共用一个账号：用户只注册一次，邮箱验证、找回登录密码、账号安全都由这里的 Keycloak 负责；两个产品各自是一个 OIDC 客户端，只在自己的服务端完成登录（授权码 + PKCE），各自保持独立的会话和权限。决策依据见 ADR-011（统一身份与产品会话）与 ADR-018（数据库路线与邮件）。

> 状态：**已在本机容器环境实测，尚未在生产环境运行过**。2026-11-21 用本目录的 compose（Keycloak 26.8.1 + PostgreSQL 17.10，合成数据、随机密钥，只绑 127.0.0.1）完成：realm 导入与 28 项设置回读、数据库角色隔离、Nexus 真实浏览器登录 / 注册（经本机收信器的真实验证邮件）/ back-channel logout / 退出所有设备 / 旧管理员认领，见下文「本机冒烟」。真实域名与 HTTPS、真实邮件投递（各家邮箱的收件箱/垃圾箱）仍需按「上线前验证」逐项实测并记录。

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
```

**LiteSync**（litesync-server 的 `.env`；变量名以该仓库为准）：

```
OBSYNC_PUBLIC_URL=https://sync.example.com
OBSYNC_OIDC_ISSUER=https://accounts.example.com/realms/accounts
OBSYNC_OIDC_CLIENT_ID=litesync-web
OBSYNC_OIDC_CLIENT_SECRET=<与本目录 .env 中相同>
OBSYNC_REGISTRATION_MODE=invite
OBSYNC_LEGACY_TOKEN_LOGIN=true          # 管理员认领统一账号前保留 API Token 网页登录
```

两个 client 在 realm 模板中已固定为：只允许授权码流程、PKCE 必须 S256、精确回调地址 `https://<产品>/auth/callback`、back-channel logout 地址 `https://<产品>/auth/backchannel-logout`（需要会话 id）、关闭隐式流程、密码直授与设备授权。`fullScopeAllowed=false`：令牌里不带 realm 角色——两个产品都**不从令牌读取角色**，管理员身份只来自各产品自己的「旧管理员认领」。

## 注册开关与紧急关闭

注册是两层：身份服务决定能不能创建账号，各产品决定新身份第一次进入时能不能建立产品账号。

| 模式 | 身份服务（`./configure.sh registration <模式>`） | 产品（`*_REGISTRATION_MODE`） |
|---|---|---|
| `closed` | 关闭自助注册 | 新身份一律「暂未开放注册」，已有账号照常登录 |
| `invite` | 允许注册 | 新身份第一次进入需要一次性邀请码（管理员在产品中生成） |
| `open` | 允许注册 | 新身份直接建立产品账号（空收藏 / 零仓库） |

紧急关闭：两层都切到 `closed` 并重启产品。已登录的会话不受影响；要让某个账号立即失效，在产品中停用它（会撤销该账号的会话与设备），并在 Keycloak 中禁用用户。

注册流程（Keycloak 26.8 的默认行为，实测）：注册表单只填邮箱和姓名，**没有密码框**；用户点开验证邮件里的链接后才设置登录密码。这样别人无法用你的邮箱预先注册并设好密码。验证链接 30 分钟内有效。

## 会话与退出

- 产品会话每 5 分钟用 refresh token 向 Keycloak 复核一次：账号被禁用、在别处「退出所有设备」或会话被管理员结束后，产品会话最迟在下一次复核时失效；Keycloak 不可达时最多宽限 1 小时。
- Keycloak 结束会话时会调用各产品的 back-channel logout，立即结束对应的产品会话。
- SSO 会话空闲 7 天、最长 30 天：超过之后两个产品都需要重新登录。这是可调的取舍（`ssoSessionIdleTimeout` / `ssoSessionMaxLifespan`）。
- 产品里的「退出所有设备」结束**该产品**的全部会话与已连接设备，并把当前浏览器带去结束账号中心的会话；**其他浏览器**里账号中心的登录状态不在产品的权限范围内（实测：另一个浏览器点「使用统一账号登录」会直接进入）。要连同账号中心一起全部退出，在账号中心（`https://accounts.example.com/realms/accounts/account`）的「设备活动」里退出所有设备——Keycloak 会通过 back-channel logout 通知两个产品。
- 已离线的设备（浏览器扩展、Obsidian 插件）无法被远程擦除：它们下一次联网时才会发现授权已失效。

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

- Keycloak：先备份 `keycloak` 库，再改 compose 中的镜像版本；跨大版本前阅读官方升级说明。
- PostgreSQL：同一大版本内直接换镜像；跨大版本需要 `pg_dump` / `pg_restore`。

## 本机冒烟（合成数据，可重复）

在开发机上用一次性容器把整条链路跑一遍，不需要域名和真实邮箱：

1. 把本目录复制到临时目录，写一个只含随机值的 `.env`：`ACCOUNTS_PUBLIC_URL=http://localhost:28180`、`NEXUS_PUBLIC_URL=http://host.docker.internal:28787`（容器内的 Keycloak 要能回调 Nexus 的 back-channel logout；浏览器端由冒烟脚本把这个名字映射到 127.0.0.1）、`KEYCLOAK_PORT=28180`、`POSTGRES_PORT` 选一个空闲端口（Windows 上避开 `netsh interface ipv4 show excludedportrange protocol=tcp` 列出的保留段）。
2. `COMPOSE_PROJECT_NAME=nexus-idtest docker compose up -d`，等 keycloak 变成 healthy。
3. 本机收信器：`docker run -d --name nexus-mailpit --network nexus-idtest_default -p 127.0.0.1:28025:8025 axllent/mailpit:v1.33.0`；`.env` 里设 `SMTP_HOST=nexus-mailpit`、`SMTP_PORT=1025`、`SMTP_SECURITY=none`、`SMTP_USER=`，再 `./configure.sh smtp`（Windows 的 Git Bash 需加 `MSYS_NO_PATHCONV=1`，否则容器内路径会被改写）。
4. 在 Nexus 仓库根目录 `npm run build`，然后：
   - `node scripts/smoke/verify-realm.mjs <临时目录>`：经管理 API 回读 realm 与两个 client 的安全设置，并实测密码直授、隐式流程、未登记回调地址、缺 PKCE 都会被拒绝；
   - `node scripts/smoke/identity-smoke.mjs <临时目录> <输出目录>`：真实 Chrome 走完登录、回调重放、back-channel logout、退出所有设备、旧管理员认领、注册→验证邮件→设密码→进入 Nexus，并检查 Nexus 日志里没有密钥、令牌和授权码；
   - `node scripts/smoke/pg-migrate-smoke.mjs <输出目录> <PostgreSQL 管理连接串> <新库名>`：SQLite 部署写入合成数据 → `migrate-to-pg` 演练/正式/重复 → 切到 PostgreSQL 后核对配置、文件与设备令牌。
5. 用完清理：`docker rm -f nexus-mailpit && COMPOSE_PROJECT_NAME=nexus-idtest docker compose down -v`。

## 上线前验证（逐项实测并记录，未做的写「未执行」）

1. `docker compose config` 通过；首次启动日志里 realm `accounts` 导入成功。
2. 注册 → 收到验证邮件 → 验证 → 在 Nexus 登录 → 在 LiteSync 免密进入（同一浏览器）。
3. 找回密码邮件 15 分钟内有效、只能用一次；重置后旧仓库密码不受影响。
4. 用 `nexus_app` 角色连接 `keycloak` 库 → 被拒绝（MG-02）。
5. 在 Keycloak 中结束用户会话 → 两个产品的会话随即失效（back-channel logout）。
6. 禁用用户 → 产品会话最迟 5 分钟内失效。
7. 四家邮箱的投递结果与 SPF/DKIM/DMARC 检查。
