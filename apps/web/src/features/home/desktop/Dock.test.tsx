import { defaultConfig, type AppEntry } from '@nexus/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSync } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { Dock } from './Dock';

const gh = defaultConfig().apps.find((a) => a.id === 'github')!;
const sites = (n: number): AppEntry[] => Array.from({ length: n }, (_, i) => ({ ...gh, id: `s${i}`, name: `站点${i}`, url: `https://s${i}.example.com` }));

function Harness({ extra, mode = 'expand' }: { extra: AppEntry[]; mode?: 'expand' | 'double' }) {
  const [expanded, setExpanded] = useState(mode === 'double');
  return (
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
      onToggleExpanded={mode === 'expand' && extra.length ? () => setExpanded((v) => !v) : undefined}
      rows={1}
      showPager
      addToExtension={false}
      allRef={createRef()}
      onMenu={vi.fn()}
      onOpenDrawer={vi.fn()}
      onUnpin={vi.fn()}
      onMove={vi.fn()}
      onMoveTo={vi.fn()}
    />
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
    expect(ext).toHaveAttribute('aria-hidden', 'true');
    expect(ext).toHaveAttribute('inert');
  });

  it('“固定展开” has no toggle and is open from the start', () => {
    render(<Harness extra={sites(8).slice(5)} mode="double" />);
    expect(screen.queryByRole('button', { name: /展开更多快捷方式/ })).toBeNull();
    expect(screen.getByRole('group', { name: '更多快捷方式' })).toBeVisible();
  });
});
