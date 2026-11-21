import { MAX_PINS, type Config, type Item, type ItemWriteResult, type SnapshotResponse } from '@nexus/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALECTS, lockStep, PG_TARGET } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * NEX-07 回归：固定到首页只有一条规则（上限 36、只能固定在世的可显示站点），所有入口在账号事务里
 * 复用它——创建时固定、更新重复项时固定、独立固定 / 移动、首页 ops。
 *
 * 审查反例（v0.4 @ 498a037）：新账号连续创建 37 个 pinToHome=true 的收藏，第 37 个仍 201，
 * 数据库 37 个固定、首页 36 个。这里断言：返回值、数据库、收藏库 pinned 标记与首页显示完全一致。
 */
vi.setConfig({ testTimeout: 60_000 });
let n = 0;
const op = (p = 'op') => `${p}-${Date.now().toString(36)}-${++n}`;
type Json = Record<string, unknown> & { code?: string; details?: Record<string, unknown> };

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(dialect: 'sqlite' | 'pg', sub: string) {
  t = await buildTestApp({ dialect, idp: await fakeIdp(), quotas: { items: 1000, wallpapers: 50, icons: 200, storageBytes: 1 << 30 } });
  const app = t;
  const cookie = (await app.loginOidc({ sub, email: `${sub}@example.org` })).cookie;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.app.request(path, { method, headers: { ...write, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const create = (i: number | string, extra: Record<string, unknown> = {}) => req('POST', '/api/v2/items', { opId: op('c'), item: { title: `固定 ${i}`, url: `https://pin.example.org/${i}` }, pinToHome: true, ...extra });
  const me = (await req('GET', '/api/v2/me')).body as { account: { id: string } };
  /** Everything that shows pins, read separately: they must agree. */
  const state = async () => {
    const stored = Number((await app.db.get<{ n: number }>('select count(*) as n from pins where owner_id = ?', [me.account.id]))!.n);
    const home = ((await req('GET', '/api/config')).body as unknown as { config: Config }).config.pins;
    const snap = (await req('GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    const flagged = snap.items.filter((i) => i.pinned).map((i) => i.id);
    return { stored, home, snapshot: snap.pins, flagged };
  };
  const agree = async (count: number) => {
    const s = await state();
    expect(s.stored).toBe(count);
    expect(s.home).toHaveLength(count);
    expect(s.snapshot).toEqual(s.home);
    expect([...s.flagged].sort()).toEqual([...s.home].sort());
    return s;
  };
  return { req, create, state, agree, owner: me.account.id };
}

describe.each(DIALECTS)('NEX-07 固定上限 (%s)', (dialect) => {
  it('审查反例：第 37 个 pinToHome 仍保存但不固定，并如实说明；数据库、首页、收藏库都是 36', async () => {
    const s = await setup(dialect, `pins-a-${dialect}`);
    const answers: ItemWriteResult[] = [];
    for (let i = 0; i < MAX_PINS + 1; i++) {
      const r = await s.create(i);
      expect(r.status).toBe(201);
      answers.push(r.body as unknown as ItemWriteResult);
    }
    expect(answers.slice(0, MAX_PINS).every((a) => a.item.pinned && a.pin?.pinned)).toBe(true);
    expect(answers.at(-1)).toMatchObject({ result: 'created', item: { pinned: false }, pin: { pinned: false, code: 'PINS_FULL', limit: MAX_PINS, used: MAX_PINS } });
    await s.agree(MAX_PINS);
  });

  it('独立固定与移动在满额时返回 QUOTA_EXCEEDED；取消一个释放容量后重试成功', async () => {
    const s = await setup(dialect, `pins-b-${dialect}`);
    for (let i = 0; i < MAX_PINS; i++) expect((await s.create(i)).status).toBe(201);
    const extra = ((await s.req('POST', '/api/v2/items', { opId: op('c'), item: { title: '没固定', url: 'https://pin.example.org/extra' } })).body as unknown as ItemWriteResult).item;
    const refused = await s.req('POST', `/api/v2/pins/${extra.id}`, { opId: op('pin') });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, details: { kind: 'pins', limit: MAX_PINS, used: MAX_PINS } });
    // Moving something that is not pinned yet is pinning it: the same rule.
    expect((await s.req('PATCH', `/api/v2/pins/${extra.id}`, { opId: op('mv'), position: 0 })).body.code).toBe('QUOTA_EXCEEDED');
    await s.agree(MAX_PINS);
    const first = (await s.state()).home[0]!;
    expect((await s.req('DELETE', `/api/v2/pins/${first}?opId=${op('unpin')}`)).status).toBe(200);
    expect((await s.req('POST', `/api/v2/pins/${extra.id}`, { opId: op('pin2') })).status).toBe(200);
    const after = await s.agree(MAX_PINS);
    expect(after.home.at(-1)).toBe(extra.id);
  });

  it('更新重复项时固定、首页 ops 固定，满额时同样不超出', async () => {
    const s = await setup(dialect, `pins-c-${dialect}`);
    for (let i = 0; i < MAX_PINS; i++) await s.create(i);
    const dup = await s.req('POST', '/api/v2/items', { opId: op('dup'), item: { title: '没固定的那条', url: 'https://pin.example.org/dup' } });
    const updated = await s.req('POST', '/api/v2/items', { opId: op('dup2'), item: { title: '更新它', url: 'https://pin.example.org/dup' }, pinToHome: true, duplicatePolicy: 'update' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ result: 'updated', item: { pinned: false }, pin: { pinned: false, code: 'PINS_FULL' } });
    expect(dup.status).toBe(201);
    // The home page's own op on an app it shows: refused before anything changes (409, kind pins).
    const shown = ((await s.req('POST', '/api/v2/items', { opId: op('app'), item: { kind: 'app', title: '首页上的应用', url: 'https://pin.example.org/app' } })).body as unknown as ItemWriteResult).item;
    const v1 = await s.req('POST', '/api/config/ops', { clientId: 'home', batchId: op('b'), ops: [{ type: 'pin.add', appId: shown.id }] });
    expect(v1.status).toBe(409);
    expect(v1.body).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'pins', limit: MAX_PINS } });
    await s.agree(MAX_PINS);
  });

  it('自托管服务与隐藏的应用不能固定（任何入口），首页与收藏库不会显示不一致的固定', async () => {
    const s = await setup(dialect, `pins-d-${dialect}`);
    const created = ((await s.req('POST', '/api/v2/items', { opId: op('svc'), item: { kind: 'app', title: '我的服务', url: 'https://svc.example.org/' } })).body as unknown as ItemWriteResult).item;
    const view = ((await s.req('GET', '/api/config')).body as unknown as { config: Config }).config;
    const svc = view.apps.find((a) => a.id === created.id)!;
    expect((await s.req('POST', '/api/config/ops', { clientId: 'home', batchId: op('k'), ops: [{ type: 'app.upsert', app: { ...svc, kind: 'service', categoryId: 'hosted' }, base: svc }] })).status).toBe(200);
    const pinned = await s.req('POST', `/api/v2/pins/${created.id}`, { opId: op('p') });
    expect(pinned.status).toBe(409);
    expect(pinned.body.code).toBe('NOT_PINNABLE');
    expect((await s.req('POST', '/api/v2/items', { opId: op('dupsvc'), item: { title: '再存一次', url: 'https://svc.example.org/' }, pinToHome: true, duplicatePolicy: 'update' })).body).toMatchObject({ pin: { pinned: false, code: 'NOT_PINNABLE' } });
    await s.agree(0);
  });

  it('旧版本留下的超额固定：所有读取一律按前 36 个；下一次固定写入时落库修正', async () => {
    const s = await setup(dialect, `pins-e-${dialect}`);
    for (let i = 0; i < MAX_PINS; i++) await s.create(i);
    const extra = ((await s.req('POST', '/api/v2/items', { opId: op('x'), item: { title: '超额的', url: 'https://pin.example.org/over' } })).body as unknown as ItemWriteResult).item;
    // What 0.4.0 could leave behind: a 37th row.
    await t!.db.run('insert into pins (owner_id, item_id, layout, position) values (?, ?, ?, ?)', [s.owner, extra.id, 'shared', MAX_PINS]);
    const read = await s.state();
    expect(read.stored).toBe(MAX_PINS + 1);
    expect(read.home).toHaveLength(MAX_PINS);
    expect(read.snapshot).toEqual(read.home);
    expect(read.flagged).not.toContain(extra.id);
    expect(((await s.req('GET', `/api/v2/items?url=${encodeURIComponent(extra.url)}`)).body.items as Item[])[0]!.pinned).toBe(false);
    // Any pin write stores what everyone already saw.
    expect((await s.req('PATCH', `/api/v2/pins/${read.home[0]}`, { opId: op('mv'), position: 3 })).status).toBe(200);
    await s.agree(MAX_PINS);
  });

  it('并发固定（同时 4 个入口抢最后 1 个位置）：恰好一个成功，其余如实拒绝，三处一致', async () => {
    const s = await setup(dialect, `pins-f-${dialect}`);
    for (let i = 0; i < MAX_PINS - 1; i++) await s.create(i);
    const mk = async (k: string) => ((await s.req('POST', '/api/v2/items', { opId: op(k), item: { title: k, url: `https://race.example.org/${k}` } })).body as unknown as ItemWriteResult).item;
    const [x, y, w] = [await mk('x'), await mk('y'), await mk('w')];
    const outcomes = await Promise.all([
      s.req('POST', `/api/v2/pins/${x.id}`, { opId: op('px') }),
      s.req('POST', `/api/v2/pins/${y.id}`, { opId: op('py') }),
      s.create('z'),
      s.req('POST', '/api/config/ops', { clientId: 'home', batchId: op('pw'), ops: [{ type: 'pin.add', appId: w.id }] }),
    ]);
    const won = [outcomes[0]!.status === 200, outcomes[1]!.status === 200, outcomes[2]!.status === 201 && (outcomes[2]!.body as unknown as ItemWriteResult).pin?.pinned === true, outcomes[3]!.status === 200];
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(outcomes[2]!.status).toBe(201); // the item is saved either way
    await s.agree(MAX_PINS);
  });
});

describe.runIf(PG_TARGET === 'postgresql')('NEX-07 forced interleaving (real PostgreSQL)', () => {
  it('两个固定请求都读到 35 个：账号锁让它们排队，只有一个写成第 36 个', async () => {
    const s = await setup('pg', 'pins-pg');
    for (let i = 0; i < MAX_PINS - 1; i++) await s.create(i);
    const mk = async (k: string) => ((await s.req('POST', '/api/v2/items', { opId: op(k), item: { title: k, url: `https://lock.example.org/${k}` } })).body as unknown as ItemWriteResult).item;
    const [a, b] = [await mk('a'), await mk('b')];
    const r = await lockStep(t!.db, 'select 1 from user_config where owner_id = $1 for update', [s.owner], [() => s.req('POST', `/api/v2/pins/${a.id}`, { opId: op('pa') }), () => s.req('POST', `/api/v2/pins/${b.id}`, { opId: op('pb') }), () => s.create('c')]);
    const done = r.map((x) => (x.status === 'fulfilled' ? x.value : null));
    const won = [done[0]?.status === 200, done[1]?.status === 200, (done[2]?.body as unknown as ItemWriteResult | undefined)?.pin?.pinned === true];
    expect(won.filter(Boolean)).toHaveLength(1);
    await s.agree(MAX_PINS);
  });
});
