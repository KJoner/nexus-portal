import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSync } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { SearchSlab } from './SearchSlab';

function setup() {
  const onAction = vi.fn();
  render(
    <>
      <SearchSlab dock={<a href="https://github.com">GitHub</a>} dockHeight={120} edit={false} maxPanel={500} onFocusSearch={() => {}} onAction={onAction} />
      <button type="button">outside</button>
    </>,
  );
  return { input: screen.getByRole('combobox', { name: '搜索' }), onAction, user: userEvent.setup() };
}

const engineButton = () => screen.getByRole('button', { name: /搜索引擎：/ });

beforeEach(() => {
  localStorage.clear();
  resetSync(new MemoryTransport());
});

describe('SearchSlab keyboard model (R1.5 · 01)', () => {
  it('opens as a combobox and selects results with ↑↓', async () => {
    const { input, user } = setup();
    await user.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.type(input, 'lin');
    const options = within(screen.getByRole('listbox', { name: '搜索结果' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Linkwarden'), expect.stringContaining('在 Google 中搜索「lin」')]);
    expect(input).toHaveAttribute('aria-activedescendant', 'nx-opt-0');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'nx-opt-1');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'nx-opt-0');
  });

  it('Alt+↑↓ cycles engines without moving focus', async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(engineButton()).toHaveAccessibleName('搜索引擎：Bing，按 Enter 更换');
    expect(input).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowUp}{ArrowUp}{/Alt}');
    expect(engineButton()).toHaveAccessibleName('搜索引擎：DuckDuckGo，按 Enter 更换');
  });

  it('Esc clears first, then closes', async () => {
    const { input, user } = setup();
    await user.type(input, 'abc');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveFocus();
  });

  it('Tab is not intercepted: focus leaves to the Dock and the panel closes', async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.tab();
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('engine button opens the listbox with Enter and returns focus on Esc', async () => {
    const { user } = setup();
    engineButton().focus();
    await user.keyboard('{Enter}');
    expect(engineButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Google/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Escape}');
    expect(engineButton()).toHaveFocus();
    expect(engineButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a prefix switches the engine for this query only', async () => {
    const { input, user } = setup();
    await user.type(input, 'b rust');
    expect(screen.getByText('在 Bing 中搜索「rust」')).toBeInTheDocument();
    expect(screen.getByText('临时使用 Bing')).toBeInTheDocument();
  });

  it('idle quick actions are handed to the page', async () => {
    const { input, onAction, user } = setup();
    await user.click(input);
    await user.click(screen.getByRole('option', { name: /更换壁纸/ }));
    expect(onAction).toHaveBeenCalledWith('wallpaper');
  });
});
