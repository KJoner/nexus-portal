import { defaultConfig, type ChangesResponse, type Item, type ItemWriteResult, type SnapshotResponse } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID } from '../db';
import { DIALECTS } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * 我的收藏 v2 (需求 §8.3–8.4, 契约 §6; NP-03/04, EX-02/04, TN-02/03/05).
 * Items are the source of truth; the home page's config.apps/pins are a view over them.
 */
let n = 0;
const op = (p = 'op') => `${p}-${Date.now().toString(36)}-${++n}`;
type Json = Record<string, unknown> & { code?: string; details?: Record<string, unknown> };

describe.each(DIALECTS)('我的收藏 (%s)', (dialect) => {
  let t: TestApp;
  let a: string; // the legacy administrator
  let b: string; // a member
  const req = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await t.app.request(path, { method, headers: { ...write, ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const create = (cookie: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => req(cookie, 'POST', '/api/v2/items', { opId: op('c'), item, ...extra });
  const config = async (cookie: string) => (await (await t.app.request('/api/config', { headers: { cookie } })).json()) as { revision: number; config: { apps: { id: string; name: string; url: string }[]; pins: string[] } };

  beforeAll(async () => {
    t = await buildTestApp({ dialect, idp: await fakeIdp(), legacyPasswordLogin: 'on', quotas: { items: 6, wallpapers: 50, icons: 200, storageBytes: 1 << 30 } });
    a = await t.loginLegacy();
    b = (await t.loginOidc({ sub: 'member-items', email: 'items@example.org' })).cookie;
  });
  afterAll(() => t.close());

  it('M5: the administrator’s apps became items with the same ids, order and pins; the home view is unchanged', async () => {
    const seed = defaultConfig();
    const view = await config(a);
    expect(view.config.apps.map((x) => x.id)).toEqual(seed.apps.map((x) => x.id));
    // UI v2 (N2): the tree migration pins the services the home page showed, after the sites.
    const shown = seed.settings.home.showServices ? seed.apps.filter((x) => x.kind === 'service' && !x.hidden && x.showInServices).map((x) => x.id) : [];
    expect(view.config.pins).toEqual([...seed.pins, ...shown.filter((id) => !seed.pins.includes(id))]);
    const snap = (await req(a, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    expect(snap.items.map((i) => i.id)).toEqual(seed.apps.map((x) => x.id));
    expect(snap.items.every((i) => i.kind === 'app' && i.source === 'legacy')).toBe(true);
    expect(snap.pins).toEqual(view.config.pins);
    expect(snap.folders.map((f) => f.id)).toEqual(view.config.apps.length ? expect.arrayContaining(['hosted', 'none']) : []);
  });

  it('a saved page keeps its full address; long titles fit (200); dangerous or credentialed URLs are refused', async () => {
    const url = 'https://example.org/article?id=7&utm_source=x#section-2';
    const title = '一'.repeat(150);
    const r = await create(b, { kind: 'page', title, url, tags: ['阅读'] });
    expect(r.status).toBe(201);
    const item = (r.body as unknown as ItemWriteResult).item;
    expect(item).toMatchObject({ url, title, kind: 'page', folderId: 'none', tags: ['阅读'], pinned: false, version: 1 });
    // Not on the home page: saving does not pin, and pages are not apps.
    expect((await config(b)).config.apps.some((x) => x.id === item.id)).toBe(false);
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pw@example.org/']) expect((await create(b, { title: 'x', url: bad })).status, bad).toBe(422);
    expect((await create(b, { title: '长'.repeat(201), url: 'https://example.org/long' })).status).toBe(422);
  });

  it('the same opId replays its answer; another request under it is refused; duplicates are reported, not doubled', async () => {
    const body = { opId: op('dup'), item: { title: '文档', url: 'https://docs.example.org/a?x=1' } };
    const first = await req(b, 'POST', '/api/v2/items', body);
    const again = await req(b, 'POST', '/api/v2/items', body);
    expect(first.status).toBe(201);
    expect(again).toEqual(first);
    expect((await req(b, 'POST', '/api/v2/items', { ...body, item: { ...body.item, title: '别的' } })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Same address, another save: 409 DUPLICATE with the existing item (scheme/host case-insensitive).
    const dup = await create(b, { title: '再存一次', url: 'HTTPS://DOCS.example.org/a?x=1' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', retryable: false });
    expect((dup.body.details!.item as Item).id).toBe((first.body as unknown as ItemWriteResult).item.id);
    // Same site, another page: not a duplicate.
    expect((await create(b, { title: '另一页', url: 'https://docs.example.org/b' })).status).toBe(201);
    // Explicit update instead.
    const upd = await create(b, { title: '更新的标题', url: 'https://docs.example.org/a?x=1' }, { duplicatePolicy: 'update' });
    expect(upd.status).toBe(200);
    expect((upd.body as unknown as ItemWriteResult).result).toBe('updated');
  });

  it('field-level CAS: different fields merge, the same field conflicts (FIELD_CONFLICT)', async () => {
    const { item } = (await create(b, { title: '原标题', url: 'https://cas.example.org/' })).body as unknown as ItemWriteResult;
    const one = await req(b, 'PATCH', `/api/v2/items/${item.id}`, { opId: op('p1'), baseVersion: 1, patch: { title: '设备一改的' } });
    expect(one.status).toBe(200);
    // Device two still at version 1: a tag change merges.
    const two = await req(b, 'PATCH', `/api/v2/items/${item.id}`, { opId: op('p2'), baseVersion: 1, patch: { tags: ['工作'] } });
    expect(two.status).toBe(200);
    expect((two.body as unknown as ItemWriteResult).item).toMatchObject({ title: '设备一改的', tags: ['工作'], version: 3 });
    // …but its title edit would overwrite device one's: refused with what to merge.
    const three = await req(b, 'PATCH', `/api/v2/items/${item.id}`, { opId: op('p3'), baseVersion: 1, patch: { title: '设备二改的' } });
    expect(three.status).toBe(409);
    expect(three.body).toMatchObject({ code: 'FIELD_CONFLICT', details: { currentVersion: 3, conflictFields: ['title'] } });
  });

  it('delete makes a tombstone that old edits cannot revive; restore is explicit; pins go with it', async () => {
    const { item } = (await create(b, { title: '要删的', url: 'https://gone.example.org/' }, { pinToHome: true })).body as unknown as ItemWriteResult;
    expect(item.pinned).toBe(true);
    expect((await config(b)).config.pins).toContain(item.id);
    const del = await req(b, 'DELETE', `/api/v2/items/${item.id}?opId=${op('d')}`);
    expect((del.body as unknown as ItemWriteResult).item.deletedAt).not.toBeNull();
    expect((await config(b)).config.pins).not.toContain(item.id);
    const stale = await req(b, 'PATCH', `/api/v2/items/${item.id}`, { opId: op('old'), baseVersion: 1, patch: { title: '离线时改的' } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('ITEM_DELETED');
    const back = await req(b, 'POST', `/api/v2/items/${item.id}/restore`, { opId: op('r') });
    expect((back.body as unknown as ItemWriteResult).item).toMatchObject({ deletedAt: null, title: '要删的' });
  });

  it('pins are references: pin, move, unpin — unpinning never deletes; the home view follows', async () => {
    const { item } = (await create(b, { title: '常用文章', url: 'https://pin.example.org/x' })).body as unknown as ItemWriteResult;
    expect((await req(b, 'POST', `/api/v2/pins/${item.id}`, { opId: op('pin') })).status).toBe(200);
    let view = await config(b);
    // A pinned page appears on the home page (as a site), so older clients see it too.
    expect(view.config.pins.at(-1)).toBe(item.id);
    expect(view.config.apps.find((x) => x.id === item.id)?.url).toBe('https://pin.example.org/x');
    expect((await req(b, 'PATCH', `/api/v2/pins/${item.id}`, { opId: op('mv'), position: 0 })).body.pins).toEqual(expect.arrayContaining([item.id]));
    view = await config(b);
    expect(view.config.pins[0]).toBe(item.id);
    expect((await req(b, 'DELETE', `/api/v2/pins/${item.id}?opId=${op('unpin')}`)).status).toBe(200);
    view = await config(b);
    expect(view.config.pins).not.toContain(item.id);
    expect(((await req(b, 'GET', `/api/v2/items?url=${encodeURIComponent('https://pin.example.org/x')}`)).body.items as Item[])[0]?.deletedAt).toBeNull();
  });

  it('the item limit is QUOTA_EXCEEDED (kind items), restores included; the administrator has none', async () => {
    const live = ((await req(b, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items.length;
    const results: number[] = [];
    for (let i = live; i < 8; i++) results.push((await create(b, { title: `第 ${i}`, url: `https://q.example.org/${i}` })).status);
    expect(results.filter((s) => s === 201)).toHaveLength(6 - live);
    const over = await create(b, { title: '多一条', url: 'https://q.example.org/more' });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, details: { kind: 'items', limit: 6, used: 6 } });
    expect((await create(a, { title: '管理员不受限', url: 'https://admin.example.org/' })).status).toBe(201);
  });

  it('changes since a cursor, in order, with the items; another account’s or a forged cursor is refused', async () => {
    const snap = (await req(a, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    const { item } = (await create(a, { title: '增量', url: 'https://changes.example.org/' })).body as unknown as ItemWriteResult;
    await req(a, 'PATCH', `/api/v2/items/${item.id}`, { opId: op('cp'), baseVersion: 1, patch: { note: '备注' } });
    await req(a, 'DELETE', `/api/v2/items/${item.id}?opId=${op('cd')}`);
    const ch = (await req(a, 'GET', `/api/v2/changes?cursor=${encodeURIComponent(snap.cursor)}`)).body as unknown as ChangesResponse;
    const mine = ch.changes.filter((c) => c.id === item.id);
    expect(mine.map((c) => [c.action, c.version])).toEqual([
      ['upsert', 1],
      ['upsert', 2],
      ['delete', 3],
    ]);
    expect(mine.at(-1)!.item?.deletedAt).not.toBeNull();
    // Nothing new after the returned cursor.
    expect(((await req(a, 'GET', `/api/v2/changes?cursor=${encodeURIComponent(ch.nextCursor)}`)).body as unknown as ChangesResponse).changes).toEqual([]);
    // A's cursor in B's hands, and a forged one.
    expect((await req(b, 'GET', `/api/v2/changes?cursor=${encodeURIComponent(snap.cursor)}`)).body.code).toBe('INVALID_CURSOR');
    expect((await req(a, 'GET', '/api/v2/changes?cursor=bm90LWEtY3Vyc29y')).body.code).toBe('INVALID_CURSOR');
    // Pruned history: too old a cursor must rebuild from a snapshot.
    await t.db.run('delete from item_changes where owner_id = ?', [LEGACY_ADMIN_ID]);
    await create(a, { title: '之后', url: 'https://after-prune.example.org/' });
    const old = await req(a, 'GET', `/api/v2/changes?cursor=${encodeURIComponent(snap.cursor)}`);
    expect(old.status).toBe(410);
    expect(old.body.code).toBe('CURSOR_EXPIRED');
  });

  it('legacy home-page ops write items: a long title survives an edit of another field', async () => {
    const { item } = (await create(a, { kind: 'app', title: '一个名字很长很长的应用（超过三十二个字符的完整标题保存在收藏库）', url: 'https://long.example.org/' })).body as unknown as ItemWriteResult;
    const view = await config(a);
    const app = view.config.apps.find((x) => x.id === item.id)!;
    expect([...app.name].length).toBeLessThanOrEqual(32);
    const res = await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'h', batchId: op('legacy'), ops: [{ type: 'app.upsert', app: { ...app, url: 'https://long.example.org/v2' } }] }) });
    expect(res.status).toBe(200);
    const after = ((await req(a, 'GET', `/api/v2/items?url=${encodeURIComponent('https://long.example.org/v2')}`)).body.items as Item[])[0]!;
    expect(after.title).toBe(item.title);
    expect(after.version).toBe(2);
    // The home page's delete is a tombstone too.
    await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'h', batchId: op('legacy-del'), ops: [{ type: 'app.delete', appId: item.id }] }) });
    expect(((await req(a, 'GET', '/api/v2/items?deleted=1')).body.items as Item[]).some((i) => i.id === item.id)).toBe(true);
  });

  it('isolation: B cannot read, change, pin, delete or restore A’s items, nor see them anywhere', async () => {
    const secret = (await create(a, { title: 'A 的私密文章', url: 'https://a-private.example.org/p?id=1' })).body as unknown as ItemWriteResult;
    const id = secret.item.id;
    const tries = [
      await req(b, 'PATCH', `/api/v2/items/${id}`, { opId: op('x1'), baseVersion: 1, patch: { title: 'B' } }),
      await req(b, 'DELETE', `/api/v2/items/${id}?opId=${op('x2')}`),
      await req(b, 'POST', `/api/v2/items/${id}/restore`, { opId: op('x3') }),
      await req(b, 'POST', `/api/v2/pins/${id}`, { opId: op('x4') }),
    ];
    expect(tries.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    for (const path of ['/api/v2/snapshot', '/api/v2/items?q=私密', `/api/v2/items?url=${encodeURIComponent('https://a-private.example.org/p?id=1')}`, '/api/v2/export', '/api/config']) {
      expect(JSON.stringify((await req(b, 'GET', path)).body), path).not.toContain('a-private');
    }
    // Same URL saved by B is B's own item, not a duplicate of A's.
    // (B is at its item limit here, so the answer is QUOTA_EXCEEDED — but never a DUPLICATE of A's.)
    expect((await create(b, { title: 'B 也存了', url: 'https://a-private.example.org/p?id=1' })).body.code).not.toBe('DUPLICATE');
    expect(((await req(a, 'GET', `/api/v2/items?url=${encodeURIComponent('https://a-private.example.org/p?id=1')}`)).body.items as Item[])[0]!.title).toBe('A 的私密文章');
  });

  it('devices: only within their scopes; an old read-only token stays read-only (EX-02)', async () => {
    const memberId = (await t.deps.users.byIdentity(t.deps.env.oidc!.issuer, 'member-items'))!.id;
    const old = (await t.deps.devices.create(memberId, '旧扩展', '')).token;
    const writer = (await t.deps.devices.create(memberId, '新扩展', '', ['config:read', 'items:read', 'items:write'])).token;
    const dev = (token: string) => ({ authorization: `Bearer ${token}`, origin: 'chrome-extension://abcdefghijklmnop' });
    expect((await req('', 'GET', '/api/v2/folders', undefined, dev(old))).body.code).toBe('SCOPE_REQUIRED');
    expect((await req('', 'POST', '/api/v2/items', { opId: op('o'), item: { title: 't', url: 'https://ext.example.org/' } }, dev(old))).body.code).toBe('SCOPE_REQUIRED');
    const saved = await req('', 'POST', '/api/v2/items', { opId: op('e'), source: 'extension', item: { title: '扩展保存的', url: 'https://ext.example.org/a' } }, dev(writer));
    expect(saved.status).toBe(409); // B is at the item limit (6) — refused with the limit, nothing lost on the device
    expect(saved.body.code).toBe('QUOTA_EXCEEDED');
    // Pinning needs pins:write; the config, imports and the operator's tools are never reachable with a device token.
    expect((await req('', 'POST', '/api/v2/items', { opId: op('e2'), item: { title: 'x', url: 'https://ext.example.org/b' }, pinToHome: true }, dev(writer))).body.code).toBe('SCOPE_REQUIRED');
    expect((await req('', 'POST', '/api/v2/import', { opId: op('i'), items: [{ title: 'x', url: 'https://ext.example.org/c' }] }, dev(writer))).status).toBe(401);
    expect((await req('', 'POST', '/api/config/ops', { clientId: 'x', batchId: op('cfg'), ops: [{ type: 'config.replace', config: defaultConfig() }] }, dev(writer))).status).toBe(401);
    expect((await req('', 'POST', '/api/health/test', {}, dev(writer))).status).toBe(401);
    // A revoked device is refused at once.
    const list = await t.deps.devices.list(memberId);
    await t.deps.devices.revoke(memberId, list.find((d) => d.name === '新扩展')!.id);
    expect((await req('', 'GET', '/api/v2/folders', undefined, dev(writer))).body.code).toBe('DEVICE_REVOKED');
  });

  it('import: preview-free server side dedupe, one importId, and undo leaves edited items alone', async () => {
    const before = ((await req(a, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items.length;
    const res = await req(a, 'POST', '/api/v2/import', {
      opId: op('imp'),
      items: [
        { title: '导入一', url: 'https://import.example.org/1' },
        { title: '导入二', url: 'https://import.example.org/2' },
        { title: '重复（本次内）', url: 'https://import.example.org/1' },
        { title: '重复（已存在）', url: 'https://admin.example.org/' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 2, skipped: 2 });
    const importId = res.body.importId as string;
    const snap = (await req(a, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    expect(snap.items.length).toBe(before + 2);
    const edited = snap.items.find((i) => i.url === 'https://import.example.org/2')!;
    await req(a, 'PATCH', `/api/v2/items/${edited.id}`, { opId: op('ed'), baseVersion: 1, patch: { tags: ['保留'] } });
    const undo = await req(a, 'POST', `/api/v2/import/${importId}/undo`, { opId: op('undo') });
    expect(undo.body).toMatchObject({ removed: 1, kept: 1 });
    const exp = (await req(a, 'GET', '/api/v2/export')).body as { format: string; folders: unknown[]; pins: string[]; items: { url: string; tags: string[] }[] };
    expect(exp.format).toBe('nexus-collection');
    expect(exp.folders.length).toBeGreaterThan(0);
    expect(exp.pins.length).toBeGreaterThan(0);
    expect(exp.items.find((i) => i.url === 'https://import.example.org/2')?.tags).toEqual(['保留']);
    expect(exp.items.some((i) => i.url === 'https://import.example.org/1')).toBe(false);
  });

  it('every item write tells only its own account (revision events)', async () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const memberId = (await t.deps.users.byIdentity(t.deps.env.oidc!.issuer, 'member-items'))!.id;
    const offA = t.deps.repo.onChange(LEGACY_ADMIN_ID, (r) => seenA.push(r));
    const offB = t.deps.repo.onChange(memberId, (r) => seenB.push(r));
    await create(a, { title: '通知', url: 'https://notify.example.org/' });
    offA();
    offB();
    expect(seenA).toHaveLength(1);
    expect(seenB).toEqual([]);
  });
});
