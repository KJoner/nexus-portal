import { applyOp, defaultConfig, OpError, type Category, type Config } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { dropAnchor, treeDropMove, treeDropProblem, treeZone } from './model';

/**
 * Dragging in 我的收藏 (spec 02 N2/N4, 06 B06/B10): what a drop means is decided by these pure
 * functions, and then sent as the same operations as the menus — moveItems with an anchor for
 * favorites, group.move for groups (whose rules, not the drag, decide what is allowed).
 */
const tree: Category[] = [
  { id: 'work', label: '工作', locked: false, parentId: null },
  { id: 'proj', label: '项目', locked: false, parentId: 'work' },
  { id: 'docs', label: '资料', locked: false, parentId: 'proj' },
  { id: 'life', label: '生活', locked: false, parentId: null },
  { id: 'docs2', label: '资料', locked: false, parentId: 'life' },
  { id: 'media', label: '影音', locked: false, parentId: null },
  { id: 'none', label: '未分组', locked: true, parentId: null },
];
const config = (): Config => ({ ...defaultConfig(), categories: tree, apps: [], pins: [] });
const moved = (groupId: string, m: { parentId: string | null; index?: number }) => applyOp(config(), { type: 'group.move', groupId, ...m }).categories;
const order = (cats: Category[], parentId: string | null) => cats.filter((c) => c.id !== 'none' && (c.parentId ?? null) === parentId).map((c) => c.id);

describe('favorites: the drop anchor is the one 上移 / 下移 use', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  it('one row: after the row dropped on when going down, before it when going up', () => {
    expect(dropAnchor(ids, new Set(['b']), 1, 3)).toBe('d');
    expect(dropAnchor(ids, new Set(['d']), 3, 1)).toBe('a');
    expect(dropAnchor(ids, new Set(['d']), 3, 0)).toBeNull();
    expect(dropAnchor(ids, new Set(['a']), 0, 4)).toBe('e');
  });
  it('the selected rows go together, in their order; none of them is its own anchor', () => {
    expect(dropAnchor(ids, new Set(['b', 'd']), 1, 4)).toBe('e');
    expect(dropAnchor(ids, new Set(['b', 'd']), 3, 2)).toBe('a');
    expect(dropAnchor(ids, new Set(['b', 'd']), 1, 3)).toBe('c');
    expect(dropAnchor(ids, new Set(['a', 'b']), 1, 0)).toBeNull();
  });
});

describe('groups: where on a row decides before / inside / after', () => {
  it('top and bottom quarters place beside it; the middle makes it a subgroup; a locked row only beside', () => {
    expect(treeZone(101, 100, 40)).toBe('before');
    expect(treeZone(120, 100, 40)).toBe('inside');
    expect(treeZone(138, 100, 40)).toBe('after');
    expect(treeZone(118, 100, 40, false)).toBe('before');
    expect(treeZone(122, 100, 40, false)).toBe('after');
  });

  it('same level: before / after a sibling is that index among the others (同层重排)', () => {
    const m = treeDropMove(tree, 'media', 'work', 'before', true)!;
    expect(m).toEqual({ parentId: null, index: 0 });
    expect(order(moved('media', m), null)).toEqual(['media', 'work', 'life']);
    const after = treeDropMove(tree, 'work', 'life', 'after', false)!;
    expect(order(moved('work', after), null)).toEqual(['life', 'work', 'media']);
  });

  it('inside a row: its last subgroup; below an open row with subgroups: its first', () => {
    const into = treeDropMove(tree, 'media', 'work', 'inside', true)!;
    expect(into).toEqual({ parentId: 'work' });
    expect(order(moved('media', into), 'work')).toEqual(['proj', 'media']);
    const first = treeDropMove(tree, 'media', 'work', 'after', true)!;
    expect(order(moved('media', first), 'work')).toEqual(['media', 'proj']);
    // Collapsed: below it is simply after it.
    expect(treeDropMove(tree, 'media', 'work', 'after', false)).toEqual({ parentId: null, index: 1 });
    expect(treeDropMove(tree, 'media', 'media', 'inside', true)).toBeNull();
  });

  it('a drop the rules refuse is named in group.move’s own words — and group.move refuses it too', () => {
    const cases: [string, string, 'inside' | 'before'][] = [
      ['work', 'docs', 'inside'], // into its own descendant
      ['work', 'proj', 'before'], // beside its own descendant
      ['docs', 'life', 'inside'], // 生活 already has a 资料
    ];
    for (const [g, target, zone] of cases) {
      const m = treeDropMove(tree, g, target, zone, true)!;
      const problem = treeDropProblem(tree, g, m.parentId);
      expect(problem, `${g} → ${target}`).toBeTruthy();
      let refused: unknown = null;
      try {
        applyOp(config(), { type: 'group.move', groupId: g, ...m });
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(OpError);
      expect((refused as OpError).message).toBe(problem);
    }
    expect(treeDropProblem(tree, 'media', 'work')).toBeNull();
  });

  it('a tree deeper than 8 levels is refused before and by the rules', () => {
    const deep: Category[] = Array.from({ length: 8 }, (_, k) => ({ id: `l${k}`, label: `层${k}`, locked: false, parentId: k ? `l${k - 1}` : null }));
    const cats = [...deep, { id: 'x', label: '新', locked: false, parentId: null }, { id: 'none', label: '未分组', locked: true, parentId: null }];
    expect(treeDropProblem(cats, 'x', 'l7')).toBe('分组最多 8 层');
  });
});
