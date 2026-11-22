// 账号中心：手动切换深浅色（UI v2）。没选过就跟随系统——那由 template.ftl 里 Keycloak 自带的脚本负责；
// 选过之后记在本域名的 localStorage（键 ac-theme，值 light / dark），系统切换时仍以用户的选择为准。
// 存不下（隐私模式、禁用存储）时只对当前页面生效。
const KEY = 'ac-theme';
const DARK = 'pf-v5-theme-dark';
const root = document.documentElement;

const stored = () => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};
const remember = (value) => {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* only this page */
  }
};
const apply = (dark) => root.classList.toggle(DARK, dark);

const initial = stored();
if (initial) apply(initial === 'dark');
// Keycloak's own listener follows the system; it was registered first, so this one runs after it.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const choice = stored();
  if (choice) apply(choice === 'dark');
});

function setup() {
  const button = document.getElementById('ac-theme-toggle');
  if (!button) return;
  const label = () => button.setAttribute('aria-label', root.classList.contains(DARK) ? button.dataset.labelLight : button.dataset.labelDark);
  button.hidden = false;
  label();
  button.addEventListener('click', () => {
    const dark = !root.classList.contains(DARK);
    apply(dark);
    remember(dark ? 'dark' : 'light');
    label();
  });
  new MutationObserver(label).observe(root, { attributes: true, attributeFilter: ['class'] });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
else setup();
