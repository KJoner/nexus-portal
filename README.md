# Nexus Portal

个人数字入口：统一 Chrome / Edge / iPhone Safari 的浏览器首页，集中打开常用网站与自部署服务。

- 设计基线：`docs/UI style comparison pages (3)` 中的 R1.5（首页）与 R2（设置中心）
- 实施方案：[`docs/phase1-plan.md`](docs/phase1-plan.md)

## 目录

```
apps/web         前端（React + TypeScript + Vite + Tailwind）
apps/server      服务端（Hono + SQLite，第二批实现）
packages/shared  前后端共用：配置模式、操作归约、搜索模型、状态汇总
```

## 开发

需要 Node.js ≥ 22.12。

```bash
npm install
NEXUS_PASSWORD=至少8位的密码 npm run dev:server   # 服务端 http://127.0.0.1:8787（数据在 ./data）
npm run dev                                      # 前端 http://127.0.0.1:5173，/api 代理到服务端
npm test                                         # 全部测试
npm run typecheck                                # 类型检查
npm run build && npm start                       # 生产构建并由服务端托管前端
```

开发模式下不设 `NEXUS_PASSWORD` 时，服务端会生成临时密码并打印在控制台。

## 服务端环境变量

| 变量 | 说明 |
| --- | --- |
| `NEXUS_PASSWORD` | 访问密码（≥ 8 位）。生产环境必填；修改后重启即生效，旧会话全部失效 |
| `NEXUS_DATA_DIR` | 数据目录（SQLite、壁纸、图标），生产默认 `/data` |
| `PORT` / `HOST` | 监听地址，默认 `8787`；生产默认监听 `0.0.0.0` |
| `NEXUS_TRUST_PROXY` | 位于反向代理之后时设为 `1`，信任 `X-Forwarded-*` |
| `NEXUS_ALLOWED_ORIGINS` | 反代改写了 `Host` 时，填写对外访问地址（如 `https://home.example.com`），逗号分隔 |
| `NEXUS_COOKIE_SECURE` | `auto`（默认，按 https 判断）/ `always` / `never` |
| `NEXUS_SESSION_DAYS` | 会话有效天数，默认 30，使用中自动续期 |
