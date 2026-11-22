// 首帧主题（UI v2 · v12.0.3）。在样式表和应用脚本之前，按这个浏览器上次显示的主题设置 <html data-theme>，
// 浅色或「跟随系统」的用户打开页面时不再先闪一下深色。只读 lib/theme.ts 写入的 localStorage「nexus.theme.v1」
// （JSON 字符串 "dark" / "light" / "auto"）；读不到或出错就保持深色，与没有这个脚本时相同。
// 必须是同源的普通脚本：页面 CSP 是 script-src 'self'，不能内联。
(function () {
  try {
    var raw = window.localStorage.getItem('nexus.theme.v1');
    var choice = raw ? JSON.parse(raw) : null;
    var light =
      choice === 'light' ||
      (choice === 'auto' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    var theme = light ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
  } catch (e) {
    /* 保持深色 */
  }
})();
