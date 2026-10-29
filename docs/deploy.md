# Nexus Portal 部署指南

一个容器（Docker Hub 镜像 `kjoner/nexus-portal`）、一个数据卷。容器只监听宿主机的 `127.0.0.1:8787`，由你现有的 Nginx / Caddy 负责 HTTPS。

## 1. 启动

VPS 上只需要 `compose.yaml` 和 `.env` 两个文件，不需要源码：

```bash
mkdir -p ~/nexus && cd ~/nexus
curl -fsSLO https://raw.githubusercontent.com/KJoner/nexus-portal/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/KJoner/nexus-portal/main/.env.example -o .env
chmod 600 .env
# 编辑 .env：
#   NEXUS_VERSION    镜像版本，例如 0.1.0（不带 v）
#   NEXUS_PASSWORD   访问密码，至少 8 位
#   NEXUS_SECRET     openssl rand -base64 32
#   NEXUS_PUBLIC_URL 对外地址，例如 https://home.example.com
docker compose up -d
docker compose ps          # STATUS 应为 healthy
docker compose logs -f     # 首次启动会打印版本号和「访问密码已更新」
```

想从源码构建时，在仓库目录执行 `docker compose -f compose.yaml -f compose.build.yaml up -d --build`。

容器默认做了这些加固：非 root 用户（uid 1000）运行、根文件系统只读（只有 `/data` 和 `/tmp` 可写）、去掉全部 Linux capabilities、禁止提权；日志单个文件最大 10 MB，最多保留 3 个。

数据保存在命名卷 `nexus-data`（`/data`）：SQLite 数据库、上传的壁纸与图标、图标缓存。

> 想改用宿主机目录（例如 `./data:/data`）时，先执行 `mkdir data && sudo chown 1000:1000 data`，因为容器以非 root 用户 `node`（uid 1000）运行。

## 2. Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name home.example.com;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 12m;          # 壁纸上传上限 10 MB

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;   # 保留 Host，Nexus 的同源校验依赖它
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }

    # 配置与健康状态的实时推送（SSE）：关闭缓冲，放宽读超时
    location = /api/events {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

- 必须走 HTTPS：会话 Cookie 在 HTTPS 下带 `Secure`，iPhone「添加到主屏幕」与 Service Worker 也要求 HTTPS。
- 如果反代没有保留 `Host`，请在 `.env` 中填写 `NEXUS_PUBLIC_URL`，否则所有写操作会被同源校验拒绝。
- 客户端地址取 `X-Forwarded-For` 的**最后一项**，即反向代理自己看到的地址。上面的 `$proxy_add_x_forwarded_for` 正是这样追加的，客户端伪造的前几项不会被采信。

用 Caddy 时更简单（它会自动申请证书，推送连接也会即时转发）：

```caddy
home.example.com {
    request_body {
        max_size 12MB
    }
    reverse_proxy 127.0.0.1:8787
}
```

反向代理本身也运行在 Docker 里时，有两种接法：一是把 Nexus 加入它所在的网络，按服务名 `nexus:8787` 访问，这样可以删掉 `ports`；二是让反代访问宿主机的 `127.0.0.1:8787`。

**不经过反向代理、直接对外暴露端口时**（不推荐），在 `.env` 中设置 `NEXUS_BIND=0.0.0.0` 和 `NEXUS_TRUST_PROXY=0`。否则客户端可以伪造 `X-Forwarded-For` 绕过登录限流。

## 3. 网络与安全说明

| 项目 | 说明 |
| --- | --- |
| 健康检查 | 由服务端发起，只访问应用自己的外网 / 内网主机；回环（127.0.0.1）、链路本地与云元数据地址一律拒绝；局域网、Tailscale 地址默认允许（`NEXUS_HEALTH_ALLOW_PRIVATE=false` 可关闭）。不跟随重定向，不发送任何凭据 |
| 代理环境 | 宿主机若运行 Clash / Mihomo 的 fake-ip 模式，公网域名会解析到 `198.18.0.0/15`，Nexus 视其为私有地址，检查可以正常进行 |
| Linkwarden | 访问令牌用 `NEXUS_SECRET` 加密保存，接口只返回末 4 位。更换 `NEXUS_SECRET` 后需要在设置里重新填写令牌 |
| 图标 | 默认由服务端从固定 CDN 拉取并缓存，浏览器不直接访问第三方图标服务 |
| 精选图库 / 每日一图 | 服务端只访问 Wikimedia 的固定域名（`commons.wikimedia.org`、`upload.wikimedia.org`、`thumb.wikimedia.org`），同时最多 3 个请求；下载前核对许可（只接受 CC0、公有领域、CC BY / BY-SA），缓存到数据目录，浏览器同源加载 |
| 网址导入壁纸 | 服务端下载一次：只允许公网地址（内网、回环、链路本地一律拒绝，每次重定向都重新检查），≤ 15 MB，必须是图片，并重新编码；只记录地址的主机与路径，不保存查询参数。宿主机若运行 fake-ip 代理，公网域名会解析到私有段，导入会被拒绝 |
| Unsplash | 仅在设置了 `NEXUS_UNSPLASH_ACCESS_KEY` 时启用；Key 不会发给浏览器。按其 API 规定图片必须直链，浏览器会直接访问 `images.unsplash.com` |
| 登录 | 单用户密码；每个 IP 15 分钟内最多 5 次失败，全局 30 次 |

## 4. 备份与恢复

```bash
docker compose stop
docker run --rm -v nexus_nexus-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/nexus-$(date +%F).tgz -C /data .
docker compose start
```

恢复时把压缩包解回同名卷后启动即可。另外可以随时在「设置 › 数据、同步与安全」导出配置 JSON（不含上传的图片和令牌）。

## 5. 升级与回滚

先按上一节备份，然后修改 `.env` 中的 `NEXUS_VERSION`：

```bash
docker compose pull && docker compose up -d
docker compose logs --tail 5 nexus     # 「[nexus] 0.2.0 已启动 …」
```

数据库迁移在启动时自动执行。浏览器端的 Service Worker 会在下次打开时自动更新。

回滚时把 `NEXUS_VERSION` 改回旧版本，同样执行 `pull` 和 `up -d`。如果新版本已经迁移过数据库，旧版本会拒绝启动，并提示「数据库版本比当前程序新」，防止旧代码损坏新格式的数据。这时先恢复升级前的备份，再启动旧版本。具体命令见 README 的「回滚」一节。

## 6. 设置各浏览器的入口

| 浏览器 | 做法 |
| --- | --- |
| Windows Chrome | 设置 › 启动时 › 打开特定网页 → 填入门户地址；设置 › 外观 › 显示「主页」按钮 → 同一地址 |
| Windows Edge | 设置 › 开始、主页和新建标签页 › Microsoft Edge 启动时 → 打开这些页面；同时设置「主页」按钮 |
| iPhone Safari | 打开门户 → 分享 › 添加到主屏幕（以独立应用打开）；或加入「个人收藏」显示在起始页 |

Chrome / Edge 的「新标签页」需要浏览器扩展才能替换，第一阶段不做扩展。

## 7. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXUS_VERSION` | `latest` | 镜像标签（compose 使用），生产环境建议写具体版本 |
| `NEXUS_IMAGE` | `kjoner/nexus-portal` | 镜像仓库（compose 使用） |
| `NEXUS_BIND` / `NEXUS_PORT` | `127.0.0.1` / `8787` | 宿主机监听地址与端口（compose 使用） |
| `NEXUS_PASSWORD` | 必填 | 访问密码（≥ 8 位） |
| `NEXUS_SECRET` | 必填（compose） | 加密服务凭据的密钥（≥ 16 位）；未设置时在数据目录生成 `secret.key` |
| `NEXUS_PUBLIC_URL` → `NEXUS_ALLOWED_ORIGINS` | 空 | 反代改写 Host 时需要的对外地址 |
| `NEXUS_TRUST_PROXY` | compose 中为 `1` | 信任 `X-Forwarded-*`；直接暴露端口时必须设为 `0` |
| `NEXUS_HEALTH_ALLOW_PRIVATE` | `true` | 允许检查局域网 / Tailscale 地址 |
| `NEXUS_HEALTH_ALLOW_LOOPBACK` | `false` | 允许检查回环地址（不建议） |
| `NEXUS_COOKIE_SECURE` | `auto` | `auto` / `always` / `never` |
| `NEXUS_SESSION_DAYS` | `30` | 会话有效天数，使用中自动续期 |
