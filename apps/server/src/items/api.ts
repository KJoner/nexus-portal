import {
  CreateItemSchema,
  DEVICE_SCOPE_LABELS,
  ITEM_LIMITS,
  ItemInputSchema,
  itemUrlKey,
  LOCKED_CATEGORY,
  OpIdSchema,
  PatchItemSchema,
  type ChangesResponse,
  type DeviceScope,
  type Item,
  type ItemChange,
  type ItemWriteResult,
  type SnapshotResponse,
} from '@nexus/shared';
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DeviceAuth } from '../auth/devices';
import type { Session } from '../auth/sessions';
import type { ConfigRepo } from '../config/repo';
import type { DB } from '../db';
import { v2Error, type V2Status } from '../http/security';
import type { SecretBox } from '../integrations/secret';
import type { User } from '../users/users';
import { SHARED_LAYOUT } from './store';

/**
 * 我的收藏 v2 API (需求 §8.3–8.4, 契约 §6): items, pins, snapshot and changes.
 *
 * - Every write carries an opId: the same request again returns the stored answer; a different
 *   request under the same opId is IDEMPOTENCY_KEY_REUSED.
 * - PATCH is field-level CAS against baseVersion: fields changed since are FIELD_CONFLICT, other
 *   fields merge. A tombstone answers ITEM_DELETED; only restore brings an item back.
 * - Every change gets a per-account sequence; cursors are sealed (owner, position, expiry), so a
 *   cursor of another account or a forged one is refused.
 * - Owner always comes from the credential: a session, or a paired device with the right scope.
 */
type Vars = { user: User; session: Session; device: DeviceAuth; viaDevice: boolean };
type C = Context<{ Variables: Vars }>;

export interface ItemsApiDeps {
  db: DB;
  repo: ConfigRepo;
  secrets: SecretBox;
  /** Live items an account may keep (null: no limit — the administrator). */
  itemLimit: (user: User) => number | null;
  now?: () => number;
}

class ApiError extends Error {
  constructor(
    readonly status: V2Status,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const CHANGE_KEEP = 20_000;
const CURSOR_DAYS = 90;
const OP_KEEP_DAYS = 30;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function registerItemsApi(app: Hono<{ Variables: Vars }>, deps: ItemsApiDeps) {
  const { db, repo, secrets } = deps;
  const now = deps.now ?? Date.now;
  const store = repo.items;

  const owner = (c: C) => c.get('user').id;
  /** Sessions may do everything of their own account; a device only what it was granted. */
  const need = (c: C, scope: DeviceScope) => {
    if (c.get('viaDevice') && !c.get('device').scopes.includes(scope)) throw new ApiError(403, 'SCOPE_REQUIRED', `此设备没有「${DEVICE_SCOPE_LABELS[scope]}」的权限，请在扩展中重新授权`, { scope });
  };
  const fail = (c: C, e: unknown) => {
    if (e instanceof ApiError) return v2Error(c, e.status, e.code, e.message, { retryable: false, details: e.details });
    throw e;
  };
  const body = async <T>(c: C, schema: z.ZodType<T>): Promise<T> => {
    const r = schema.safeParse(await c.req.json().catch(() => null));
    if (!r.success) {
      const i = r.error.issues[0];
      throw new ApiError(422, 'VALIDATION', i ? `${i.path.join('.') || '请求'}：${i.message}` : '请求格式不正确');
    }
    return r.data;
  };

  // ── cursors: sealed, bound to the account ──────────────────────────────
  type Cursor = { o: string; s?: number; w?: number; p?: [number, string]; e: number };
  const seal = (c: Omit<Cursor, 'e'>) => secrets.seal(JSON.stringify({ ...c, e: now() + CURSOR_DAYS * 86_400_000 }));
  const unseal = (raw: string, ownerId: string): Cursor => {
    let c: Cursor;
    try {
      c = JSON.parse(secrets.open(raw)) as Cursor;
    } catch {
      throw new ApiError(400, 'INVALID_CURSOR', '游标无效');
    }
    // Another account's cursor is answered like a forged one (no hint that it exists).
    if (c.o !== ownerId) throw new ApiError(400, 'INVALID_CURSOR', '游标无效');
    if (c.e < now()) throw new ApiError(410, 'CURSOR_EXPIRED', '游标已过期，请重新获取全部收藏');
    return c;
  };

  /**
   * One write: the account's lock, idempotency by opId, the change itself, a new configuration
   * revision (the home page view may change), and the answer stored for a replay.
   */
  async function write(c: C, opId: string, request: unknown, run: () => Promise<{ status: 200 | 201; body: unknown }>) {
    const ownerId = owner(c);
    const requestHash = hash(request);
    let revision = 0;
    const res = await db.tx(async () => {
      await repo.lock(ownerId);
      const seen = await store.findOp(ownerId, opId);
      if (seen) {
        if (seen.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一个 opId 已用于另一个请求');
        return { status: seen.status as 200 | 201, body: JSON.parse(seen.result) as unknown, replay: true };
      }
      const out = await run();
      revision = (await repo.bump(ownerId)).revision;
      const answer = out.body && typeof out.body === 'object' && 'ownerRevision' in (out.body as object) ? { ...(out.body as object), ownerRevision: revision } : out.body;
      await store.saveOp(ownerId, opId, requestHash, out.status, answer);
      if ((await store.seq(ownerId)) % 500 === 0) {
        await store.prune(ownerId, CHANGE_KEEP);
        await store.pruneOps(ownerId, now() - OP_KEEP_DAYS * 86_400_000);
      }
      return { status: out.status, body: answer, replay: false };
    });
    if (!res.replay && revision) repo.emit(ownerId, revision);
    return c.json(res.body as object, res.status);
  }

  const live = async (ownerId: string, id: string): Promise<Item> => {
    const item = await store.get(ownerId, id);
    if (!item) throw new ApiError(404, 'NOT_FOUND', '收藏不存在');
    if (item.deletedAt !== null) throw new ApiError(409, 'ITEM_DELETED', '这条收藏已被删除；需要时先恢复', { item });
    return item;
  };
  const folders = async (ownerId: string) => (await repo.snapshot(ownerId)).config.categories.map((k) => ({ id: k.id, label: k.label, locked: !!k.locked }));
  const folderOf = async (ownerId: string, folderId: string | undefined) => {
    if (!folderId) return LOCKED_CATEGORY.none;
    if (!(await folders(ownerId)).some((f) => f.id === folderId)) throw new ApiError(422, 'VALIDATION', '分组不存在');
    return folderId;
  };
  const admitItems = async (c: C, n: number) => {
    const limit = deps.itemLimit(c.get('user'));
    if (limit === null) return;
    const used = await store.countLive(owner(c));
    if (used + n > limit) throw new ApiError(409, 'QUOTA_EXCEEDED', `收藏库最多 ${limit} 条，请先删除一些`, { kind: 'items', limit, used });
  };
  const result = (item: Item, r: ItemWriteResult['result']): ItemWriteResult => ({ item, result: r, ownerRevision: 0 });

  // ── reads ──────────────────────────────────────────────────────────────
  app.get('/api/v2/folders', async (c) => {
    try {
      need(c, 'items:read');
      // The account too: a browser extension checks it before sending drafts saved while signed out.
      const u = c.get('user');
      return c.json({ folders: await folders(owner(c)), account: { id: u.id, label: u.email || u.displayName || (u.isAdmin ? '管理员' : u.id) } });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Search / lookup (the extension asks whether a page is already saved). The web app uses snapshot + changes. */
  app.get('/api/v2/items', async (c) => {
    try {
      need(c, 'items:read');
      const ownerId = owner(c);
      const url = c.req.query('url');
      if (url) {
        const found = await store.findByUrl(ownerId, url);
        return c.json({ items: found ? [found] : [], nextCursor: null });
      }
      const q = (c.req.query('q') ?? '').trim().toLowerCase();
      const folderId = c.req.query('folderId');
      const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
      const all = (await store.list(ownerId, { deleted: c.req.query('deleted') === '1' })).filter((i) => (!folderId || i.folderId === folderId) && (!q || i.title.toLowerCase().includes(q) || i.url.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q))));
      const cursor = c.req.query('cursor');
      const start = cursor ? (unseal(cursor, ownerId).p?.[0] ?? 0) : 0;
      const page = all.slice(start, start + limit);
      return c.json({ items: page, nextCursor: start + limit < all.length ? seal({ o: ownerId, p: [start + limit, ''] }) : null });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Full state with a watermark; pages share it, and changes continue from `cursor`. */
  app.get('/api/v2/snapshot', async (c) => {
    try {
      need(c, 'items:read');
      const ownerId = owner(c);
      const PAGE = 1000;
      const pageCursor = c.req.query('page');
      const res = await db.tx(async (): Promise<SnapshotResponse> => {
        const p = pageCursor ? unseal(pageCursor, ownerId) : null;
        const watermark = p?.w ?? (await store.seq(ownerId));
        const items = await store.list(ownerId, { limit: PAGE + 1, after: p?.p ? { position: p.p[0], id: p.p[1] } : null });
        const more = items.length > PAGE;
        const page = items.slice(0, PAGE);
        const last = page.at(-1);
        return {
          items: page,
          pins: await store.pinnedIds(ownerId),
          folders: await folders(ownerId),
          watermark,
          cursor: seal({ o: ownerId, s: watermark }),
          nextPage: more && last ? seal({ o: ownerId, w: watermark, p: [last.position, last.id] }) : null,
        };
      });
      return c.json(res);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/v2/changes', async (c) => {
    try {
      need(c, 'items:read');
      const ownerId = owner(c);
      const raw = c.req.query('cursor');
      if (!raw) throw new ApiError(400, 'INVALID_CURSOR', '缺少游标');
      const cur = unseal(raw, ownerId);
      const after = cur.s ?? 0;
      const oldest = await store.oldestSeq(ownerId);
      // Changes after this cursor were already pruned: only a full snapshot can catch up.
      if (oldest !== null && after < oldest - 1) throw new ApiError(410, 'CURSOR_EXPIRED', '游标太旧，请重新获取全部收藏');
      const LIMIT = 500;
      const rows = await store.changesSince(ownerId, after, LIMIT + 1);
      const page = rows.slice(0, LIMIT);
      const changes: ItemChange[] = [];
      for (const r of page) {
        const entity = r.entity;
        const change: ItemChange = { seq: Number(r.seq), entity, id: r.entity_id, version: Number(r.version), action: r.action as ItemChange['action'] };
        if (entity === 'item') change.item = (await store.get(ownerId, r.entity_id)) ?? undefined;
        changes.push(change);
      }
      const last = page.at(-1);
      const body: ChangesResponse & { pins?: string[]; folders?: Awaited<ReturnType<typeof folders>> } = { changes, nextCursor: seal({ o: ownerId, s: last ? Number(last.seq) : after }), hasMore: rows.length > LIMIT };
      // Pins and folders change as a whole: their current state rides along when they changed.
      if (page.some((r) => r.entity === 'pins')) body.pins = await store.pinnedIds(ownerId);
      if (page.some((r) => r.entity === 'folders')) body.folders = await folders(ownerId);
      return c.json(body);
    } catch (e) {
      return fail(c, e);
    }
  });

  // ── writes ─────────────────────────────────────────────────────────────
  app.post('/api/v2/items', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    try {
      need(c, 'items:write');
      const req = await body(c, CreateItemSchema);
      if (req.pinToHome) need(c, 'pins:write');
      return await write(c, req.opId, ['create', req], async () => {
        const ownerId = owner(c);
        const input = req.item;
        const existing = await store.findByUrl(ownerId, input.url);
        if (existing && req.duplicatePolicy === 'prompt') throw new ApiError(409, 'DUPLICATE', '这个网址已经在收藏库里', { item: existing });
        if (existing && req.duplicatePolicy === 'update') {
          const updated = await store.update(ownerId, existing.id, { title: input.title, folderId: await folderOf(ownerId, input.folderId), tags: input.tags, note: input.note || existing.note });
          if (req.pinToHome && !updated.pinned) await store.setPins(ownerId, [...(await store.pinnedIds(ownerId)), updated.id]);
          return { status: 200, body: result((await store.get(ownerId, updated.id))!, 'updated') };
        }
        await admitItems(c, 1);
        const item = await store.insert(ownerId, { kind: input.kind ?? 'page', source: req.source, catalogId: input.catalogId ?? null, title: input.title, url: input.url, folderId: await folderOf(ownerId, input.folderId), tags: input.tags, note: input.note, iconRef: input.iconRef });
        if (req.pinToHome) await store.setPins(ownerId, [...(await store.pinnedIds(ownerId)), item.id]);
        return { status: 201, body: result((await store.get(ownerId, item.id))!, 'created') };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.patch('/api/v2/items/:id', bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    try {
      need(c, 'items:write');
      const req = await body(c, PatchItemSchema);
      const id = c.req.param('id');
      return await write(c, req.opId, ['patch', id, req], async () => {
        const ownerId = owner(c);
        const item = await live(ownerId, id);
        const fields = await store.fieldVersions(ownerId, id);
        // Field-level CAS: a field someone changed after baseVersion cannot be overwritten blindly.
        const conflictFields = Object.keys(req.patch).filter((f) => (fields[f] ?? 0) > req.baseVersion);
        if (conflictFields.length) throw new ApiError(409, 'FIELD_CONFLICT', '这些字段在别处已被修改，请先合并', { currentVersion: item.version, conflictFields, item });
        const patch = { ...req.patch, ...(req.patch.folderId !== undefined ? { folderId: await folderOf(ownerId, req.patch.folderId) } : {}) };
        const updated = await store.update(ownerId, id, patch);
        return { status: 200, body: result(updated, 'updated') };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/v2/items/:id', async (c) => {
    try {
      need(c, 'items:write');
      const opId = OpIdSchema.safeParse(c.req.query('opId'));
      if (!opId.success) throw new ApiError(422, 'VALIDATION', '缺少 opId');
      const id = c.req.param('id');
      const expected = c.req.query('expectedVersion');
      return await write(c, opId.data, ['delete', id, expected ?? null], async () => {
        const ownerId = owner(c);
        const item = await store.get(ownerId, id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', '收藏不存在');
        if (item.deletedAt !== null) return { status: 200, body: result(item, 'unchanged') };
        if (expected !== undefined && Number(expected) !== item.version) throw new ApiError(409, 'REVISION_CONFLICT', '这条收藏在别处已被修改', { currentVersion: item.version, item });
        return { status: 200, body: result(await store.tombstone(ownerId, id), 'deleted') };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/v2/items/:id/restore', bodyLimit({ maxSize: 4096 }), async (c) => {
    try {
      need(c, 'items:write');
      const req = await body(c, z.object({ opId: OpIdSchema }));
      const id = c.req.param('id');
      return await write(c, req.opId, ['restore', id], async () => {
        const ownerId = owner(c);
        const item = await store.get(ownerId, id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', '收藏不存在');
        if (item.deletedAt === null) return { status: 200, body: result(item, 'unchanged') };
        await admitItems(c, 1);
        return { status: 200, body: result(await store.restore(ownerId, id), 'restored') };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  // ── pins (references to items, 契约 §6) ──────────────────────────────────
  const PinSchema = z.object({ opId: OpIdSchema, position: z.number().int().min(0).optional() });
  const pinWrite = (action: 'pin' | 'move' | 'unpin') => async (c: C) => {
    try {
      need(c, 'pins:write');
      const id = c.req.param('itemId')!;
      const req = action === 'unpin' ? { opId: OpIdSchema.parse(c.req.query('opId')), position: undefined } : await body(c, PinSchema);
      return await write(c, req.opId, [action, id, req.position ?? null], async () => {
        const ownerId = owner(c);
        await live(ownerId, id);
        const pins = (await store.pinnedIds(ownerId, SHARED_LAYOUT)).filter((x) => x !== id);
        if (action !== 'unpin') {
          if (action === 'pin' && pins.length >= 36) throw new ApiError(409, 'QUOTA_EXCEEDED', '首页最多固定 36 个', { kind: 'pins', limit: 36, used: pins.length });
          pins.splice(Math.min(req.position ?? pins.length, pins.length), 0, id);
        }
        await store.setPins(ownerId, pins);
        return { status: 200, body: { pins, ownerRevision: 0 } };
      });
    } catch (e) {
      if (e instanceof z.ZodError) return v2Error(c, 422, 'VALIDATION', '缺少 opId');
      return fail(c, e);
    }
  };
  app.post('/api/v2/pins/:itemId', bodyLimit({ maxSize: 4096 }), pinWrite('pin'));
  app.patch('/api/v2/pins/:itemId', bodyLimit({ maxSize: 4096 }), pinWrite('move'));
  app.delete('/api/v2/pins/:itemId', pinWrite('unpin'));

  // ── import / export (需求 §8.3) — sessions only ─────────────────────────
  const ImportSchema = z.object({
    opId: OpIdSchema,
    /** Folder for everything imported (an existing one), or the inbox. */
    folderId: z.string().max(64).optional(),
    items: z.array(ItemInputSchema.extend({ kind: z.enum(['app', 'page']).default('page') })).min(1).max(5000),
    /** Addresses already in the collection are skipped unless asked otherwise. */
    skipDuplicates: z.boolean().default(true),
  });
  app.post('/api/v2/import', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    try {
      if (c.get('viaDevice')) throw new ApiError(403, 'SCOPE_REQUIRED', '导入只能在网页中进行');
      const req = await body(c, ImportSchema);
      return await write(c, req.opId, ['import', req], async () => {
        const ownerId = owner(c);
        const folderId = await folderOf(ownerId, req.folderId);
        const known = new Set((await store.list(ownerId)).map((i) => itemUrlKey(i.url)));
        const seen = new Set<string>();
        const fresh = req.items.filter((i) => {
          const k = itemUrlKey(i.url);
          if (seen.has(k) || (req.skipDuplicates && known.has(k))) return false;
          seen.add(k);
          return true;
        });
        await admitItems(c, fresh.length);
        const importId = `imp-${req.opId.slice(-16)}`;
        let position = (await store.maxPosition(ownerId)) + 1;
        for (const i of fresh) await store.insert(ownerId, { kind: i.kind ?? 'page', source: 'import', title: i.title, url: i.url, folderId: i.folderId && (await folders(ownerId)).some((f) => f.id === i.folderId) ? i.folderId : folderId, tags: i.tags, note: i.note, iconRef: i.iconRef, position: position++, importId });
        return { status: 201, body: { importId, imported: fresh.length, skipped: req.items.length - fresh.length, ownerRevision: 0 } };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** 撤销本次导入: what the import created and nobody changed since goes to the trash. */
  app.post('/api/v2/import/:importId/undo', bodyLimit({ maxSize: 4096 }), async (c) => {
    try {
      if (c.get('viaDevice')) throw new ApiError(403, 'SCOPE_REQUIRED', '只能在网页中撤销导入');
      const req = await body(c, z.object({ opId: OpIdSchema }));
      const importId = c.req.param('importId');
      return await write(c, req.opId, ['undo-import', importId], async () => {
        const ownerId = owner(c);
        const rows = await db.all<{ id: string; version: number }>('select id, version from items where owner_id = ? and import_id = ? and deleted_at is null', [ownerId, importId]);
        let removed = 0;
        let kept = 0;
        for (const r of rows) {
          // Edited after the import: the person made it theirs — left alone and reported.
          if (Number(r.version) > 1) kept++;
          else {
            await store.tombstone(ownerId, r.id);
            removed++;
          }
        }
        return { status: 200, body: { importId, removed, kept, ownerRevision: 0 } };
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/v2/export', async (c) => {
    try {
      if (c.get('viaDevice')) throw new ApiError(403, 'SCOPE_REQUIRED', '导出只能在网页中进行');
      const ownerId = owner(c);
      const items = await store.list(ownerId);
      const date = new Date(now()).toISOString().slice(0, 10);
      c.header('Content-Disposition', `attachment; filename="nexus-collection-${date}.json"`);
      return c.json({
        format: 'nexus-collection',
        version: 1,
        exportedAt: new Date(now()).toISOString(),
        folders: await folders(ownerId),
        pins: await store.pinnedIds(ownerId),
        items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, url: i.url, folderId: i.folderId, tags: i.tags, note: i.note, catalogId: i.catalogId, pinned: i.pinned, createdAt: new Date(i.createdAt).toISOString() })),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  return { limits: ITEM_LIMITS };
}
