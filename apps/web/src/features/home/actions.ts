import { homeCapacity, MAX_PINS, type Op } from '@nexus/shared';
import { toast } from '../../components/toast-store';
import { dispatch, useConfigStore } from '../../data/config-store';
import { wallpaperList } from './Wallpaper';

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
    const extra = position > desktop ? `；桌面 Dock 只显示前 ${desktop} 个` : '';
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
  nextWallpaper() {
    const look = cfg().settings.look;
    const list = wallpaperList(useConfigStore.getState().wallpapers);
    const i = list.findIndex((w) => w.id === look.wallpaper);
    const next = list[(i + 1) % list.length]!;
    commit({ type: 'settings.patch', section: 'look', patch: { wallpaper: next.id } }, `已换成「${next.name}」`);
  },
};
