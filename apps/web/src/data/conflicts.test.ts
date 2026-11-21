import { beforeEach, describe, expect, it } from 'vitest';
import { runUndo, useToastStore } from '../components/toast-store';
import { dispatch, flush, onSyncRejected, refresh, resetSync, resolveHeld, useConfigStore } from './config-store';
import { MemoryTransport, NetworkError } from './transport';

/**
 * NEX-04 在首页一侧：离线修改晚于别处的删除到达时，不在本机把应用加回来，也不丢掉修改——
 * 保留为冲突，由人选择「恢复并应用 / 另存为新应用 / 放弃」；撤销删除走显式恢复。
 */
let server: MemoryTransport;
const state = () => useConfigStore.getState();
const app = (id: string) => state().snapshot.config.apps.find((a) => a.id === id);
const conflicts = () => state().held.filter((h) => h.reason === 'conflict');
const told: string[] = [];

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  resetSync(server);
  useToastStore.setState({ current: null });
  told.length = 0;
  onSyncRejected((m) => told.push(m));
});

/** An edit made offline, then another device deletes the app, then this device reconnects. */
async function offlineEditThenRemoteDelete(id = 'github') {
  server.online = false;
  const before = app(id)!;
  expect(dispatch({ type: 'app.upsert', app: { ...before, name: '离线改名' } }).ok).toBe(true);
  await flush();
  expect(state().pending).toHaveLength(1);
  server.remoteChange([{ type: 'app.delete', appId: id }]);
  server.online = true;
  await refresh();
}

describe('NEX-04 · 首页离线修改与删除', () => {
  it('撤销删除发出的是显式恢复（app.restore），不是旧条目的 upsert', async () => {
    const r = dispatch({ type: 'app.delete', appId: 'notion' });
    expect(r.ok).toBe(true);
    await flush();
    expect(server.config.apps.some((a) => a.id === 'notion')).toBe(false);
    if (!r.ok) return;
    expect(r.undo[0]).toMatchObject({ type: 'app.restore', app: { id: 'notion' } });
    runUndo({ id: 1, msg: '', tone: 'undo', undo: r.undo });
    await flush();
    expect(server.calls.at(-1)!.ops[0]!.type).toBe('app.restore');
    expect(server.config.apps.some((a) => a.id === 'notion')).toBe(true);
  });

  it('别处删除后到达的离线修改：本机不加回、服务端不复活、修改保留为冲突（刷新后仍在）', async () => {
    await offlineEditThenRemoteDelete();
    expect(app('github')).toBeUndefined();
    expect(server.config.apps.some((a) => a.id === 'github')).toBe(false);
    expect(state().pending).toEqual([]);
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0]).toMatchObject({ code: 'ITEM_DELETED', batch: { ops: [{ type: 'app.upsert', app: { name: '离线改名' } }] } });
    expect(told.at(-1)).toContain('已保留在本机');
    expect(JSON.parse(localStorage.getItem('nexus.cache.v3:legacy-admin')!).held).toHaveLength(1);
  });

  it('先收到更新的快照（发送仍失败）时同样保留为冲突，不在本机重新创建', async () => {
    server.online = false;
    dispatch({ type: 'app.upsert', app: { ...app('gmail')!, name: '离线改名' } });
    await flush();
    server.remoteChange([{ type: 'app.delete', appId: 'gmail' }]);
    server.online = true;
    server.postOps = async () => {
      throw new NetworkError();
    };
    await refresh();
    expect(app('gmail')).toBeUndefined();
    expect(state().pending).toEqual([]);
    expect(conflicts()[0]).toMatchObject({ code: 'ITEM_DELETED' });
  });

  it('「恢复并应用我的修改」：先显式恢复服务端那份，再应用我的修改', async () => {
    await offlineEditThenRemoteDelete();
    const r = resolveHeld(state().held.indexOf(conflicts()[0]!), 'mine');
    expect(r.ok).toBe(true);
    await flush();
    expect(server.calls.at(-1)!.ops.map((o) => o.type)).toEqual(['app.restore', 'app.upsert']);
    expect(server.config.apps.find((a) => a.id === 'github')).toMatchObject({ name: '离线改名' });
    expect(conflicts()).toEqual([]);
  });

  it('「另存为新应用」：我的版本成为一条新应用，删除的那条仍在回收站', async () => {
    await offlineEditThenRemoteDelete();
    expect(resolveHeld(state().held.indexOf(conflicts()[0]!), 'copy').ok).toBe(true);
    await flush();
    expect(server.config.apps.some((a) => a.id === 'github')).toBe(false);
    expect(server.config.apps.filter((a) => a.name === '离线改名')).toHaveLength(1);
    expect(server.deleted.has('github')).toBe(true);
  });

  it('「放弃」只去掉这项更改', async () => {
    await offlineEditThenRemoteDelete();
    resolveHeld(state().held.indexOf(conflicts()[0]!), 'discard');
    expect(state().held).toEqual([]);
    expect(server.config.apps.some((a) => a.id === 'github')).toBe(false);
  });

  it('不同字段在两处修改：自动合并，不打扰人', async () => {
    server.online = false;
    const gh = app('github')!;
    dispatch({ type: 'app.upsert', app: { ...gh, name: '我改的名' } });
    await flush();
    server.remoteChange([{ type: 'app.upsert', app: { ...gh, url: 'https://elsewhere.example.org/' } }]);
    server.online = true;
    await refresh();
    expect(state().held).toEqual([]);
    expect(server.config.apps.find((a) => a.id === 'github')).toMatchObject({ name: '我改的名', url: 'https://elsewhere.example.org/' });
  });

  it('同一字段在两处修改：FIELD_CONFLICT；「用我的修改」只覆盖我改过的字段', async () => {
    server.online = false;
    const gh = app('github')!;
    dispatch({ type: 'app.upsert', app: { ...gh, name: '我改的名', description: '我加的描述' } });
    await flush();
    server.remoteChange([{ type: 'app.upsert', app: { ...gh, name: '别处改的名', url: 'https://elsewhere.example.org/' } }]);
    server.online = true;
    await refresh();
    expect(conflicts()[0]).toMatchObject({ code: 'FIELD_CONFLICT', details: { conflictFields: ['name'] } });
    // Refused as a whole: the description is not half-applied.
    expect(server.config.apps.find((a) => a.id === 'github')).toMatchObject({ name: '别处改的名', description: gh.description });
    expect(resolveHeld(state().held.indexOf(conflicts()[0]!), 'mine').ok).toBe(true);
    await flush();
    expect(server.config.apps.find((a) => a.id === 'github')).toMatchObject({ name: '我改的名', description: '我加的描述', url: 'https://elsewhere.example.org/' });
  });

  it('删除别处刚改过的应用：保留为 REVISION_CONFLICT，「仍然执行」才删除', async () => {
    server.online = false;
    const yt = app('youtube')!;
    dispatch({ type: 'app.delete', appId: 'youtube' });
    await flush();
    server.remoteChange([{ type: 'app.upsert', app: { ...yt, name: '别处改过' } }]);
    server.online = true;
    await refresh();
    expect(conflicts()[0]).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(server.config.apps.find((a) => a.id === 'youtube')?.name).toBe('别处改过');
    expect(resolveHeld(state().held.indexOf(conflicts()[0]!), 'mine').ok).toBe(true);
    await flush();
    expect(server.config.apps.some((a) => a.id === 'youtube')).toBe(false);
  });
});
