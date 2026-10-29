# Chrome 新标签页扩展

扩展把 Chrome 的新标签页换成你的 Nexus Portal 导航。页面打包在扩展里，打开时直接读取本地缓存，不会跳转到门户网址；导航在后台与服务端同步，而且只读。

- 代码：`apps/chrome-extension`（Manifest V3，React + TypeScript + Vite）
- 版本：扩展单独发版（`ext-vX.Y.Z`），与 Docker 镜像互不影响
- 要求：Chrome 120 或更高；Nexus Portal 服务端 **0.3.0 或更高**（提供设备授权与同步接口）

## 在 Windows 的 Chrome 中安装

1. 下载 `nexus-portal-chrome-vX.Y.Z.zip`，可以从下面任一处获取：
   - 仓库的 **Releases** 页面中带 `ext-v` 前缀的版本
   - Actions › Chrome extension 中某次运行的 Artifacts（下载后先解开外层压缩包）
2. 把 ZIP 解压到一个**以后不再移动**的文件夹，例如 `D:\Apps\nexus-portal-chrome`。解压后，文件夹里直接就是 `manifest.json`。
3. 在 Chrome 地址栏打开 `chrome://extensions`，打开右上角的「开发者模式」。
4. 点「加载已解压的扩展程序」，选择上面的文件夹。
5. 扩展会自动打开欢迎页。之后第一次按 `Ctrl + T` 时，Chrome 可能询问是否保留新标签页的更改，选择「保留」。

> 未上架的扩展 ID 由文件夹路径决定。**更新时请解压到同一个文件夹**，再在 `chrome://extensions` 中点扩展卡片上的刷新按钮，这样连接和缓存都会保留。换了文件夹，Chrome 会把它当成另一个扩展，需要重新连接。

## 连接 Nexus Portal

1. 在欢迎页（或扩展设置、新标签页）中填写门户地址，例如 `https://nexus.example.com`。设备名称可以改，它会显示在门户的设备列表中。
2. 点「连接」后，Chrome 会请求访问这一个地址的权限，点「允许」。
3. 扩展显示一个连接码（例如 `KXQ7-M2PD`），并在新标签页中打开门户的确认页面。
4. 在门户中登录，**核对连接码与扩展显示的完全一致**，点「连接码一致，允许连接」。
5. 扩展取回自己的令牌，关闭确认页，并完成第一次同步。

连接请求 10 分钟内有效，只能确认一次。如果确认页上的连接码和扩展里的不一样，或者你没有发起过连接，请点「拒绝」。

只允许 HTTPS 地址；本机和局域网地址（`localhost`、`192.168.x.x`、`10.x`、Tailscale 的 `100.64/10`、`.lan` 等）也可以用 `http://`，但会显示不加密的提示。

## 日常使用

- **打开新标签页**：直接显示缓存的导航。与门户首页一样，可以搜索、打开应用、展开扩展区、查看全部应用和服务状态。
- **只读**：扩展中不能编辑首页、固定、隐藏或移动应用，也不能收藏壁纸。
  - 右键菜单中的「在设置中编辑」、显示与布局、更换固定壁纸，会在当前标签页打开门户对应的设置页。
  - 齿轮按钮和 `,` 键打开扩展自己的设置。
- **扩展设置**（齿轮，或 `chrome://extensions` 中的「扩展程序选项」）：
  - 查看连接状态、最近同步时间和导航修订号
  - 立即同步
  - 清理缓存：保留连接，清除缓存的导航、图标和壁纸后重新下载
  - 更换服务器：连接成功后才替换，旧服务器的缓存先被清除
  - 断开连接：撤销此设备的令牌，并清除本地数据
- **在门户中管理设备**：「设置 › 数据、同步与安全 › 浏览器扩展」列出已连接的扩展、授权时间和最近同步时间，可以随时撤销。

## 工作原理

### 页面与代码复用

- 新标签页（`newtab.html`）和设置页（`options.html`）都随扩展打包，不从网络加载任何脚本。
- 首页直接复用 `apps/web/src` 中的组件（Vite 别名 `@web`），因此界面与门户一致，门户改版时扩展自动跟上。
- web 端只增加了一个很小的宿主开关 `apps/web/src/lib/host.ts`，门户中的默认行为不变。扩展启动时把它设为：
  - 只读：隐藏所有写入操作
  - 图片从扩展缓存读取（`blob:` 地址）
- 后台 Service Worker 只做一件事：安装后打开一次欢迎页。它不常驻，也不参与同步。

### 本地缓存优先，后台同步（stale-while-revalidate）

```
打开新标签页
  ├─ 读取 chrome.storage.local（导航配置）与 IndexedDB（图标、壁纸），约几毫秒
  ├─ 立即渲染缓存的首页 ← 不等任何网络请求
  └─ 后台同步：
       ├─ 30 秒内检查过 → 不发请求
       ├─ 另一个标签页正在同步（Web Locks）→ 不发请求，等它的结果
       ├─ GET /api/sync/config，带 If-None-Match
       │    ├─ 304 未变化 → 只记录检查时间
       │    └─ 200 有变化 → 校验后写入缓存
       │         → 所有打开的新标签页通过 storage.onChanged 一起更新
       └─ 首页显示服务状态时，再 GET /api/sync/status
```

- **触发时机**：打开新标签页、标签页回到前台、网络恢复（不受 30 秒限制）、手动同步。
- **ETag**：由修订号和写入时间组成。即使恢复备份后修订号重复，ETag 也不会相同。经 Cloudflare 或 nginx 压缩后变成的弱 ETag 同样可以匹配。
- **数据一致性**：
  - 服务端返回的配置必须通过与门户相同的模式校验，才会写入缓存。
  - 请求失败、超时、内容无法识别时，原缓存保持不变。
  - 缓存按服务器地址和设备 ID 绑定：不属于当前服务器的缓存一律视为不存在，所以切换服务器时不可能显示旧服务器的数据。
  - 读不回来的缓存（损坏、格式变化）会被删除并重新下载，不会显示出来。
- **离线**：继续显示缓存；服务状态显示为「Nexus 服务端离线」，不会把旧状态当作当前状态。
- **首次连接、尚无缓存**：只显示「正在同步」或「暂时无法连接」和重试按钮，不显示任何假数据。

### 图标与壁纸缓存

- 首页需要某个 `/api` 图片时，扩展带令牌下载，存进 IndexedDB（元数据和图片分开存放），再以 `blob:` 地址显示。下次打开新标签页，图片随首页一起出现。
- 壁纸只缓存一个尺寸：屏幕宽度对应的 WebP。下一张轮换壁纸在空闲时预取。
- **刷新规则**：
  - 上传的图标和壁纸不会变化（换图就换 id），不再重新下载。
  - 品牌图标与网站图标每 7 天刷新一次；刷新失败时继续使用旧图。
  - 服务端 404 的图片一天后再试，图标源故障（5xx）15 分钟后再试，不会每开一个标签页就请求一次。
- **容量上限**：最多 400 个图标、6 张壁纸、共 80 MB。超出时先清理最久未用的；60 天未用的直接清理。
- **Unsplash 壁纸**：门户本身就是直接引用 Unsplash 的图片地址，扩展同样直接加载，不另做缓存。

### 存储位置

| 位置 | 内容 |
| --- | --- |
| `chrome.storage.local` · `server` | 门户地址、设备 ID、设备名称、只读令牌 |
| `chrome.storage.local` · `cache` | 上次确认的导航配置（只在配置变化时写入） |
| `chrome.storage.local` · `sync` | 最近检查时间、服务状态、最近一次错误（体积很小） |
| IndexedDB `nexus-assets` | 图标与壁纸 |
| localStorage | 与门户相同的界面偏好：最近使用、扩展区展开状态、壁纸偏移 |

这些数据只有扩展自己的页面能读取。扩展没有内容脚本，网页无法访问。

## 认证与安全

门户网站的登录使用 HttpOnly Cookie，写入接口还会做 CSRF 来源检查。扩展页面的来源是 `chrome-extension://…`，既不应该、也不能可靠地复用网站登录状态，所以扩展使用独立的**只读设备令牌**。现有的登录、Cookie 和 CSRF 规则都没有放宽，服务端也没有开放任何 CORS。

- **配对**：参考 OAuth 设备授权流程（RFC 8628）。
  1. 扩展发起请求，得到连接码和一个只有它知道的轮询密钥。
  2. 门户中已登录的用户核对连接码并确认。
  3. 扩展用轮询密钥取回令牌。令牌在取回的那一刻才生成，并且只发放一次。
  - 连接请求只保存在服务端内存里，10 分钟后失效。
  - 每个来源地址 10 分钟内最多发起 10 次，同时最多 10 个待确认请求。
- **令牌**：
  - `nxd_` 加 32 字节随机数；服务端只保存 SHA-256。
  - 只能访问 `/api/sync/*` 下的只读接口，不能当作会话使用，任何写入接口都不接受它。
  - 会话 Cookie 也不能访问 `/api/sync/*`。
- **撤销**：以下任一情况都会让令牌失效：
  - 在门户「浏览器扩展」中撤销
  - 在扩展中断开连接
  - 更改访问密码（与登录会话一起失效）
  - 连续 180 天没有同步
- **失效后**：扩展收到服务端明确的 `device_unauthorized` 答复，会立即清除缓存的导航、图标、壁纸和界面偏好，并提示重新连接。前置代理返回的其他 401 不会触发清除。
- **扩展端**：
  - 不保存访问密码，也没有任何写权限。
  - 请求不带 Cookie，也不跟随重定向，令牌不会被带到别的网站。
  - 页面 CSP 只允许扩展自带的脚本（`script-src 'self'`），没有 `eval`，也不远程加载代码。
- **权限**：
  - 安装时只有 `storage`。
  - 网站权限声明为可选（`optional_host_permissions`），连接时只请求用户填写的那一个地址。
  - 更换服务器或断开连接后，归还对应地址的权限。
- **CSRF 说明**：`/api/pair/*` 与 `/api/sync/*` 跳过了 Origin 检查，因为扩展的来源是 `chrome-extension://`。这两组接口从不读取会话 Cookie，没有可被伪造请求利用的凭据，仍然要求带 `X-Nexus-Client` 请求头。

### 服务端接口

| 接口 | 认证 | 用途 |
| --- | --- | --- |
| `POST /api/pair/start` | 无（限流） | 发起连接，返回连接码与轮询密钥 |
| `POST /api/pair/poll` | 轮询密钥 | 等待确认；批准后取回令牌（一次） |
| `GET /api/sync/config` | 设备令牌 | 导航配置，支持 `If-None-Match` / 304 |
| `GET /api/sync/status` | 设备令牌 | 服务状态 |
| `GET /api/sync/{icons,icon-cache,wallpapers}/…` | 设备令牌 | 图标与壁纸 |
| `GET /api/sync/{suggest,bookmarks,wallpaper-sources}` | 设备令牌 | 搜索建议、Linkwarden 书签、精选图库目录（只读） |
| `POST /api/sync/revoke` | 设备令牌 | 扩展断开连接时撤销自己 |
| `GET /api/devices`、`DELETE /api/devices/:id` | 登录会话 | 门户中列出、撤销设备 |
| `GET/POST /api/devices/pairing/:code` | 登录会话 + CSRF | 门户中查看、确认或拒绝连接请求 |

数据库新增 `devices` 表（第 6 次迁移）。旧版本服务端会拒绝打开新数据库：回滚到 0.2.x 时，需要恢复升级前的备份（`deploy.sh` 会自动备份，失败时自动回滚）。

## 开发

```bash
npm install
npm run build -w @nexus/chrome-extension     # 输出到 apps/chrome-extension/dist，可直接「加载已解压的扩展程序」
npm run package -w @nexus/chrome-extension   # 再打包为 apps/chrome-extension/release/nexus-portal-chrome-vX.Y.Z.zip
npm run typecheck -w @nexus/chrome-extension
npx vitest run --project extension           # 同步、配对、地址校验、缓存淘汰
npm run build && npx playwright test --project=extension   # 端到端（见下）
```

- 本地开发连接 `http://127.0.0.1:8787` 的服务端即可（本机地址允许 http）。
- 改了扩展代码后：先运行 `build`，再到 `chrome://extensions` 点刷新。
- ZIP 由 `scripts/package.mjs` 生成：只用 Node 自带的 zlib，不需要其他依赖。条目按名称排序，时间固定，同样的构建得到完全相同的文件。

```
apps/chrome-extension
  manifest.json       模板；构建时写入 package.json 的版本号
  newtab.html / options.html
  src/boot.ts         启动：设置宿主开关、同步引擎、只读 transport，并行读取缓存
  src/lib/sync.ts     同步引擎（节流、Web Locks、ETag、失效处理、多标签页同步）
  src/lib/assets.ts   图片缓存（IndexedDB、容量上限、淘汰）
  src/lib/api.ts      服务端请求（无 Cookie、不跟随重定向、错误分类）
  src/lib/pair.ts     配对流程
  src/ui/             新标签页、连接表单、扩展设置页
```

## 构建与发布（GitHub Actions）

工作流：`.github/workflows/extension.yml`

- **触发**：
  - 推送到 `main`，或 Pull Request 改动了扩展、它复用的 `apps/web/src`、`packages/shared`、服务端或依赖
  - 手动运行（Actions › Chrome extension › Run workflow）
  - 推送 `ext-vX.Y.Z` 标签
- **检查**：类型检查、单元测试、构建并打包；校验 ZIP：
  - 根目录有 `manifest.json`，Manifest V3，版本一致，权限只有 `storage`
  - 没有预授权网站，没有远程脚本，没有令牌或生产地址
- **端到端**：在 Chromium 中加载扩展，连接真实的服务端和门户，验证配对、缓存优先、变更同步、304、离线、缓存损坏、撤销。
- **产物**：每次运行都上传 `nexus-portal-chrome-vX.Y.Z.zip` 及其 `.sha256`，保留 30 天。
- **正式版本**：

  ```bash
  # 1. 修改 apps/chrome-extension/package.json 的版本，并在 apps/chrome-extension/CHANGELOG.md 写好该版本条目
  git commit -am "Chrome 扩展 0.1.1" && git push origin main
  # 2. main 上的检查通过后再打标签（标签必须指向 main 上的提交，并与版本号一致）
  git tag -a ext-v0.1.1 -m "Nexus Portal Chrome 扩展 v0.1.1"
  git push origin ext-v0.1.1
  ```

  - 标签工作流通过后，创建 GitHub Release 并附上 ZIP 和校验文件。
  - Release 不会标为 Latest，Latest 始终是服务端版本。
- **互不影响**：
  - `ext-v*` 标签不匹配 Docker 发布工作流的 `v*` 规则。
  - 只改扩展代码时，主 CI 不运行（`paths-ignore`）。
  - Docker 镜像构建不包含扩展：根目录的 `npm run build` 只构建 web 与服务端。

## 手动验收（Windows Chrome）

以下项目在自动化环境中无法完整验证，请在真实的 Chrome 中检查一遍：

1. 按「安装」步骤加载 ZIP 解压出的文件夹：没有报错，并自动打开欢迎页。
2. 按 `Ctrl + T`：显示扩展页面，地址栏为空、光标在地址栏中；如果 Chrome 询问是否保留新标签页的更改，选择保留。
3. 连接自己的门户（HTTPS）：Chrome 弹出权限请求，确认页上的连接码与扩展一致；允许后确认页自动关闭，回到扩展。
4. 再按几次 `Ctrl + T`：首页立刻出现，没有加载闪烁。在开发者工具的 Network 面板中，30 秒内不再请求服务端。
5. 在门户中改动首页（例如移除一个固定网站），30 秒后新开一个标签页：先显示旧内容，随即自动更新。
6. 断开网络后新开标签页：导航照常显示，服务状态显示为离线；恢复网络后自动同步。
7. 在门户「浏览器扩展」中撤销此设备，30 秒后新开标签页：提示授权已失效，原导航不再显示。
8. 在扩展设置中依次试「立即同步」「清理缓存」「更换服务器」「断开连接」：都有明确结果提示；断开后，`chrome://extensions` › 详情 › 网站访问权限中，不再有该地址。
9. 窄窗口（宽度小于 900 px）下，新标签页切换为手机布局，长按菜单只有打开、在设置中编辑等只读操作。

## 已验证与未验证

- **自动化已覆盖**：
  - 服务端：配对、批准与拒绝、限流、只读令牌、304、撤销、改密码失效、Origin 检查范围
  - 扩展单元测试：同步引擎的各种失败情况、配对、地址校验、缓存淘汰
  - Chromium 端到端：上面列出的流程
  - 门户原有的全部单元测试和端到端测试，以及 Docker 镜像构建和冒烟测试
- **尚未自动验证，需要按上节手动检查**：
  - 品牌版 Chrome 中的 `Ctrl + T` 行为、权限弹窗、「保留更改」提示（自动化只能用 Chromium 打开 `chrome://newtab`）
  - 开发者模式扩展在 Chrome 启动时可能出现的提示
  - Edge 中的安装与使用
  - 真实 Cloudflare 链路下的 304（服务端已兼容弱 ETag）

## 上架 Chrome Web Store 还需要

- 注册开发者账号（一次性费用），准备商店素材：128 px 图标（已有）、1280×800 截图、宣传图、简介和详细说明。
- 隐私声明：说明数据只在用户自己的 Nexus Portal 与本机之间传输，不收集、不出售、不分享；填写数据使用披露表。
- 在审核说明中写明以下理由：
  - 权限：只有 `storage`；网站访问声明为可选，按用户填写的地址请求。宽泛的 `optional_host_permissions` 可能触发人工审核，需要解释用户自部署、地址不固定。
  - 单一用途：替换新标签页显示用户自己的导航。
- 商店分配的扩展 ID 与开发者模式不同：已安装的开发者版本需要重新连接一次。
- 可以接入自动发布：在扩展工作流中增加一个任务，用 Chrome Web Store API（需要 OAuth 客户端与 refresh token，存为仓库 Secret）上传同一个 ZIP。现有产物和版本号流程已经满足要求。
- Edge 加载项商店可以直接使用同一个包（Chromium 内核）；Firefox 需要另做适配（`browser_specific_settings`、权限模型差异），本次不包含。

## 常见问题

- **连接时提示「不是 Nexus Portal，或服务端版本低于 0.3.0」**：先升级服务端，或检查地址是否正确（只需要域名，例如 `https://nexus.example.com`）。
- **一直显示「暂时无法连接」**：
  - 用浏览器直接打开 `https://你的地址/api/healthz`，确认服务可以访问。
  - 服务端返回重定向（例如 http 跳转到 https）时，扩展不会跟随，请直接填写最终地址。
- **图标显示为文字**：图标还在下载，或图标源暂时不可用，稍后会自动补上。
- **想彻底清除扩展的数据**：在扩展设置中「断开连接」，或直接在 `chrome://extensions` 中移除扩展。
