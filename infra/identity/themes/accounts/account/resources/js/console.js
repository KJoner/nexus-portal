// 账号中心 · 账号控制台（UI v2，v12.0.3）：三件小事，不改 React 渲染的内容。
//
// 1. 产品强调色：从产品打开时地址带 ?referrer=<client>。Keycloak 核对过这个 client 之后才会在页面的
//    environment 里给出 referrerName（「返回 …」链接也靠它）；只有核对通过、且是我们的两个 client 时，
//    才在 <html> 上标 data-ac-product，样式据此换 LiteSync 紫或 Nexus 琥珀。其余情况用中性墨色。
// 2. 深浅色：用户在登录页右上角选过（同一域名的 localStorage「ac-theme」）就沿用；没选过跟随系统——
//    那由 index.ftl 里 Keycloak 自带的脚本负责，它先运行，这里在系统切换时再按用户的选择改回来。
// 3. 窄屏页签：样式把左侧导航改成主区上方一直可见的页签（css/accounts.css），但 PatternFly 在窄屏「菜单收起」时
//    会给导航容器加 aria-hidden、给每个链接加 tabindex="-1"，读屏和键盘就到不了这几个页签。窄屏下把这两个属性
//    去掉；宽屏（≥ 1200 px）不动。
// 4. 窄屏页头里的账号菜单按钮（⋮，里面是「退出登录」）没有名字，读屏只会念「按钮」：补一个 aria-label。
const root = document.documentElement;

try {
  const env = JSON.parse(document.getElementById('environment')?.textContent || '{}');
  const referrer = new URLSearchParams(location.search).get('referrer');
  const product = { 'litesync-web': 'litesync', 'nexus-web': 'nexus' }[referrer || ''];
  if (env.referrerName && product) root.dataset.acProduct = product;
} catch {
  /* 拿不到就用中性色 */
}

const KEY = 'ac-theme';
const DARK = 'pf-v5-theme-dark';
const stored = () => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};
const apply = () => {
  const choice = stored();
  if (choice) root.classList.toggle(DARK, choice === 'dark');
};
apply();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
window.addEventListener('storage', (event) => {
  if (event.key === KEY) apply();
});

const narrow = window.matchMedia('(max-width: 1199.98px)');
const menuLabel = (root.lang || '').startsWith('en') ? 'Account menu' : '账号菜单';
const tidy = () => {
  for (const toggle of document.querySelectorAll('.pf-v5-c-masthead button.pf-v5-c-menu-toggle.pf-m-plain:not([aria-label])')) {
    if (!toggle.textContent.trim()) toggle.setAttribute('aria-label', menuLabel);
  }
  if (!narrow.matches) return;
  const sidebar = document.querySelector('.pf-v5-c-page__sidebar');
  if (!sidebar) return;
  if (sidebar.getAttribute('aria-hidden') === 'true') sidebar.removeAttribute('aria-hidden');
  if (sidebar.inert) sidebar.inert = false;
  for (const link of sidebar.querySelectorAll('.pf-v5-c-nav__link[tabindex="-1"]')) link.removeAttribute('tabindex');
};
new MutationObserver(tidy).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['aria-hidden', 'inert', 'tabindex'],
});
narrow.addEventListener('change', tidy);
tidy();
