import { defaultConfig } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { desktopFirstRow, extensionCols, firstRowCapacity, slabWidthFor } from './geometry';

describe('the desktop first row fills the row', () => {
  it('holds every column but 快速打开: more with a wider panel or smaller icons', () => {
    // 760 px panel (the default): 9 columns of 56 px icons → 8 pins, then 快速打开.
    expect(extensionCols(56, 760)).toBe(9);
    expect(firstRowCapacity(56, 760)).toBe(8);
    expect(firstRowCapacity(48, 760)).toBe(9);
    expect(firstRowCapacity(64, 760)).toBe(7);
    expect(firstRowCapacity(48, 960)).toBe(11);
    // Never fewer than four pins, never more than eleven.
    expect(firstRowCapacity(64, 400)).toBe(4);
    expect(firstRowCapacity(48, 2000)).toBe(11);
  });

  it('follows the window: the panel never comes closer than 60 px to either edge', () => {
    expect(slabWidthFor(760, 1440)).toBe(760);
    expect(slabWidthFor(760, 800)).toBe(680);
    const s = defaultConfig().settings;
    expect(desktopFirstRow(s, 1440)).toBe(8);
    // The desktop home starts at 900 px, where a 760 px panel still fits; a phone gets that too.
    expect(desktopFirstRow(s, 900)).toBe(8);
    expect(desktopFirstRow(s, 390)).toBe(8);
    expect(desktopFirstRow({ ...s, ui: { ...s.ui, desktop: { ...s.ui.desktop, searchWidth: 640 } } }, 1440)).toBe(6);
    expect(desktopFirstRow({ ...s, look: { ...s.look, iconSize: 'l' } }, 1440)).toBe(7);
    expect(desktopFirstRow({ ...s, look: { ...s.look, iconSize: 's' }, ui: { ...s.ui, desktop: { ...s.ui.desktop, searchWidth: 960 } } }, 1920)).toBe(11);
  });
});
