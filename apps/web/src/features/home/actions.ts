import { homeCapacity, MAX_PINS, type Op } from '@nexus/shared';
import { toast } from '../../components/toast-store';
import { dispatch, useConfigStore } from '../../data/config-store';
import type { WallpaperEntry } from './Wallpaper';

const cfg = () => useConfigStore.getState().snapshot.config;
const nameOf = (id: string) => cfg().apps.find((a) => a.id === id)?.name ?? id;

/** Structural change → toast with undo (R1.5 · 每次结构性改动后 5 秒内可撤销). */
function commit(op: Op, msg: string, onFull?: () => void): boolean {
  const r = dispatch(op);
  if (!r.ok) {
    if (r.error.code === 'pins_full') {
      toast({ msg: `首页最多固定 ${MAX_PINS} 个网站`, tone: 'warn', action: onFull ? { label: '编辑首页', run: onFull } : undefined });
    } else {
      toast({ msg: r.error.message, tone: 'error' });
    }
    return false;
  }
  if (r.changed) toast({ msg, tone: 'undo', undo: r.undo });
  return true;
}

export const homeActions = {
  pin(appId: string, onFull?: () => void) {
    const position = cfg().pins.length + 1;
    const { desktop } = homeCapacity(cfg());
    const single = cfg().settings.home.shortcuts.mode === 'single';
    const extra = position <= desktop ? '' : single ? `；桌面首排只显示前 ${desktop} 个` : '，位于桌面扩展区';
    commit({ type: 'pin.add', appId }, `已固定 ${nameOf(appId)} 到首页${extra}`, onFull);
  },
  unpin(appId: string) {
    commit({ type: 'pin.remove', appId }, `已从首页移除 ${nameOf(appId)}`);
  },
  hide(appId: string) {
    commit({ type: 'app.setHidden', appId, hidden: true }, `已隐藏 ${nameOf(appId)}，可在抽屉底部恢复`);
  },
  unhide(appId: string) {
    commit({ type: 'app.setHidden', appId, hidden: false }, `${nameOf(appId)} 已恢复显示`);
  },
  /** Reordering is not structural: no toast, matching the prototype. */
  move(appId: string, delta: number) {
    const i = cfg().pins.indexOf(appId);
    if (i < 0) return;
    dispatch({ type: 'pin.move', appId, toIndex: i + delta });
  },
  moveTo(appId: string, toIndex: number) {
    dispatch({ type: 'pin.move', appId, toIndex });
  },
  /** 收藏 / 取消收藏 the picture on screen (synced: every device shares favorites). */
  toggleFavorite(entry: WallpaperEntry) {
    const look = cfg().settings.look;
    const on = look.favorites.includes(entry.id);
    const favorites = on ? look.favorites.filter((x) => x !== entry.id) : [...look.favorites, entry.id];
    commit({ type: 'settings.patch', section: 'look', patch: { favorites } }, on ? `已取消收藏「${entry.name}」` : `已收藏「${entry.name}」`);
  },
  /** 不喜欢这张: rotation never picks it again; `next` moves on right away. */
  dislike(entry: WallpaperEntry, next: () => void) {
    const look = cfg().settings.look;
    if (look.blocked.includes(entry.id)) return next();
    if (commit({ type: 'settings.patch', section: 'look', patch: { blocked: [...look.blocked, entry.id] } }, `不再显示「${entry.name}」`)) next();
  },
  /** 锁定: stop rotating and keep this picture (with its own focal point). */
  lock(entry: WallpaperEntry) {
    const look = cfg().settings.look;
    const focal = entry.focal ?? [50, 50];
    commit({ type: 'settings.patch', section: 'look', patch: { wallpaper: entry.id, rotation: { ...look.rotation, mode: 'off' }, focal: { desktop: focal, mobile: focal } } }, `已固定「${entry.name}」为壁纸`);
  },
};
