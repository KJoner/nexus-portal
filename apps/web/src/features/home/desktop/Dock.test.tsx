import { defaultConfig, type AppEntry } from '@nexus/shared';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type PointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSync } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { Dock, DockHandle, useDockPeek } from './Dock';

const gh = defaultConfig().apps.find((a) => a.id === 'github')!;
const sites = (n: number): AppEntry[] => Array.from({ length: n }, (_, i) => ({ ...gh, id: `s${i}`, name: `站点${i}`, url: `https://s${i}.example.com` }));

/** `bare`: the extension can fold, but there is no expand button to hand the focus to. */
function Harness({ extra, mode = 'expand', bare }: { extra: AppEntry[]; mode?: 'expand' | 'double'; bare?: boolean }) {
  const [expanded, setExpanded] = useState(mode === 'double');
  const allRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <input aria-label="别处" />
      <Dock
        sites={sites(5)}
        extra={extra}
        services={[]}
        dockSize={5}
        edit={false}
        iconSize={56}
        labels
        showBadges={false}
        expanded={expanded}
        rows={1}
        showPager
        addToExtension={false}
        allRef={allRef}
        onMenu={vi.fn()}
        onOpenDrawer={vi.fn()}
        onUnpin={vi.fn()}
        onMove={vi.fn()}
        onMoveTo={vi.fn()}
      />
      {mode === 'expand' && extra.length > 0 && !bare && <DockHandle state={expanded ? 'pinned' : 'closed'} count={extra.length} onToggle={() => setExpanded((v) => !v)} />}
      {bare && (
        <button type="button" onClick={() => setExpanded((v) => !v)}>
          切换
        </button>
      )}
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetSync(new MemoryTransport());
});

describe('Dock extension (v0.2)', () => {
  it('shows no expand control when nothing is left over', () => {
    render(<Harness extra={[]} />);
    expect(screen.queryByRole('button', { name: /展开更多快捷方式/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /更多快捷方式/ })).toBeNull();
  });

  it('stays out of the DOM until first opened, then pages with buttons, dots and PageDown', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(14).slice(5)} />);
    expect(screen.queryByRole('group', { name: /更多快捷方式/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开更多快捷方式（另有 9 个）' }));
    // 56 px icons → 9 columns; 9 sites on one row fit one page.
    const ext = screen.getByRole('group', { name: '更多快捷方式' });
    expect(within(ext).getAllByRole('link')).toHaveLength(9);
    expect(within(ext).queryByRole('button', { name: '下一页' })).toBeNull();
  });

  it('turns pages: buttons, dots, PageDown, and one wheel gesture = one page', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(25).slice(5)} />);
    await user.click(screen.getByRole('button', { name: /展开更多快捷方式/ }));
    const ext = screen.getByRole('group', { name: /更多快捷方式/ });
    expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 3 页');
    await user.click(within(ext).getByRole('button', { name: '下一页' }));
    expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 2 / 3 页');
    await user.click(within(ext).getByRole('button', { name: '第 1 页' }));
    expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 3 页');
    fireEvent.keyDown(within(ext).getAllByRole('link')[0]!, { key: 'PageDown' });
    expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 2 / 3 页');
    for (let i = 0; i < 6; i++) fireEvent.wheel(ext, { deltaY: 60 });
    expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 3 / 3 页');
    expect(within(ext).getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('collapsing hides the extension from keyboard and screen readers', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(8).slice(5)} />);
    const toggle = screen.getByRole('button', { name: /展开更多快捷方式/ });
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: '收起更多快捷方式' }));
    const ext = document.querySelector('[aria-label^="更多快捷方式"]')!;
    expect(ext).toHaveAttribute('inert');
    expect(ext).toHaveStyle({ visibility: 'hidden', opacity: '0' });
    // Chrome refuses aria-hidden around the focus, and inert already covers screen readers.
    expect(ext).not.toHaveAttribute('aria-hidden');
  });

  it('opening again gives the keyboard its links back', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(8).slice(5)} />);
    const toggle = screen.getByRole('button', { name: /展开更多快捷方式/ });
    await user.click(toggle);
    await user.click(toggle);
    await user.click(toggle);
    const ext = screen.getByRole('group', { name: '更多快捷方式' });
    expect(ext).not.toHaveAttribute('inert');
    expect(ext).toHaveStyle({ visibility: 'visible', opacity: '1' });
    within(ext).getAllByRole('link')[0]!.focus();
    expect(ext).toContainElement(document.activeElement as HTMLElement);
  });

  it('folding moves the focus out first, to the button that brings the links back', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(8).slice(5)} />);
    await user.click(screen.getByRole('button', { name: /展开更多快捷方式/ }));
    const ext = screen.getByRole('group', { name: '更多快捷方式' });
    const handle = screen.getByRole('button', { name: '收起更多快捷方式' });
    within(ext).getAllByRole('link')[1]!.focus();
    let inertWhenMoved: boolean | null = null;
    handle.addEventListener('focus', () => (inertWhenMoved = ext.hasAttribute('inert')));
    fireEvent.click(handle); // like a key or a timer: nothing but the code moves the focus
    expect(handle).toHaveFocus();
    expect(inertWhenMoved).toBe(false);
    expect(ext).toHaveAttribute('inert');
  });

  it('without that button the focus goes to 全部应用', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(8).slice(5)} bare />);
    const toggle = screen.getByRole('button', { name: '切换' });
    await user.click(toggle);
    within(screen.getByRole('group', { name: '更多快捷方式' })).getAllByRole('link')[0]!.focus();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '全部应用' })).toHaveFocus();
  });

  it('a focus that is elsewhere stays where it is', async () => {
    const user = userEvent.setup();
    render(<Harness extra={sites(8).slice(5)} />);
    const toggle = screen.getByRole('button', { name: /展开更多快捷方式/ });
    await user.click(toggle);
    screen.getByRole('textbox', { name: '别处' }).focus();
    fireEvent.click(toggle);
    expect(screen.getByRole('textbox', { name: '别处' })).toHaveFocus();
  });

  it('opening and closing in quick succession always ends in step', () => {
    render(<Harness extra={sites(8).slice(5)} />);
    const toggle = screen.getByRole('button', { name: /展开更多快捷方式/ });
    for (let i = 1; i <= 7; i++) {
      fireEvent.click(toggle);
      const ext = document.querySelector('[aria-label^="更多快捷方式"]')!;
      expect(ext.hasAttribute('inert')).toBe(i % 2 === 0);
      expect(toggle).toHaveAttribute('aria-expanded', String(i % 2 === 1));
    }
  });

  it('“固定展开” has no toggle and is open from the start', () => {
    render(<Harness extra={sites(8).slice(5)} mode="double" />);
    expect(screen.queryByRole('button', { name: /展开更多快捷方式/ })).toBeNull();
    expect(screen.getByRole('group', { name: '更多快捷方式' })).toBeVisible();
  });

  it('the handle says what a click does: while peeking it keeps the extension open', () => {
    render(<DockHandle state="peek" count={3} onToggle={vi.fn()} />);
    const handle = screen.getByRole('button', { name: '固定展开更多快捷方式（另有 3 个）' });
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(handle.querySelector('.rotate-180')).toBeNull();
  });
});

describe('useDockPeek', () => {
  const mouse = { pointerType: 'mouse' } as PointerEvent;
  const touch = { pointerType: 'touch' } as PointerEvent;
  const setup = (enabled = true, hold = false) => renderHook((p) => useDockPeek(p.enabled, p.hold), { initialProps: { enabled, hold } });
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('opens after a short pause on the rows, not for a pointer passing through', () => {
    const { result } = setup();
    act(() => result.current.rows.onPointerEnter(mouse));
    wait(100);
    act(() => result.current.rows.onPointerLeave(mouse));
    wait(1000);
    expect(result.current.open).toBe(false);
    act(() => result.current.rows.onPointerEnter(mouse));
    wait(200);
    expect(result.current.open).toBe(true);
  });

  it('the button keeps it open but never opens it', () => {
    const { result } = setup();
    act(() => result.current.button.onPointerEnter(mouse));
    wait(1000);
    expect(result.current.open).toBe(false);

    act(() => result.current.rows.onPointerEnter(mouse));
    wait(200);
    act(() => result.current.rows.onPointerLeave(mouse));
    wait(100);
    act(() => result.current.button.onPointerEnter(mouse));
    wait(1000);
    expect(result.current.open).toBe(true);
    act(() => result.current.button.onPointerLeave(mouse));
    wait(1000);
    expect(result.current.open).toBe(false);
  });

  it('a menu holds it open until it closes, and touch never opens it', () => {
    const { result, rerender } = setup();
    act(() => result.current.rows.onPointerEnter(touch));
    wait(1000);
    expect(result.current.open).toBe(false);

    act(() => result.current.rows.onPointerEnter(mouse));
    wait(200);
    rerender({ enabled: true, hold: true });
    act(() => result.current.rows.onPointerLeave(mouse));
    wait(1000);
    expect(result.current.open).toBe(true);
    rerender({ enabled: true, hold: false });
    wait(1000);
    expect(result.current.open).toBe(false);
  });

  it('turning it off closes at once and cancels what was pending', () => {
    const { result, rerender } = setup();
    act(() => result.current.rows.onPointerEnter(mouse));
    rerender({ enabled: false, hold: false });
    wait(1000);
    rerender({ enabled: true, hold: false });
    expect(result.current.open).toBe(false);
  });
});
