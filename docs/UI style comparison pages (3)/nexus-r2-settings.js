// Nexus R2 settings — demo config model, validators and shared helpers (desktop + mobile settings).
(function () {
  const R = () => window.NX_R1;
  const DI = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
  const TONES = [['#40372c', '#29241e'], ['#333d35', '#222924'], ['#323842', '#22262c'], ['#3d3236', '#282225']];
  const LAN = { litebox: 'http://192.168.1.10:8008', obsync: '', linkwarden: 'http://192.168.1.20:3000' };
  const EXT = { litebox: 'https://probe.example.net', obsync: 'https://obsync.example.net', linkwarden: 'https://links.example.net' };
  const HEALTH = { litebox: '/api/status', obsync: '/healthz', linkwarden: '/api/v1/health' };

  function initial() {
    const D = R();
    const sites = D.APPS.map(a => ({ id: a.id, name: a.name, type: 'site', url: 'https://' + a.domain, lan: '', prefer: 'ext', cat: a.cat, pin: !!a.pin, hidden: false,
      iconSrc: 'library', icon: a.icon, letter: '', tone: 0, openIn: 'same', health: { on: false, url: '', every: 60 } }));
    const services = D.HOSTED.map((h, i) => ({ id: h.id, name: h.name, desc: h.desc, type: 'service', url: EXT[h.id], lan: LAN[h.id], prefer: h.id === 'litebox' ? 'lan' : 'ext', cat: 'hosted', pin: true, hidden: false,
      iconSrc: 'builtin', glyph: h.glyph, toneArr: h.tone, letter: '', tone: i, openIn: 'same', health: { on: h.id !== 'obsync', url: HEALTH[h.id], every: 60 } }));
    return {
      apps: [...services, ...sites],
      cats: [{ id: 'hosted', label: '我的服务', locked: true }, ...D.CATS.map(c => ({ ...c })), { id: 'none', label: '未分类', locked: true }],
      engines: [
        { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', key: 'g', builtin: true, icon: DI + 'google.svg' },
        { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', key: 'b', builtin: true, icon: DI + 'bing.svg' },
        { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', key: 'd', builtin: true, icon: DI + 'duckduckgo.svg' },
        { id: 'links', name: 'Linkwarden 收藏', url: 'links.example.net/search?q=%s', key: 'lw', builtin: true, linkwarden: true },
        { id: 'ghcode', name: 'GitHub 代码', url: 'https://github.com/search?q=%s&type=code', key: 'gh', builtin: false, icon: DI + 'github.svg' },
      ],
      search: { def: 'google', suggest: true, history: true, historyDays: 30, linkwarden: true, apps: true },
      look: { wall: 'fallingwater', focal: [50, 42], overlay: 48, brightness: 100, blur: 0, theme: 'dark', clock: '24', date: true, seconds: false, icon: 'm', motion: 'full' },
      home: { sites: 5, services: true, mobileRows: 2, labels: true, recent: true },
      privacy: { guest: false, recent: true, localIcons: true },
    };
  }

  const WALLS = [
    { id: 'fallingwater', name: '流水别墅', kind: 'photo', src: 'assets/wallpaper.jpg', credit: '示例照片' },
    { id: 'ember', name: '暖炭', kind: 'color', bg: 'linear-gradient(160deg,#3a3129 0%,#1d1a16 70%)' },
    { id: 'moss', name: '夜苔', kind: 'color', bg: 'linear-gradient(160deg,#2f3a31 0%,#181c18 70%)' },
    { id: 'slate', name: '石墨', kind: 'color', bg: 'linear-gradient(160deg,#30353d 0%,#17191d 70%)' },
  ];

  const isUrl = s => /^https?:\/\/[\w.-]+(:\d+)?(\/\S*)?$/i.test((s || '').trim());
  const hostOf = s => { try { return new URL(s).host; } catch (_) { return ''; } };
  const slug = s => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function validateApp(d, apps) {
    const e = {}, w = {};
    if (!d.name.trim()) e.name = '请填写名称';
    else if (d.name.trim().length > 16) e.name = '名称最多 16 个字符，首页会截断显示';
    if (!d.url.trim()) e.url = d.type === 'service' ? '请填写外网地址' : '请填写网址';
    else if (!isUrl(d.url)) e.url = '请输入完整网址，以 http:// 或 https:// 开头';
    if (d.type === 'service' && d.lan.trim() && !isUrl(d.lan)) e.lan = '内网地址格式不正确，例如 http://192.168.1.20:3000';
    if (d.type === 'service' && d.prefer === 'lan' && !d.lan.trim()) e.lan = '默认打开内网时，需要填写内网地址';
    const dup = apps.find(a => a.id !== d.id && hostOf(a.url) && hostOf(a.url) === hostOf(d.url));
    if (dup && !e.url) w.url = `与「${dup.name}」的地址相同，两个入口都会保留`;
    if (d.health.on && d.health.url.trim() && !d.health.url.trim().startsWith('/') && !isUrl(d.health.url)) e.health = '填写路径（如 /api/health）或完整网址';
    return { e, w, ok: !Object.keys(e).length };
  }

  function validateEngine(d, engines) {
    const e = {};
    if (!d.name.trim()) e.name = '请填写名称';
    if (!d.url.includes('%s')) e.url = '网址中需要包含 %s，用来代替搜索词';
    else if (!isUrl(d.url)) e.url = '请输入完整网址';
    if (d.key && engines.find(x => x.id !== d.id && x.key === d.key.trim())) e.key = `前缀「${d.key}」已被使用`;
    return { e, ok: !Object.keys(e).length };
  }

  function tile(a) {
    const D = R();
    if (!a) return { tileBg: 'transparent', tileShadow: 'none', glyph: 'none', gsize: '0', letter: '', letterD: 'none' };
    if (a.iconSrc === 'letter' || (a.iconSrc === 'upload' && !a.upload) || (a.iconSrc === 'library' && a.libMiss)) {
      const t = TONES[a.tone % TONES.length];
      return { tileBg: `linear-gradient(180deg,${t[0]} 0%,${t[1]} 100%)`, tileShadow: D.emberShadow, glyph: 'none', gsize: '0', letter: (a.letter || a.name || '?').slice(0, 2), letterD: 'grid' };
    }
    if (a.iconSrc === 'builtin') return { ...D.tileOf({ hosted: true, tone: a.toneArr, glyph: a.glyph }), letter: '', letterD: 'none' };
    const src = a.iconSrc === 'upload' ? a.upload : a.iconSrc === 'auto' ? `https://icons.duckduckgo.com/ip3/${hostOf(a.url) || 'example.com'}.ico` : a.icon;
    if (a.type === 'service') { const t = TONES[a.tone % TONES.length]; return { tileBg: `linear-gradient(180deg,${t[0]} 0%,${t[1]} 100%)`, tileShadow: D.emberShadow, glyph: `url("${src}")`, gsize: '58%', letter: '', letterD: 'none' }; }
    return { tileBg: D.PORCELAIN.bg, tileShadow: D.PORCELAIN.shadow, glyph: `url("${src}")`, gsize: '54%', letter: '', letterD: 'none' };
  }

  function blankApp(type) {
    return { id: 'new-' + Date.now(), name: '', desc: '', type: type || 'site', url: '', lan: '', prefer: 'ext', cat: type === 'service' ? 'hosted' : 'none', pin: false, hidden: false,
      iconSrc: 'auto', icon: '', letter: '', tone: 0, openIn: 'same', health: { on: false, url: '/api/health', every: 60 } };
  }

  // Demo connection test: deterministic outcome from the address.
  function testHealth(d) {
    const base = d.prefer === 'lan' && d.lan ? d.lan : d.url;
    if (!isUrl(base)) return { ok: false, text: '地址无效，无法测试' };
    if (/fail|offline|:9999/.test(base + d.health.url)) return { ok: false, text: '连接超时（5 秒）· 检查地址或防火墙' };
    if (/^http:\/\/(192\.168|10\.|172\.)/.test(base) && d.prefer === 'lan') return { ok: true, text: '200 OK · 12 ms（内网）' };
    return { ok: true, text: '200 OK · 86 ms' };
  }

  const INDEX = [
    ['appearance', '壁纸', '更换、上传、焦点'], ['appearance', '背景遮罩与亮度', '遮罩 亮度 模糊'], ['appearance', '主题', '深色 浅色 跟随系统'],
    ['appearance', '时间与日期', '24 小时 秒 日期'], ['appearance', '图标尺寸', '小 中 大'], ['appearance', '动画强度', '减少动态效果'],
    ['home', '首页快捷方式', '固定 排序 隐藏'], ['home', '布局偏好', 'Dock 数量 手机行数 标签'], ['home', '已隐藏的应用', '恢复'],
    ['apps', '新增应用', '名称 网址 图标'], ['apps', '分类管理', '分类 重命名'], ['apps', '健康检查', '监测 状态'], ['apps', '内外网地址', '内网 外网 局域网'],
    ['search', '默认搜索引擎', 'google bing'], ['search', '自定义引擎', '%s 前缀'], ['search', '搜索建议', '联想'], ['search', '搜索历史', '清除'], ['search', 'Linkwarden 收藏搜索', '书签'],
    ['data', '配置同步', '设备 同步'], ['data', '导入与导出', 'json 备份'], ['data', '隐私', '访客 最近'], ['data', '登录状态', '账户'], ['data', '重置设置', '恢复默认'],
  ].map(([page, label, kw]) => ({ page, label, kw }));

  const PAGES = [
    { id: 'appearance', label: '外观与个性化', icon: 'palette', sub: '壁纸、主题、时间、图标与动画' },
    { id: 'home', label: '首页与快捷方式', icon: 'house', sub: '固定、排序、隐藏与布局' },
    { id: 'apps', label: '应用与服务', icon: 'layout-grid', sub: '新增、编辑、分类与健康检查' },
    { id: 'search', label: '搜索', icon: 'search', sub: '引擎、建议、历史与收藏' },
    { id: 'data', label: '数据、同步与安全', icon: 'shield-check', sub: '导入导出、隐私、登录与重置' },
  ];

  window.NX_R2 = { initial, WALLS, TONES, isUrl, hostOf, slug, validateApp, validateEngine, tile, blankApp, testHealth, INDEX, PAGES, DI };
})();
