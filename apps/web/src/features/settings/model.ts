import { homeCapacity, pinnedSites, shownServices, type Config, type Op, type SettingsSection } from '@nexus/shared';
import { House, LayoutGrid, LayoutTemplate, Palette, Search, ShieldCheck, type LucideIcon } from 'lucide-react';
import { toast } from '../../components/toast-store';
import { dispatch } from '../../data/config-store';
import type { WallpaperEntry } from '../home/Wallpaper';

export type PageId = 'appearance' | 'display' | 'home' | 'apps' | 'search' | 'data';

export const PAGES: { id: PageId; label: string; short: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: '外观与个性化', short: '外观与个性化', icon: Palette },
  { id: 'display', label: '首页显示与布局', short: '显示与布局', icon: LayoutTemplate },
  { id: 'home', label: '首页与快捷方式', short: '首页与快捷方式', icon: House },
  { id: 'apps', label: '应用与服务', short: '应用与服务', icon: LayoutGrid },
  { id: 'search', label: '搜索', short: '搜索', icon: Search },
  { id: 'data', label: '数据、同步与安全', short: '数据与安全', icon: ShieldCheck },
];

export const isPage = (p: string | undefined): p is PageId => PAGES.some((x) => x.id === p);

/** Settings search (R2 · 设置搜索): label + keywords → page. */
export const INDEX: { page: PageId; label: string; kw: string }[] = [
  ['appearance', '壁纸', '更换 上传 焦点 背景 图片 图库 每日 unsplash 网址'],
  ['appearance', '自动切换壁纸', '轮换 每天 每小时 每次打开 收藏 不喜欢 锁定'],
  ['display', '首页显示预设', '极简 日常 自定义'],
  ['display', '顶部导航与设置按钮', '导航 标志 logo 状态 设置 隐藏 悬停'],
  ['display', '时钟、搜索框与快捷方式', '隐藏 名称 标签'],
  ['display', '布局微调', '宽度 位置 时钟大小'],
  ['appearance', '背景遮罩与亮度', '遮罩 亮度 模糊'],
  ['appearance', '主题', '深色 浅色 跟随系统'],
  ['appearance', '时间与日期', '24 小时 12 秒 日期 时钟'],
  ['appearance', '图标尺寸', '小 中 大'],
  ['appearance', '动画强度', '减少动态效果 动画 动效'],
  ['home', '首页快捷方式', '固定 排序 移除 dock'],
  ['home', '布局偏好', 'dock 数量 手机行数 标签 名称'],
  ['home', '已隐藏的应用', '恢复 隐藏'],
  ['apps', '新增应用', '名称 网址 图标 添加'],
  ['apps', '分类管理', '分类 重命名'],
  ['apps', '健康检查', '监测 状态'],
  ['apps', '内外网地址', '内网 外网 局域网 lan'],
  ['search', '默认搜索引擎', 'google bing duckduckgo'],
  ['search', '自定义引擎', '%s 前缀'],
  ['search', '搜索历史', '历史 清除 最近'],
  ['search', 'Linkwarden 收藏搜索', '书签 收藏'],
  ['data', '配置同步', '设备 同步 离线'],
  ['data', '导入与导出', 'json 备份 导入 导出'],
  ['data', '隐私', '访客 最近使用'],
  ['data', '登录状态', '账户 退出 登录'],
  ['data', '浏览器扩展', 'chrome edge 扩展 新标签页 设备 授权 连接 撤销'],
  ['data', '重置设置', '恢复默认 重置'],
].map(([page, label, kw]) => ({ page: page as PageId, label: label!, kw: kw! }));

export function searchIndex(q: string) {
  const s = q.trim().toLowerCase();
  return s ? INDEX.filter((x) => (x.label + ' ' + x.kw).toLowerCase().includes(s)) : [];
}

const MOTION = { full: '完整', reduced: '减弱', off: '关闭' } as const;
const ROTATION = { off: '固定壁纸', open: '每次打开换一张', hourly: '每小时换一张', daily: '每天换一张', interval: '定时切换', potd: '每日一图' } as const;
const PRESET = { daily: '日常模式', minimal: '极简模式', custom: '自定义显示' } as const;

export function summaries(c: Config, wp: WallpaperEntry, sync: string): Record<PageId, string> {
  const sites = c.apps.filter((a) => a.kind === 'site');
  const services = c.apps.filter((a) => a.kind === 'service');
  const hidden = c.apps.filter((a) => a.hidden).length;
  const engine = c.engines.find((e) => e.id === c.settings.search.defaultEngine);
  const pins = pinnedSites(c).length;
  const cap = homeCapacity(c);
  return {
    appearance: `${wp.name} · ${ROTATION[c.settings.look.rotation.mode]} · 动画${MOTION[c.settings.look.motion]}`,
    display: `${PRESET[c.settings.ui.preset]} · 搜索面板 ${c.settings.ui.desktop.searchWidth}px`,
    home: `桌面 ${Math.min(pins, cap.desktop)} 个网站 + ${shownServices(c).length} 个服务 · 手机 ${c.settings.home.mobileRows} 行`,
    apps: `${sites.length} 个网站、${services.length} 个自托管服务${hidden ? ` · ${hidden} 个已隐藏` : ''}`,
    search: `默认 ${engine?.name ?? '—'} · ${c.engines.length} 个引擎 · 历史${c.settings.search.history ? '开启' : '关闭'}`,
    data: sync,
  };
}

export interface Attention {
  key: string;
  title: string;
  sub: string;
  action: string;
  dot: string;
  appId: string;
}

/** Only things that can be fixed from settings (R2 · 概览 · 需要注意). */
export function attention(c: Config): Attention[] {
  const out: Attention[] = [];
  for (const a of c.apps.filter((x) => x.kind === 'service' && !x.hidden)) {
    if (!a.health.enabled) out.push({ key: `${a.id}:health`, title: `${a.name} 没有开启健康检查`, sub: '首页会显示为「未监测」，无法提示故障', action: '去开启', dot: 'rgba(239,234,225,0.5)', appId: a.id });
    if (!a.lanUrl) out.push({ key: `${a.id}:lan`, title: `${a.name} 没有内网地址`, sub: '在家中访问时会绕道外网；填写后可选择默认打开内网', action: '编辑', dot: '#e3a35b', appId: a.id });
  }
  return out;
}

/**
 * Writes immediately (R2 · 即时保存). Structural changes pass a message and get an undo toast;
 * plain toggles stay silent and rely on the top bar's save status.
 */
export function apply(ops: Op | Op[], msg?: string, undoable = true): boolean {
  const r = dispatch(ops);
  if (!r.ok) {
    toast({ msg: r.error.message, tone: r.error.code === 'pins_full' ? 'warn' : 'error' });
    return false;
  }
  if (msg && r.changed) toast(undoable ? { msg, tone: 'undo', undo: r.undo } : { msg, tone: 'ok' });
  return true;
}

export const patch = <S extends SettingsSection>(section: S, value: Partial<Config['settings'][S]>, msg?: string) => apply({ type: 'settings.patch', section, patch: value as Record<string, unknown> }, msg);
