import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMerge, previewMerge } from './identity';
import { memoryLocalStore } from './local/store';
import { localTransport } from './local/transport';

/**
 * 合并到我的账号 (02-LOCAL-MODE §4, L11–L13): the server's restore plans and applies it; what the
 * browser must guarantee is that nothing is sent before the preview is confirmed, that a retry
 * after a lost answer is the very same request (the server answers it from its record instead of
 * importing twice), and that a changed collection or account asks for a new preview.
 */
type Sent = { opId: string; dryRun: boolean; basis?: number; file: unknown; duplicates: string };
let sent: Sent[];
let failApply: 'network' | 'stale' | null;

beforeEach(() => {
  localStorage.clear();
  sent = [];
  failApply = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Sent;
      sent.push(body);
      if (!body.dryRun && failApply === 'network') throw new TypeError('Failed to fetch');
      if (!body.dryRun && failApply === 'stale') return new Response(JSON.stringify({ code: 'PLAN_STALE', message: '「我的收藏」在预览之后有了变化', retryable: false, details: { basis: 9 } }), { status: 409, headers: { 'content-type': 'application/json' } });
      const summary = { folders: { create: [], map: [], overLimit: 0 }, items: { create: 2, update: 0, skip: 0, repeated: 0, unsupported: 0, kinds: { app: 0, page: 2 } }, duplicates: [], duplicateCount: 0, pins: { restore: 1, notPinned: 0, limit: 36 }, icons: { upload: 0, missing: 0 } };
      return new Response(JSON.stringify(body.dryRun ? { dryRun: true, importId: null, summary, basis: 7 } : { importId: `imp-${body.opId.slice(-16)}`, summary, undo: { folders: [], pins: [] }, ownerRevision: 8 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function localWithTwo() {
  const t = localTransport({ store: memoryLocalStore('local:merge-test'), bundledCatalog: async () => ({ catalogVersion: 't', categories: [], items: [], nextCursor: null }) });
  await t.items.create({ opId: 'seed-000000001', item: { title: '一', url: 'https://one.example.org' }, pinToHome: true });
  await t.items.create({ opId: 'seed-000000002', item: { title: '二', url: 'https://two.example.org' } });
  return t;
}

describe('合并到我的账号', () => {
  it('previews first; a retry after a lost answer sends the same request with the same opId', async () => {
    const local = await localWithTwo();
    const preview = await previewMerge(local, 'u-1', 'skip');
    expect(sent.map((s) => s.dryRun)).toEqual([true]);
    expect(preview.answer.summary.items.create).toBe(2);

    failApply = 'network';
    const lost = await applyMerge(local, preview);
    expect(lost).toMatchObject({ ok: false, stale: false });
    failApply = null;
    const done = await applyMerge(local, preview);
    expect(done.ok).toBe(true);

    const applies = sent.filter((s) => !s.dryRun);
    expect(applies).toHaveLength(2);
    expect(applies[1]!.opId).toBe(applies[0]!.opId);
    expect(applies[1]).toEqual(applies[0]);
    expect(applies[0]!.basis).toBe(7);
    // The local collection is untouched by a merge.
    expect((await local.items.snapshot()).items).toHaveLength(2);
  });

  it('a collection changed after the preview asks for a new one (nothing sent)', async () => {
    const local = await localWithTwo();
    const preview = await previewMerge(local, 'u-1', 'skip');
    await local.items.create({ opId: 'later-0000000001', item: { title: '三', url: 'https://three.example.org' } });
    const r = await applyMerge(local, preview);
    expect(r).toMatchObject({ ok: false, stale: true });
    expect(sent.filter((s) => !s.dryRun)).toEqual([]);
  });

  it('the account changed after the preview: PLAN_STALE, and the next attempt is a new merge', async () => {
    const local = await localWithTwo();
    const preview = await previewMerge(local, 'u-1', 'skip');
    failApply = 'stale';
    expect(await applyMerge(local, preview)).toMatchObject({ ok: false, stale: true });
    failApply = null;
    const fresh = await previewMerge(local, 'u-1', 'skip');
    await applyMerge(local, fresh);
    const applies = sent.filter((s) => !s.dryRun);
    expect(applies).toHaveLength(2);
    expect(applies[1]!.opId).not.toBe(applies[0]!.opId);
  });
});
