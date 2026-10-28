# Nexus Portal 第一阶段实施方案

> 状态：第一批开发中 · 2026-10-28
> 视觉基线：R1.5（首页，冻结）+ R2（设置中心）。本文只记录工程决策，视觉数值以设计稿为准。

---

## A. 设计资产审计

### A1. 文件分级

| 级别 | 文件 | 用途 |
| --- | --- | --- |
| **最终规范** | `R15 Desktop.dc.html` | 桌面首页、搜索面板、引擎菜单、Dock、编辑首页、应用抽屉、右键菜单、撤销提示、状态弹层 |
| | `R15 Mobile.dc.html` | 手机首页、底部面板、搜索模式（键盘）、全部应用、长按操作表 |
| | `Nexus R1.5 Revisions.dc.html` | 7 项交互修订、五态服务状态、响应式、移动端实现约定、无障碍、**视觉冻结数值表** |
| | `R2 Settings Desktop.dc.html` / `R2 Settings Mobile.dc.html` | 设置中心全部页面、编辑抽屉/整页表单、对话框、操作表 |
| | `Nexus R2 Settings Spec.dc.html` | 设置信息架构、四种保存模型、PC/手机差异、组件规格、交互时长、反馈状态 |
| | `Nexus R2 Settings.dc.html` | R2 画板索引（P1–P6、E1–E4、F1–F4、M1–M10 的说明文字） |
| **仍有效的补充规范** | `Nexus R1 Spec.dc.html` | 图标三材质（瓷白/烬色/玻璃）、尺寸与圆角（边长 × 0.285）、动效时长与三条曲线。其中「三态状态」已被 R1.5 五态取代 |
| **原型数据（只取模型，不在运行时加载）** | `nexus-r1-data.js` | 应用目录、自托管服务、状态等级与汇总规则、搜索分组模型、图标材质函数 |
| | `nexus-r2-settings.js` | 配置结构、默认值、壁纸、校验规则、设置搜索索引 |
| | `nexus-icons.js` | Lucide 0.469 图标子集（正式实现直接用 `lucide-react`） |
| **资源** | `assets/wallpaper.jpg` | 默认壁纸「流水别墅」 |
| **历史稿（不作为基线）** | `Nexus A Immersive` / `B Console` / `C Minimal`、`Nexus R1 Atmospheric`（v1、v2）、`R1 Desktop` / `R1 Mobile`、`Nexus R2 Editorial`、`Nexus Redesign Brief`、`assets/shots/*`（R1 与 Editorial 截图） | 仅供追溯 |
| **原型运行时（不进入正式代码）** | `support.js`、`browser-window.jsx`、`ios-frame.jsx`、`.thumbnail` | 设计工具的画板与设备外框 |
| **无关** | `_ds/modernist-*` | 红白 Archivo 设计系统，用于文档画布，与 Nexus 视觉无关 |

### A2. 设计 Token（来自 R1.5 冻结表与原型）

- **颜色**：底色 `#1b1a17`、正文 `#efeae1`、琥珀强调 `#e6c08a`（悬停 `#f1d3a6`）、正常 `#a7bf9f`、警告 `#e3a35b`、异常 `#e9765f`、未知 `#9a948a`、危险文字 `#f0a594`。文字透明度阶梯 .8 / .66 / .5 / .46，最低 .46 仅用于辅助说明。
- **字体**：Manrope + Noto Sans SC（设置页网址字段用 JetBrains Mono）。时钟 60/300/−0.035em，搜索输入 18/400，图标名称 12，分组标题 11.5，抽屉标题 22/500。
- **尺寸**：Dock 图标 56/16，抽屉 60/17，手机 60（小屏 56），搜索面板 760 宽/圆角 24，抽屉 1040 宽/圆角 30，浮层菜单圆角 16。圆角 = 边长 × 0.285。
- **材质**：搜索面板 blur 32 + 底 .48；抽屉 blur 44 + 底 .66；同屏磨砂 ≤ 3 层。
- **动效**：悬停 .14s，按下 .09s，浮层 .2s `cubic-bezier(.2,.7,.2,1)`，面板/抽屉 .32–.42s `cubic-bezier(.32,.72,0,1)`，退出 `cubic-bezier(.4,0,1,1)`，唯一循环动画为异常呼吸 2.4s。
- **焦点**：2px `#e6c08a`、偏移 3px 的 `:focus-visible`；输入框不叠加。
- **壁纸暖调处理**：底 `#a69e8e` → 照片 `grayscale(1) contrast(1.08)` 正片叠底 → `#221f1b` 变亮混合 → 径向 + 上下渐变遮罩。

### A3. 可复用的视觉资产

1. 三套自托管服务图标（LiteBox 盒子、OBsync 循环、Linkwarden 书签环），SVG 可直接复用。
2. 图标材质：瓷白（外部网站）、烬色（自托管，4 种色调）、玻璃（系统入口）。
3. 默认壁纸与 3 种纯色渐变壁纸（暖炭、夜苔、石墨）。
4. 品牌图标来源：homarr-labs/dashboard-icons，缺失回退 Simple Icons，再回退字母图标。

### A4. 核心组件清单

| 区域 | 组件 |
| --- | --- |
| 公共 | AppTile（三材质 + 状态角标 + 字母回退）、Toast（撤销、悬停暂停）、Menu（右键/Shift+F10）、ActionSheet、StatusDot、Switch、Segmented、Slider、Dialog |
| 首页桌面 | WallpaperLayer、TopBar、StatusPill + StatusPopover、Clock、SearchSlab（EngineButton、EngineMenu、ResultsPanel）、Dock（编辑模式、拖动）、AppDrawer（筛选、二维键盘导航、空结果、隐藏应用） |
| 首页手机 | MobileHome、BottomPanel（home / search / apps 三态）、ActionSheet（长按 480ms） |
| 设置 | SettingsShell（左栏/推入式子页）、外观预览、固定列表排序、应用表格、编辑抽屉/整页表单、分类管理、引擎管理、导入导出、重置 |

### A5. 原型中需要修正的问题（保持视觉不变）

| 问题 | 处理 |
| --- | --- |
| 首页 MAXPIN = 5，设置 MAXPIN = 12，口径冲突 | 采用 R2 模型：最多固定 12 个网站，**同一顺序、两种容量**——桌面 Dock 显示前 N 个（3–7，默认 5），手机显示前「行数 × 4 − 服务数」个。首页右键菜单的「n / 5」改为显示 Dock 容量 |
| 所有尺寸以固定画板（1440×900）计算，`transform: scale` 适配 | 正式实现改为真实视口布局；1280×720 规则（搜索区顶 = 视口高 24%）按断点实现 |
| 状态、收藏数量、测试连接、令牌均为演示数据 | 全部换成真实来源；无数据时显示「未监测 / 未连接」，不伪造数字 |
| LiteBox「12 个节点在线」等业务指标 | 门户不直接读业务库，目前没有确认可用的只读接口，只显示健康检查结果（HTTP 状态与耗时） |
| 所有服务都未监测时胶囊显示「0 项服务正常」 | 改为「n 项未监测」中性样式 |
| 拖动排序用 HTML5 DnD，触屏不可用 | 改用 dnd-kit（指针 + 键盘），保留 Alt ←→ 与 Delete |
| 外部图标（jsDelivr、DuckDuckGo）直接由浏览器请求 | 第二批起改为服务端代理并缓存（固定主机白名单），离线时回退字母图标 |
| 原型字体来自 Google Fonts | 改为 @fontsource 本地打包，内网/离线可用 |
| 「运行概览」没有设计稿 | 第一阶段导航「运行概览」打开状态弹层；完整概览页留到后续阶段 |

---

## B. 技术架构与数据模型

### B1. 结构

```
Nexus Portal/
├─ apps/
│  ├─ web/        React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui（Radix）+ Motion
│  └─ server/     Hono（Node）+ SQLite，同时托管前端静态文件
├─ packages/
│  └─ shared/     zod 模式、默认数据、配置操作（ops）与归约函数、搜索模型、状态汇总
├─ docker/        Dockerfile、compose.yaml
└─ docs/
```

- **一个前端 + 一个轻量 API + 一个 SQLite 文件**，不做微服务。
- `packages/shared` 是前后端共用的「规则层」：同一套校验与归约函数，前端用于乐观更新，后端用于权威写入。

### B2. 前端

- 路由：`/`（首页）、`/settings/:page?`、`/login`。React Router（数据量小，无需框架）。
- 状态：Zustand 保存配置快照 + 待发送操作队列；界面状态（抽屉、菜单、搜索）留在组件内。
- 布局切换：视口宽 ≥ 900 且高 ≥ 560 用桌面布局，否则手机布局；两者共用数据与逻辑 hooks。
- 本地优先渲染：启动时先用本地缓存快照（无缓存则用内置默认），再与服务端对齐，**任何接口失败都不会出现空白页**。
- 动效统一读取「动画强度」设置与 `prefers-reduced-motion`，写到根元素 `data-motion`。

### B3. 数据库实体（SQLite）

| 表 | 关键字段 |
| --- | --- |
| `apps` | id、kind（site / service）、name、description、url、lan_url、prefer、category_id、hidden、pinned_service、aliases、icon_source、icon_value、icon_letter、icon_tone、open_in、sort、updated_at |
| `categories` | id、label、locked、sort |
| `pins` | app_id、position（只含网站，最多 12） |
| `engines` | id、name、url_template、prefix、builtin、kind（web / linkwarden）、sort |
| `settings` | key（search / home / look / privacy）、value JSON、updated_at |
| `health_checks` | app_id、enabled、target（路径或同主机完整网址）、interval_s、timeout_ms |
| `health_status` | app_id、level、http_status、latency_ms、message、checked_at、fail_count |
| `wallpapers` | id、name、kind、variants JSON（1280/1920/2560 × AVIF/WebP/JPEG）、placeholder、width、height |
| `integrations` | id（linkwarden）、base_url、token_enc（AES-GCM 加密）、token_last4 |
| `sessions` | id_hash、created_at、expires_at、last_seen、user_agent |
| `meta` | schema_version、config_revision |

PC 与手机差异字段放在 settings 内：`home.desktop.dockSize`（3–7）、`home.mobile.rows`（2/3）、`look.focal.desktop / mobile`、各端的「显示图标名称」。搜索历史与最近使用**只存本浏览器**（R2 规范），不上传。

### B4. 配置同步方案

1. **意图型操作（ops）**：所有修改以操作提交，如 `pin.add`、`pin.move`、`app.update`、`settings.patch`。服务端在事务中对当前状态应用操作，天然合并不同设备的修改，不需要整份覆盖。
2. **乐观更新 + 发件箱**：前端先用同一归约函数更新界面，再把操作写入本地发件箱并发送；失败则保留在发件箱，联网后按顺序重放。顶栏如实显示「正在保存 / 已保存 · 时间 / 离线，恢复后同步 / 保存失败」。
3. **修订号**：每次写入 `config_revision + 1`；服务端用 SSE 推送新修订号，其他设备收到后拉取快照；页面重新可见时也会对齐一次。
4. **撤销**：由归约前状态生成逆操作（如 `pin.remove` ↔ `pin.add@index`），撤销本身也是一次普通同步。
5. **导入 / 重置**：`config.replace` 操作，先在前端显示变更摘要，执行后可撤销。

### B5. 访问安全

- **登录**：单用户密码（环境变量 `NEXUS_PASSWORD` 首次启动时 scrypt 散列入库），登录后发 `HttpOnly + Secure + SameSite=Lax` 会话 Cookie，30 天滚动续期；登录接口按 IP 限速。
- **保护范围**：除 `/api/auth/*`、`/api/healthz` 和前端静态外壳外，所有 API 需要会话；静态外壳不含任何配置数据。未登录只显示带壁纸与时钟的登录页。
- **CSRF**：写操作校验 `Origin` 与自定义请求头。
- **密钥**：Linkwarden 令牌只存服务端，AES-GCM 加密（密钥来自 `NEXUS_SECRET`），接口只返回末 4 位；导出配置不含令牌。
- **SSRF 防护**：健康检查目标只能是**已登记应用的同主机地址**（路径拼接或同主机网址），前端不能提交任意 URL；禁止跳转到其他主机；拦截 `169.254.0.0/16`、`0.0.0.0`、IPv6 链路本地等元数据地址；私网地址默认允许（内网服务本身就是目标），可用 `NEXUS_HEALTH_ALLOW_PRIVATE=false` 关闭；5 秒超时、响应体上限 64 KB。图标代理只允许固定主机。
- **响应头**：CSP、`X-Content-Type-Options`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'`。
- 访客模式隐藏服务状态、最近使用与搜索历史。

### B6. 部署

- 单镜像（Node 22 Alpine，多阶段构建）：服务端托管 `apps/web/dist`，数据目录 `/data`（SQLite + 壁纸 + 图标缓存）挂卷。
- `compose.yaml`：一个 `nexus` 服务，健康检查 `/api/healthz`，复用现有 Nginx 做 HTTPS 反代（文档给出 Nginx 片段）。
- 备份：直接备份 `/data`，或在设置中导出 JSON。

---

## C. 分批实施计划

### 第一批：工程基础与首页

| 模块 | 内容 | 依赖 |
| --- | --- | --- |
| C1-1 工程骨架 | npm workspaces、TS、Vite、Tailwind v4、Vitest、字体本地化、设计 Token | — |
| C1-2 shared 规则层 | 配置 zod 模式、默认数据、ops 归约 + 逆操作、搜索分组、状态汇总，单元测试 | C1-1 |
| C1-3 数据层 | Zustand 配置库 + 本地适配器（localStorage，第二批替换为服务端适配器） | C1-2 |
| C1-4 图标体系 | AppTile 三材质、内置服务图标、品牌图标加载与字母回退 | C1-1 |
| C1-5 桌面首页 | 壁纸层、顶栏、时钟、搜索面板（combobox、引擎菜单、Alt ↑↓、前缀切换、URL 识别）、Dock、状态胶囊与弹层 | C1-3、C1-4 |
| C1-6 快捷方式管理 | 右键 / Shift+F10 菜单、固定 / 移除 / 隐藏 / 移动、编辑首页（dnd-kit 拖动、Alt ←→、Delete）、5 秒撤销 | C1-5 |
| C1-7 应用抽屉 | 筛选、二维方向键、空结果、隐藏应用显示、焦点管理 | C1-5 |
| C1-8 手机首页 | 底部面板三态、visualViewport 键盘跟随、长按操作表、安全区、小屏 | C1-3、C1-4 |
| C1-9 动效与无障碍 | 动画强度、减少动态效果、焦点环、浮层 aria-hidden / inert | 贯穿 |

**进度（2026-10-28）**：C1-1 至 C1-9 已完成首版。单元 / 组件测试 43 项通过（shared 归约与逆操作、搜索模型、状态汇总；本地持久化与损坏数据回退；撤销；搜索框键盘模型）。已在 Chrome 中按 1440×900、1280×720、390×844、375×667 与设计稿逐一对照。已知待办：设置中心入口暂为占位页（第二批）；「减弱」动画级别目前只去掉缩放与呼吸，抽屉位移仍保留；JS 包 568 KB（gzip 177 KB），第二批按路由拆包。

**验收**：1440×900、1280×720、390×844、375×667 下与设计稿对照无明显偏差；搜索 Tab 顺序（引擎按钮 → 输入框 → Dock）、Alt ↑↓、↑↓ 选择、Enter 打开、Esc 清空/关闭全部可用；固定 / 隐藏 / 排序刷新后保持；抽屉方向键二维移动、Esc 后焦点回到「全部应用」；手机长按 480ms 出操作表；减少动态效果生效；单元测试通过。

### 第二批：设置与持久化

| 模块 | 内容 |
| --- | --- |
| C2-1 服务端骨架 | Hono、SQLite 迁移、静态托管、错误处理、安全响应头 |
| C2-2 访问保护 | 密码登录、会话、限速、CSRF、登录页 |
| C2-3 配置 API | `GET /api/config`、`POST /api/config/ops`、SSE 修订推送；前端切换为服务端适配器 + 发件箱 |
| C2-4 设置中心 | 桌面工作区与手机推入式页面：外观（预览后应用）、首页与快捷方式、应用与服务（编辑抽屉、校验、分类管理）、搜索（引擎管理）、数据与安全 |
| C2-5 壁纸 | 上传、服务端生成三档尺寸与模糊占位、焦点（PC / 手机分别保存） |
| C2-6 导入导出与重置 | JSON 导出（不含令牌与上传图片）、导入预览 → 替换 → 撤销、输入「重置」确认 |

**验收**：两台设备（Chrome + 手机 Safari）修改后 3 秒内互相看到；离线修改恢复网络后自动补发；刷新恢复；接口 500 / 断网时首页仍可用并提示状态；未登录无法读取任何配置；保存状态只在服务端确认后显示「已保存」。

### 第三批：服务集成与部署

| 模块 | 内容 |
| --- | --- |
| C3-1 健康检查 | 服务端调度、五态判定（连续 2 次失败为异常）、状态缓存、SSE 推送、「测试连接」真实请求、SSRF 防护 |
| C3-2 Linkwarden 只读搜索 | 先按官方文档核对接口后再实现；令牌加密保存；搜索结果混排；不可用时降级 |
| C3-3 图标代理与缓存 | 固定主机白名单、磁盘缓存、本地缓存开关 |
| C3-4 PWA | Service Worker 缓存外壳与最近快照，离线可打开；添加到主屏幕 |
| C3-5 部署 | Dockerfile、compose、Nginx 示例、备份说明 |
| C3-6 跨浏览器验收 | Playwright（Chromium / WebKit）+ 真机 iPhone Safari 清单 |

LiteBox、OBsync 如果没有确认可用的只读 API，只保留导航入口与通用健康检查，不猜测数据接口。

### 主要风险

| 风险 | 应对 |
| --- | --- |
| iOS Safari 的键盘、动态地址栏、`backdrop-filter` 性能 | 使用 `100dvh` 与 visualViewport；磨砂层 ≤ 3；真机验收 |
| 多设备同时编辑 | 意图型操作在服务端合并；整份替换只用于导入/重置并需确认 |
| 健康检查被滥用为 SSRF | 目标绑定已登记应用、拦截元数据地址、禁止跨主机跳转、限时限量 |
| 第三方图标源不可用 | 服务端缓存 + 字母回退，不阻塞首页 |
| Linkwarden 接口版本差异 | 实现前核对其官方 API 文档；失败时隐藏收藏分组并提示 |
| 依赖为较新大版本（Vite 8、TS 7、Zod 4） | 锁定版本，遇到不兼容回退到上一大版本 |
