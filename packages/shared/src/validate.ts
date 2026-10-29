import type { AppEntry, Engine } from './schema';
import { hostOf } from './url';

const HTTP = /^https?:\/\/[^\s/?#]+(?::\d+)?(?:[/?#]\S*)?$/i;

export const isHttpUrl = (s: string) => HTTP.test(s.trim()) && hostOf(s.trim()) !== '';

export interface Validation {
  errors: Partial<Record<'name' | 'url' | 'lanUrl' | 'health' | 'letter', string>>;
  warnings: Partial<Record<'url' | 'name', string>>;
  ok: boolean;
}

/** Field rules from R2 · 输入框与错误: errors block saving, warnings do not. */
export function validateApp(d: AppEntry, apps: readonly AppEntry[]): Validation {
  const errors: Validation['errors'] = {};
  const warnings: Validation['warnings'] = {};
  const svc = d.kind === 'service';
  if (!d.name.trim()) errors.name = '请填写名称';
  else if (d.name.trim().length > 16) errors.name = '名称最多 16 个字符，首页会截断显示';
  if (!d.url.trim()) errors.url = svc ? '请填写外网地址' : '请填写网址';
  else if (!isHttpUrl(d.url)) errors.url = '请输入完整网址，以 http:// 或 https:// 开头';
  if (svc && d.lanUrl.trim() && !isHttpUrl(d.lanUrl)) errors.lanUrl = '内网地址格式不正确，例如 http://192.168.1.20:3000';
  if (svc && d.prefer === 'lan' && !d.lanUrl.trim()) errors.lanUrl = '默认打开内网时，需要填写内网地址';
  if (d.health.enabled) {
    const t = d.health.target.trim();
    if (!t) errors.health = '填写路径（如 /api/health）或完整网址';
    else if (!t.startsWith('/')) {
      if (!isHttpUrl(t)) errors.health = '填写路径（如 /api/health）或完整网址';
      // The checker only ever contacts the app's own hosts (SSRF guard), so say so up front.
      else if (hostOf(t) !== hostOf(d.url) && hostOf(t) !== hostOf(d.lanUrl)) errors.health = '检查地址必须与外网或内网地址同一主机';
    }
  }
  if (d.icon.source === 'letter' && !d.icon.letter.trim() && !d.name.trim()) errors.letter = '请填写图标字母';
  const dup = apps.find((a) => a.id !== d.id && hostOf(a.url) && hostOf(a.url) === hostOf(d.url));
  if (dup && !errors.url) warnings.url = `与「${dup.name}」的地址相同，两个入口都会保留`;
  const name = d.name.trim().toLowerCase();
  const twin = name && apps.find((a) => a.id !== d.id && a.name.trim().toLowerCase() === name);
  if (twin && !errors.name) warnings.name = '已有同名应用，搜索时两个都会出现；可以改个名字或加别名区分';
  return { errors, warnings, ok: Object.keys(errors).length === 0 };
}

export function validateEngine(d: Pick<Engine, 'id' | 'name' | 'urlTemplate' | 'prefix'>, engines: readonly Engine[]) {
  const errors: Partial<Record<'name' | 'url' | 'prefix', string>> = {};
  if (!d.name.trim()) errors.name = '请填写名称';
  if (!d.urlTemplate.includes('%s')) errors.url = '网址中需要包含 %s，用来代替搜索词';
  else if (!isHttpUrl(d.urlTemplate.replace('%s', 'q'))) errors.url = '请输入完整网址';
  const prefix = d.prefix.trim().toLowerCase();
  if (prefix && !/^[a-z0-9]{1,8}$/.test(prefix)) errors.prefix = '前缀只能是 1–8 个字母或数字';
  else if (prefix) {
    const clash = engines.find((e) => e.id !== d.id && e.prefix.toLowerCase() === prefix);
    if (clash) errors.prefix = `前缀「${prefix}」已被 ${clash.name} 使用`;
  }
  return { errors, ok: Object.keys(errors).length === 0 };
}

/** Lower-case slug for ids and icon-library lookups. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function newAppId(name: string, apps: readonly AppEntry[]): string {
  const base = slug(name).slice(0, 40) || 'app';
  let id = base;
  for (let i = 2; apps.some((a) => a.id === id); i++) id = `${base}-${i}`;
  return id;
}
