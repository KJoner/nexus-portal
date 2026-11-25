import type { Settings } from '@nexus/shared';

/** The desktop home needs this much; a narrower or shorter window gets the phone's. */
export const DESKTOP_MIN = { w: 900, h: 560 } as const;

/** 设置 · 图标大小. */
export const ICON = { s: 48, m: 56, l: 64 } as const;
/** Space between two shortcut columns — the first row and the extension share one grid. */
export const COL_GAP = 12;
/** The slab's padding left and right of the shortcuts (px-6). */
const SIDE = 24;

/** 搜索面板宽度, kept inside the window. */
export function slabWidthFor(searchWidth: number, viewportWidth: number): number {
  return Math.min(searchWidth, viewportWidth - 120);
}

/** Shortcut columns: the natural Dock cell with a little more air, as many as fit the slab. */
export function extensionCols(iconSize: number, slabWidth = 760): number {
  return Math.max(5, Math.min(12, Math.floor((slabWidth - 2 * SIDE + COL_GAP) / (iconSize + 12 + COL_GAP))));
}

/**
 * The desktop first row fills the whole row: every column but the last (快速打开) holds a pinned
 * favorite, so the first row is never emptier than the rows under it. UI v2 has no services strip
 * on the home page, which is what used to take the rest of the row; 首排网站数量 (`dockSize`) is
 * only read by older clients now.
 */
export function firstRowCapacity(iconSize: number, slabWidth: number): number {
  return extensionCols(iconSize, slabWidth) - 1;
}

/**
 * The same, for places other than the home page (a toast, 设置): this window's first row. A window
 * too narrow for the desktop home (a phone) gets the narrowest desktop's.
 */
export function desktopFirstRow(settings: Pick<Settings, 'look' | 'ui'>, viewportWidth: number): number {
  return firstRowCapacity(ICON[settings.look.iconSize], slabWidthFor(settings.ui.desktop.searchWidth, Math.max(viewportWidth, DESKTOP_MIN.w)));
}
