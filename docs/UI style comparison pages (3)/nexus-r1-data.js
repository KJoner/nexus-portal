// Nexus R1 Atmospheric — shared catalog, custom icons, status scenarios and search model.
(function () {
  const DI = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
  const svg = s => 'data:image/svg+xml,' + encodeURIComponent(s);

  const GLYPH = {
    litebox: svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 4.6 26.6 10.4 16 16.2 5.4 10.4Z' fill='#F1C88C'/><path d='M5.4 10.4 16 16.2V27.6L5.4 21.8Z' fill='#E6C08A' fill-opacity='.46'/><path d='M26.6 10.4 16 16.2V27.6L26.6 21.8Z' fill='#E6C08A' fill-opacity='.24'/><path d='M16 4.6 26.6 10.4' stroke='#FFF3DE' stroke-opacity='.7' stroke-width='.8'/></svg>`),
    obsync: svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none' stroke='#C4D7BE' stroke-width='2.3' stroke-linecap='round' stroke-linejoin='round'><path d='M7.35 13.5A9 9 0 0 1 23.8 11.5'/><path d='M24.35 8.35 23.8 11.5 20.8 10.4'/><path d='M24.65 18.5A9 9 0 0 1 8.2 20.5'/><path d='M7.65 23.65 8.2 20.5 11.2 21.6'/><path d='M16 12.2 19 16 16 19.8 13 16Z' fill='#C4D7BE' stroke='none'/></svg>`),
    linkwarden: svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M10 5.2h12a1.6 1.6 0 0 1 1.6 1.6v20.4l-7.6-4.9-7.6 4.9V6.8A1.6 1.6 0 0 1 10 5.2z' fill='#C3CFDE'/><g fill='none' stroke='#262A30' stroke-width='1.7'><circle cx='14.2' cy='12.6' r='2.9'/><circle cx='17.8' cy='16.2' r='2.9'/></g></svg>`),
    all: svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='#EFEAE1'><circle cx='9' cy='9' r='2.1'/><circle cx='16' cy='9' r='2.1'/><circle cx='23' cy='9' r='2.1'/><circle cx='9' cy='16' r='2.1'/><circle cx='16' cy='16' r='2.1'/><circle cx='23' cy='16' r='2.1'/><circle cx='9' cy='23' r='2.1'/><circle cx='16' cy='23' r='2.1'/><circle cx='23' cy='23' r='2.1'/></svg>`),
  };

  const CATS = [
    { id: 'dev', label: '开发' },
    { id: 'work', label: '工作' },
    { id: 'media', label: '影音与社区' },
  ];
  const APPS = [
    { id: 'github', name: 'GitHub', domain: 'github.com', icon: DI + 'github.svg', cat: 'dev', pin: true },
    { id: 'gmail', name: 'Gmail', domain: 'mail.google.com', icon: DI + 'gmail.svg', cat: 'work', pin: true },
    { id: 'youtube', name: 'YouTube', domain: 'youtube.com', icon: DI + 'youtube.svg', cat: 'media', pin: true },
    { id: 'bilibili', name: '哔哩哔哩', domain: 'bilibili.com', icon: 'https://cdn.simpleicons.org/bilibili', cat: 'media', pin: true, alias: 'bilibili b站' },
    { id: 'notion', name: 'Notion', domain: 'notion.so', icon: DI + 'notion.svg', cat: 'work', pin: true },
    { id: 'vercel', name: 'Vercel', domain: 'vercel.com', icon: DI + 'vercel.svg', cat: 'dev' },
    { id: 'cloudflare', name: 'Cloudflare', domain: 'dash.cloudflare.com', icon: DI + 'cloudflare.svg', cat: 'dev' },
    { id: 'figma', name: 'Figma', domain: 'figma.com', icon: DI + 'figma.svg', cat: 'work' },
    { id: 'gdrive', name: '云端硬盘', domain: 'drive.google.com', icon: DI + 'google-drive.svg', cat: 'work', alias: 'google drive' },
    { id: 'gcal', name: '日历', domain: 'calendar.google.com', icon: DI + 'google-calendar.svg', cat: 'work', alias: 'google calendar' },
    { id: 'chatgpt', name: 'ChatGPT', domain: 'chatgpt.com', icon: DI + 'chatgpt.svg', cat: 'work' },
    { id: 'claude', name: 'Claude', domain: 'claude.ai', icon: DI + 'claude-ai.svg', cat: 'work' },
    { id: 'spotify', name: 'Spotify', domain: 'open.spotify.com', icon: DI + 'spotify.svg', cat: 'media' },
    { id: 'reddit', name: 'Reddit', domain: 'reddit.com', icon: DI + 'reddit.svg', cat: 'media' },
    { id: 'x', name: 'X', domain: 'x.com', icon: DI + 'x.svg', cat: 'media', alias: 'twitter' },
    { id: 'telegram', name: 'Telegram', domain: 'web.telegram.org', icon: DI + 'telegram.svg', cat: 'media' },
  ];
  const HOSTED = [
    { id: 'litebox', name: 'LiteBox', domain: 'litebox.home', desc: '服务器探针', glyph: GLYPH.litebox, tone: ['#40372c', '#29241e'] },
    { id: 'obsync', name: 'OBsync', domain: 'obsync.home', desc: '笔记同步', glyph: GLYPH.obsync, tone: ['#333d35', '#222924'] },
    { id: 'linkwarden', name: 'Linkwarden', domain: 'links.home', desc: '书签归档', glyph: GLYPH.linkwarden, tone: ['#323842', '#22262c'] },
  ];

  const LEVEL = {
    ok: { color: '#a7bf9f', label: '正常' },
    warn: { color: '#e3a35b', label: '警告' },
    error: { color: '#e9765f', label: '异常' },
    unknown: { color: '#9a948a', label: '未知' },
    off: { color: 'transparent', label: '未监测' },
  };
  const SCENARIOS = {
    ok: { litebox: ['ok', '12 个节点在线'], obsync: ['ok', '20 分钟前已同步'], linkwarden: ['ok', '1,284 条收藏'] },
    warn: { litebox: ['ok', '12 个节点在线'], obsync: ['warn', '2 个文件同步冲突', '处理冲突'], linkwarden: ['ok', '1,284 条收藏'] },
    error: { litebox: ['error', 'hk-02 离线 3 分钟', '查看节点'], obsync: ['warn', '2 个文件同步冲突', '处理冲突'], linkwarden: ['ok', '1,284 条收藏'] },
    unknown: { litebox: ['ok', '12 个节点在线'], obsync: ['ok', '20 分钟前已同步'], linkwarden: ['unknown', '检查端点 15 分钟无响应', '重试'] },
    off: { litebox: ['ok', '12 个节点在线'], obsync: ['off', '未开启健康检查', '开启'], linkwarden: ['ok', '1,284 条收藏'] },
    all: { litebox: ['error', 'hk-02 离线 3 分钟', '查看节点'], obsync: ['warn', '2 个文件同步冲突', '处理冲突'], linkwarden: ['unknown', '检查端点 15 分钟无响应', '重试'] },
  };

  const PORCELAIN = { bg: 'linear-gradient(180deg,#f7f3ec 0%,#e6e0d5 100%)', shadow: 'inset 0 1px 0 rgba(255,255,255,0.75), inset 0 -1px 0 rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.2), 0 8px 18px -6px rgba(0,0,0,0.45)' };
  const emberShadow = 'inset 0 1px 0 rgba(255,255,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.045), 0 1px 1px rgba(0,0,0,0.25), 0 8px 18px -6px rgba(0,0,0,0.5)';
  const GLASS = { bg: 'rgba(239,234,225,0.1)', shadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(239,234,225,0.08)' };

  function tileOf(a) {
    if (a.kind === 'all') return { tileBg: GLASS.bg, tileShadow: GLASS.shadow, glyph: `url("${GLYPH.all}")`, gsize: '46%' };
    if (a.hosted) return { tileBg: `linear-gradient(180deg,${a.tone[0]} 0%,${a.tone[1]} 100%)`, tileShadow: emberShadow, glyph: `url("${a.glyph}")`, gsize: '64%' };
    return { tileBg: PORCELAIN.bg, tileShadow: PORCELAIN.shadow, glyph: `url("${a.icon}")`, gsize: '54%' };
  }

  function hosted(scn) {
    const S = SCENARIOS[scn] || SCENARIOS.ok;
    return HOSTED.map(h => {
      const [level, text, action] = S[h.id];
      const L = LEVEL[level];
      return { ...h, hosted: true, level, text, action: action || '打开', color: L.color, levelLabel: L.label,
        textColor: level === 'ok' ? 'rgba(239,234,225,0.58)' : level === 'unknown' ? 'rgba(239,234,225,0.66)' : level === 'off' ? 'rgba(239,234,225,0.44)' : L.color,
        dotRing: level === 'off' ? 'inset 0 0 0 1.5px rgba(239,234,225,0.38)' : 'none',
        badgeD: level === 'warn' || level === 'error' ? 'block' : 'none', ...tileOf({ ...h, hosted: true }) };
    });
  }

  function summary(scn) {
    const hs = hosted(scn);
    const err = hs.filter(h => h.level === 'error'), warn = hs.filter(h => h.level === 'warn'), unk = hs.filter(h => h.level === 'unknown'), off = hs.filter(h => h.level === 'off');
    if (err.length) return { level: 'error', color: LEVEL.error.color, text: `${err[0].name} 节点离线`, more: warn.length ? `另有 ${warn.length} 项提醒` : '',
      bg: 'rgba(233,118,95,0.2)', fg: '#f6b3a4', ring: 'inset 0 0 0 1px rgba(233,118,95,0.36)' };
    if (warn.length) return { level: 'warn', color: LEVEL.warn.color, text: `${warn[0].name} 需要处理`, more: '',
      bg: 'rgba(227,163,91,0.17)', fg: '#f1c690', ring: 'inset 0 0 0 1px rgba(227,163,91,0.3)' };
    if (unk.length) return { level: 'unknown', color: LEVEL.unknown.color, text: `${unk[0].name} 状态未知`, more: '',
      bg: 'rgba(26,25,22,0.4)', fg: 'rgba(239,234,225,0.8)', ring: 'inset 0 0 0 1px rgba(239,234,225,0.16)' };
    return { level: 'ok', color: LEVEL.ok.color, text: `${hs.length - off.length} 项服务正常`, more: off.length ? `${off.length} 项未监测` : '',
      bg: 'rgba(26,25,22,0.34)', fg: 'rgba(239,234,225,0.74)', ring: 'inset 0 0 0 1px rgba(239,234,225,0.06)' };
  }

  const ENGINES = [
    { id: 'google', name: 'Google', icon: DI + 'google.svg' },
    { id: 'bing', name: 'Bing', icon: DI + 'bing.svg' },
    { id: 'duckduckgo', name: 'DuckDuckGo', icon: DI + 'duckduckgo.svg' },
    { id: 'links', name: '我的收藏', icon: GLYPH.linkwarden },
  ];

  const BOOKMARKS = [
    { title: 'CSS Anchor Positioning 指南', domain: 'developer.chrome.com', tags: 'css anchor 前端' },
    { title: 'Rust 异步编程入门', domain: 'rust-lang.github.io', tags: 'rust async' },
    { title: '家庭服务器备份策略', domain: 'blog.example.com', tags: 'backup nas 备份 self-host' },
    { title: 'Tailscale 子网路由配置', domain: 'tailscale.com', tags: 'tailscale vpn 网络' },
    { title: 'Figma 变量与模式', domain: 'help.figma.com', tags: 'figma design' },
    { title: 'Linkwarden API 文档', domain: 'docs.linkwarden.app', tags: 'linkwarden api link' },
  ];

  const I = () => window.NX_ICONS || {};
  const appIcon = a => ({ ...tileOf(a), mask: 'none', maskBg: 'transparent' });
  const sysIcon = key => ({ tileBg: 'rgba(239,234,225,0.08)', tileShadow: 'inset 0 0 0 1px rgba(239,234,225,0.06)', glyph: 'none', gsize: '50%', mask: I()[key] || 'none', maskBg: 'rgba(239,234,225,0.82)' });
  const engIcon = e => e.id === 'links' ? { ...tileOf(HOSTED[2] && { ...HOSTED[2], hosted: true }), mask: 'none', maskBg: 'transparent' } : { tileBg: PORCELAIN.bg, tileShadow: PORCELAIN.shadow, glyph: `url("${e.icon}")`, gsize: '54%', mask: 'none', maskBg: 'transparent' };

  function idle() {
    const gh = APPS[0], lb = HOSTED[0], lw = HOSTED[2];
    return [
      { title: '最近', rows: [
        { title: 'nexus-portal', sub: 'github.com/you/nexus-portal', meta: '12 分钟前', ...appIcon(gh) },
        { title: '节点 hk-02', sub: 'LiteBox', meta: '1 小时前', ...appIcon({ ...lb, hosted: true }) },
        { title: 'CSS Anchor Positioning 指南', sub: 'Linkwarden 收藏', meta: '昨天', ...appIcon({ ...lw, hosted: true }) },
      ] },
      { title: '快捷操作', rows: [
        { title: '打开运行概览', sub: '3 项自托管服务', meta: '', ...sysIcon('activity') },
        { title: '收藏当前剪贴板链接', sub: '保存到 Linkwarden', meta: '', ...sysIcon('bookmark') },
        { title: '更换壁纸', sub: '流水别墅 · 第 3 / 12 张', meta: '', ...sysIcon('image') },
      ] },
    ];
  }

  const isUrl = q => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(q.trim());

  function search(q, engineId, opts) {
    const s = q.trim(), l = s.toLowerCase();
    if (!s) return idle();
    const eng = ENGINES.find(e => e.id === engineId) || ENGINES[0];
    const max = (opts && opts.max) || 3;
    const all = [...HOSTED.map(h => ({ ...h, hosted: true })), ...APPS];
    const apps = all.filter(a => (a.name + ' ' + a.domain + ' ' + (a.alias || '')).toLowerCase().includes(l)).slice(0, max)
      .map(a => ({ title: a.name, sub: a.domain, meta: a.hosted ? '自托管' : '应用', ...appIcon(a) }));
    const marks = BOOKMARKS.filter(b => (b.title + ' ' + b.domain + ' ' + b.tags).toLowerCase().includes(l)).slice(0, 2)
      .map(b => ({ title: b.title, sub: b.domain, meta: '收藏', ...appIcon({ ...HOSTED[2], hosted: true }) }));
    const webEng = eng.id === 'links' ? ENGINES[0] : eng;
    const web = { title: `在 ${webEng.name} 中搜索「${s}」`, sub: '网页搜索', meta: '', ...engIcon(webEng) };
    const out = [];
    if (isUrl(s)) out.push({ title: 'URL', rows: [{ title: `前往 ${s.replace(/^https?:\/\//, '')}`, sub: s.startsWith('http') ? s : 'https://' + s, meta: '', ...sysIcon('globe') }] });
    if (eng.id === 'links' && marks.length) out.push({ title: '收藏', rows: marks });
    if (apps.length) out.push({ title: '应用', rows: apps });
    out.push({ title: '网页', rows: [web] });
    if (eng.id !== 'links' && marks.length) out.push({ title: '收藏', rows: marks });
    out.forEach(sec => { sec.title = sec.title === 'URL' ? '打开网址' : sec.title; });
    return out;
  }

  window.NX_R1 = { DI, GLYPH, CATS, APPS, HOSTED, LEVEL, ENGINES, BOOKMARKS, PORCELAIN, GLASS, emberShadow, tileOf, hosted, summary, idle, search, isUrl, engIcon };
})();
