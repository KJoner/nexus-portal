import { describe, expect, it } from 'vitest';
import { defaultConfig, newUserConfig } from './defaults';
import { groupDeleteImpact, groupPath, groupTree, GROUP_LIMITS, repairGroupTree, treeProblems, UNFILED } from './groups';
import { applyOp, applyOps, invertOp, normalizeConfig, OpError, type Op } from './ops';
import type { Category, Config } from './schema';

/**
 * UI v2 (v12.0.3 N2) 分组树 — spec 06 B06–B10, B16 (rules of the shared reducer; the server and the
 * browser's local collection run this same reducer).
 */
const base = (): Config => normalizeConfig(newUserConfig());
const run = (c: Config, ...ops: Op[]) => applyOps(c, ops);
const group = (id: string, label: string, parentId: string | null = null, index?: number): Op => ({ type: 'group.create', group: { id, label, parentId }, ...(index !== undefined ? { index } : {}) });
const kids = (c: Config, parent: string | null) => c.categories.filter((k) => k.id !== UNFILED && (k.parentId ?? null) === parent).map((k) => k.id);
const refused = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OpError);
    expect((e as Error).message).toMatch(pattern);
    return;
  }
  expect.unreachable('should have been refused');
};

describe('B06 三层分组：建、进入、移动父组', () => {
  it('creates nested groups; the tree, paths and sibling order read back the same', () => {
    const c = run(base(), group('w', '项目'), group('w-dev', '开发', 'w'), group('w-dev-fe', '前端', 'w-dev'), group('w-design', '设计', 'w', 0));
    expect(kids(c, 'w')).toEqual(['w-design', 'w-dev']);
    expect(groupPath(c.categories, 'w-dev-fe')).toEqual(['项目', '开发', '前端']);
    const tree = groupTree(c.categories);
    const w = tree.find((g) => g.id === 'w')!;
    expect(w.children.map((g) => g.id)).toEqual(['w-design', 'w-dev']);
    expect(w.children[1]!.children[0]).toMatchObject({ id: 'w-dev-fe', depth: 3, path: ['项目', '开发', '前端'] });
    expect(treeProblems(c.categories)).toEqual([]);
    // Moving a parent keeps its whole subtree and every id.
    const moved = applyOp(c, { type: 'group.move', groupId: 'w-dev', parentId: 'life', index: 0 });
    expect(kids(moved, 'life')).toEqual(['w-dev']);
    expect(groupPath(moved.categories, 'w-dev-fe')).toEqual(['生活', '开发', '前端']);
    expect(moved.categories.map((k) => k.id).sort()).toEqual(c.categories.map((k) => k.id).sort());
  });

  it('reorders siblings only among themselves; undo puts a group back where it was', () => {
    const c = run(base(), group('a', 'A'), group('b', 'B'), group('c', 'C'));
    const roots = kids(c, null);
    const moved = applyOp(c, { type: 'group.move', groupId: 'c', parentId: null, index: 0 });
    expect(kids(moved, null)).toEqual(['c', ...roots.filter((x) => x !== 'c')]);
    const back = applyOps(moved, invertOp(c, { type: 'group.move', groupId: 'c', parentId: null, index: 0 }));
    expect(kids(back, null)).toEqual(roots);
  });
});

describe('B07 树的非法关系由共享规则拒绝', () => {
  const tree = () => run(base(), group('p', '父'), group('q', '子', 'p'), group('r', '孙', 'q'));
  it('refuses itself, a descendant, a missing parent and 未分组 as the parent', () => {
    refused(() => applyOp(tree(), { type: 'group.move', groupId: 'p', parentId: 'p' }), /自己/);
    refused(() => applyOp(tree(), { type: 'group.move', groupId: 'p', parentId: 'r' }), /自己或它的子分组/);
    refused(() => applyOp(tree(), { type: 'group.move', groupId: 'q', parentId: 'ghost' }), /不存在/);
    refused(() => applyOp(tree(), group('x', '新', 'ghost')), /不存在/);
    refused(() => applyOp(tree(), group('x', '新', UNFILED)), /视图不能有子分组/);
    refused(() => applyOp(tree(), { type: 'group.move', groupId: UNFILED, parentId: 'p' }), /不能移动/);
  });

  it('refuses a parent that belongs to another account (its id is simply not in this tree)', () => {
    const other = run(base(), group('theirs', '别人的分组'));
    expect(other.categories.some((k) => k.id === 'theirs')).toBe(true);
    refused(() => applyOp(base(), group('mine', '我的', 'theirs')), /不存在/);
  });

  it(`refuses depth over ${GROUP_LIMITS.depth}, also when a deep subtree moves under a deep group`, () => {
    let c = base();
    let parent: string | null = null;
    for (let d = 1; d <= GROUP_LIMITS.depth; d++) {
      c = applyOp(c, group(`d${d}`, `层${d}`, parent));
      parent = `d${d}`;
    }
    refused(() => applyOp(c, group('d9', '层9', 'd8')), /最多 8 层/);
    c = run(c, group('s1', '树1'), group('s2', '树2', 's1'));
    refused(() => applyOp(c, { type: 'group.move', groupId: 's1', parentId: 'd7' }), /最多 8 层/);
    expect(applyOp(c, { type: 'group.move', groupId: 's2', parentId: 'd7' }).categories.find((k) => k.id === 's2')!.parentId).toBe('d7');
  });

  it(`refuses more than ${GROUP_LIMITS.total} groups`, () => {
    let c = base();
    for (let i = c.categories.length; i < GROUP_LIMITS.total; i++) c = applyOp(c, group(`g${i}`, `组${i}`));
    expect(c.categories).toHaveLength(GROUP_LIMITS.total);
    try {
      applyOp(c, group('one-more', '再一个'));
      expect.unreachable();
    } catch (e) {
      expect((e as OpError).code).toBe('quota_exceeded');
    }
  });

  it('reserved ids (views, 未分组, 我的服务) cannot be taken by a new group', () => {
    for (const id of ['none', 'all', 'pinned', 'services', 'trash', 'hosted']) refused(() => applyOp(base(), group(id, '保留')), /已存在/);
  });
});

describe('B08 同名叶子：不同父节点下合法，同一层不重名', () => {
  it('工作/资料 and 生活/资料 are two groups; a second 资料 (any case / spaces) under one parent is refused', () => {
    const c = run(base(), group('wd', '资料', 'work'), group('ld', '资料', 'life'));
    expect(groupPath(c.categories, 'wd')).toEqual(['工作', '资料']);
    expect(groupPath(c.categories, 'ld')).toEqual(['生活', '资料']);
    refused(() => applyOp(c, group('wd2', ' 资料 ', 'work')), /已经有「资料」/);
    const latin = run(base(), group('n1', 'Notes', 'work'));
    refused(() => applyOp(latin, group('n2', 'notes', 'work')), /已经有/);
    refused(() => applyOp(c, { type: 'group.rename', groupId: 'ld', label: '资料' }) && applyOp(c, { type: 'group.move', groupId: 'ld', parentId: 'work' }), /已经有「资料」/);
  });
});

describe('B09 删除分组：保留内容，先给出影响', () => {
  it('subgroups move up into its place (renamed when the name is taken), favorites go to the parent; nothing is deleted', () => {
    let c = run(base(), group('proj', '项目', 'work'), group('docs', '资料', 'proj'), group('wdocs', '资料', 'work'), group('misc', '杂项', 'proj'));
    const gh = { ...defaultConfig().apps.find((a) => a.id === 'github')!, categoryId: 'proj' };
    c = applyOp(c, { type: 'app.upsert', app: gh });
    const impact = groupDeleteImpact(c.categories, [{ folderId: 'proj' }, { folderId: 'docs' }, { folderId: 'docs', deletedAt: 1 }], 'proj')!;
    expect(impact).toMatchObject({ groupId: 'proj', path: ['工作', '项目'], descendantGroups: 2, directItems: 1, totalItems: 2, moveTo: { id: 'work', label: '工作' } });
    expect(impact.childGroups.map((g) => g.id)).toEqual(['docs', 'misc']);
    expect(impact.renamed).toEqual([{ id: 'docs', from: '资料', to: '资料 2' }]);
    const after = applyOp(c, { type: 'group.delete', groupId: 'proj' });
    expect(after.categories.some((k) => k.id === 'proj')).toBe(false);
    expect(kids(after, 'work')).toEqual(['docs', 'misc', 'wdocs']);
    expect(after.categories.find((k) => k.id === 'docs')!.label).toBe('资料 2');
    expect(after.apps.find((a) => a.id === 'github')!.categoryId).toBe('work');
    // A root group's favorites go to 未分组.
    const root = applyOp(run(base(), group('solo', '独立')), { type: 'app.upsert', app: { ...gh, id: 'gh2', categoryId: 'solo' } });
    expect(applyOp(root, { type: 'group.delete', groupId: 'solo' }).apps.find((a) => a.id === 'gh2')!.categoryId).toBe(UNFILED);
    refused(() => applyOp(base(), { type: 'group.delete', groupId: UNFILED }), /不能删除/);
  });
});

describe('B16 旧客户端：整表替换不会压平分组树', () => {
  // What an older client sends: its own view of the list, without parentId (its schema strips it).
  const flat = (c: Config) => c.categories.map(({ parentId: _p, ...k }) => k as Category);

  it('a rename by an old client keeps every parent', () => {
    const c = run(base(), group('proj', '项目', 'work'), group('fe', '前端', 'proj'));
    const sent = flat(c).map((k) => (k.id === 'fe' ? { ...k, label: '前端开发' } : k));
    const after = applyOp(c, { type: 'categories.replace', categories: sent });
    expect(groupPath(after.categories, 'fe')).toEqual(['工作', '项目', '前端开发']);
    expect(treeProblems(after.categories)).toEqual([]);
  });

  it('an old client deleting a parent: its children hang from the nearest surviving ancestor, its apps follow', () => {
    let c = run(base(), group('proj', '项目', 'work'), group('fe', '前端', 'proj'));
    c = applyOp(c, { type: 'app.upsert', app: { ...defaultConfig().apps.find((a) => a.id === 'github')!, categoryId: 'proj' } });
    const after = applyOp(c, { type: 'categories.replace', categories: flat(c).filter((k) => k.id !== 'proj') });
    expect(after.categories.find((k) => k.id === 'fe')!.parentId).toBe('work');
    expect(after.apps.find((a) => a.id === 'github')!.categoryId).toBe('work');
  });

  it('我的服务, which an older client puts back, is not recreated once deleted; 未分组 cannot be dropped', () => {
    const migrated = normalizeConfig({ ...defaultConfig(), categories: defaultConfig().categories.map((k) => (k.id === 'hosted' ? { ...k, locked: false } : k)) });
    const services = migrated.apps.filter((a) => a.categoryId === 'hosted').map((a) => a.id);
    const deleted = applyOp(migrated, { type: 'group.delete', groupId: 'hosted' });
    expect(deleted.categories.some((k) => k.id === 'hosted')).toBe(false);
    expect(services.every((id) => deleted.apps.find((a) => a.id === id)!.categoryId === UNFILED)).toBe(true);
    const oldClient = [{ id: 'hosted', label: '我的服务', locked: true }, ...flat(deleted)];
    expect(applyOp(deleted, { type: 'categories.replace', categories: oldClient }).categories.some((k) => k.id === 'hosted')).toBe(false);
    refused(() => applyOp(deleted, { type: 'categories.replace', categories: flat(deleted).filter((k) => k.id !== UNFILED) }), /不能删除/);
  });
});

describe('repairGroupTree: any stored document reads as a valid tree', () => {
  it('cuts cycles, roots missing parents, lifts what is too deep, keeps 未分组 a root', () => {
    const cats: Category[] = [
      { id: 'a', label: 'A', locked: false, parentId: 'b' },
      { id: 'b', label: 'B', locked: false, parentId: 'a' },
      { id: 'c', label: 'C', locked: false, parentId: 'gone' },
      { id: 'none', label: '未分组', locked: true, parentId: 'c' },
      ...Array.from({ length: 10 }, (_, i): Category => ({ id: `z${i}`, label: `Z${i}`, locked: false, parentId: i ? `z${i - 1}` : null })),
    ];
    const fixed = repairGroupTree(cats);
    expect(treeProblems(fixed)).toEqual([]);
    expect(fixed.find((k) => k.id === 'c')!.parentId).toBe(null);
    expect(fixed.find((k) => k.id === 'none')!.parentId).toBe(null);
    expect(fixed.map((k) => k.id)).toEqual(cats.map((k) => k.id));
  });

  it('normalizeConfig keeps 未分组, no longer adds 我的服务', () => {
    const c = normalizeConfig({ ...newUserConfig(), categories: [{ id: 'x', label: 'X', locked: false }] });
    expect(c.categories.map((k) => k.id)).toEqual(['x', 'none']);
  });
});
