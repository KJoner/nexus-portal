import { defaultConfig } from '@nexus/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { runUndo, useToastStore } from '../components/toast-store';
import { homeActions } from '../features/home/actions';
import { localAdapter } from './adapter';
import { setConfigAdapter, useConfigStore } from './config-store';

const KEY = 'nexus.config.v1';
const pins = () => useConfigStore.getState().snapshot.config.pins;

beforeEach(() => {
  localStorage.clear();
  setConfigAdapter(localAdapter);
  useToastStore.setState({ current: null });
});

describe('local adapter', () => {
  it('boots from defaults and persists every change', async () => {
    expect(pins()).toEqual(defaultConfig().pins);
    homeActions.unpin('youtube');
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(KEY)!).config.pins).not.toContain('youtube');
    expect(useConfigStore.getState().snapshot.revision).toBe(1);
  });

  it('falls back to defaults when stored data is corrupt instead of crashing', () => {
    localStorage.setItem(KEY, '{"revision":3,"config":{"apps":"nope"}}');
    setConfigAdapter(localAdapter);
    expect(pins()).toEqual(defaultConfig().pins);
    localStorage.setItem(KEY, 'not json');
    setConfigAdapter(localAdapter);
    expect(pins()).toEqual(defaultConfig().pins);
  });

  it('restores the stored snapshot on reload', () => {
    homeActions.pin('vercel');
    setConfigAdapter(localAdapter);
    expect(pins()).toContain('vercel');
  });
});

describe('structural changes are undoable', () => {
  it('hide → toast → undo restores visibility and position', () => {
    homeActions.hide('gmail');
    const t = useToastStore.getState().current!;
    expect(t.msg).toContain('已隐藏 Gmail');
    expect(pins()).not.toContain('gmail');
    runUndo(t);
    expect(pins()[1]).toBe('gmail');
    expect(useConfigStore.getState().snapshot.config.apps.find((a) => a.id === 'gmail')!.hidden).toBe(false);
    expect(useToastStore.getState().current!.msg).toBe('已撤销');
  });

  it('pinning beyond the Dock capacity explains where it appears', () => {
    homeActions.pin('figma');
    expect(useToastStore.getState().current!.msg).toBe('已固定 Figma 到首页；桌面 Dock 只显示前 5 个');
  });

  it('reordering does not raise a toast', () => {
    homeActions.move('github', 1);
    expect(pins().slice(0, 2)).toEqual(['gmail', 'github']);
    expect(useToastStore.getState().current).toBeNull();
  });
});
