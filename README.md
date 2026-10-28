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
npm run dev        # 前端开发服务器 http://localhost:5173
npm test           # 全部单元测试与组件测试
npm run typecheck  # 类型检查
npm run build      # 生产构建，输出到 apps/web/dist
```

当前（第一批）配置只保存在本浏览器的 localStorage；第二批接入服务端后改为跨设备同步。
