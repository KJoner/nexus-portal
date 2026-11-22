import type { AuthOptions, MeResponse } from '@nexus/shared';
import { create } from 'zustand';
import type { RestoreAnswer, RestoreDuplicates } from './transport';
import { HttpError, httpTransport, NetworkError } from './transport';
import type { LocalTransport } from './local/transport';
import { storage } from '../lib/storage';

/**
 * 身份 (v0.5 · U1): who is signed in on this server — a dimension of its own, apart from which
 * collection the page shows (workspace.ts). In a local collection nothing asks the server on its
 * own: only when the person opens 登录同步 / 账号与同步, or comes back from signing in.
 */
export type IdentityStatus = 'unknown' | 'checking' | 'signed-in' | 'signed-out' | 'offline' | 'unavailable';

interface IdentityState {
  status: IdentityStatus;
  me: MeResponse | null;
  options: AuthOptions | null;
  /** The sign-in options could not be read (offline, server down): the page says so instead of waiting. */
  optionsFailed: boolean;
}

export const useIdentity = create<IdentityState>(() => ({ status: 'unknown', me: null, options: null, optionsFailed: false }));

export async function checkIdentity(): Promise<IdentityStatus> {
  useIdentity.setState({ status: 'checking' });
  try {
    const me = await httpTransport.me();
    useIdentity.setState({ status: 'signed-in', me });
    return 'signed-in';
  } catch (e) {
    const status: IdentityStatus = e instanceof HttpError && e.status === 401 ? 'signed-out' : e instanceof NetworkError ? 'offline' : 'unavailable';
    useIdentity.setState({ status, me: null });
    return status;
  }
}

/** Sign-in options of this server (public): the shared account, and/or the old access password. */
export async function loadAuthOptions(): Promise<AuthOptions | null> {
  try {
    const o = await httpTransport.authOptions();
    useIdentity.setState({ options: o, optionsFailed: false });
    return o;
  } catch (e) {
    // An older server without /api/v2: the password, as before.
    if (e instanceof HttpError && e.status === 404) {
      const o: AuthOptions = { oidc: false, legacyPassword: true, registration: 'closed', accountUrl: null };
      useIdentity.setState({ options: o, optionsFailed: false });
      return o;
    }
    useIdentity.setState({ optionsFailed: true });
    return null;
  }
}

/** The signed-in account's device API, whichever collection the page shows (approving / revoking extensions). */
export const accountDevicesApi = {
  list: () => httpTransport.devices(),
  revoke: (id: string) => httpTransport.revokeDevice(id),
  pairing: (code: string) => httpTransport.pairingRequest(code),
  decide: (code: string, approve: boolean, scopes?: string[]) => httpTransport.decidePairing(code, approve, scopes),
};

export const accountLabel = (me: MeResponse | null) => (me ? me.account.email || me.account.displayName || (me.role === 'admin' ? '管理员' : me.account.id) : '');

// ── 合并到我的账号 (02-LOCAL-MODE §4) ───────────────────────────────────────
/**
 * One merge of this browser's local collection into an account: the local collection exported as a
 * `nexus-collection` file, planned and applied by the server's own restore (its preview, its
 * `basis` check, its opId idempotency). The record below keeps the opId of a merge that was sent:
 * a retry after a lost answer (refresh, network) sends the very same request and is answered from
 * the server's record instead of importing twice. Bound to the account and the local revision it
 * was made for — another account or a changed collection makes a new one.
 */
const MERGE_KEY = 'nexus.merge.v1';

interface MergeRecord {
  opId: string;
  account: string;
  localId: string;
  revision: number;
  duplicates: RestoreDuplicates;
  basis: number;
  exportedAt: string;
  at: number;
}

export interface MergePreview {
  answer: RestoreAnswer;
  duplicates: RestoreDuplicates;
  /** Local revision the preview was made for. */
  revision: number;
  exportedAt: string;
  localId: string;
  account: string;
}

const newOpId = () => `merge-${(crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 24)}`;

export async function previewMerge(local: LocalTransport, account: string, duplicates: RestoreDuplicates): Promise<MergePreview> {
  const state = await local.state();
  // The file is the collection at its last change: the same collection gives the same bytes.
  const exportedAt = state.updatedAt;
  const file = await local.exportFile(exportedAt, { onlyUsedFolders: true });
  const answer = await httpTransport.items.restoreCollection({ opId: newOpId(), file, duplicates, dryRun: true });
  return { answer, duplicates, revision: state.revision, exportedAt, localId: state.workspace, account };
}

export type MergeOutcome = { ok: true; answer: RestoreAnswer } | { ok: false; stale: true; message: string } | { ok: false; stale: false; message: string; code?: string };

export async function applyMerge(local: LocalTransport, preview: MergePreview): Promise<MergeOutcome> {
  const state = await local.state();
  if (state.revision !== preview.revision || state.workspace !== preview.localId) return { ok: false, stale: true, message: '此浏览器的收藏在预览之后有了变化，已重新预览' };
  const kept = storage.get<MergeRecord>(MERGE_KEY);
  const same = kept && kept.account === preview.account && kept.localId === preview.localId && kept.revision === preview.revision && kept.duplicates === preview.duplicates && kept.basis === preview.answer.basis && kept.exportedAt === preview.exportedAt;
  const record: MergeRecord = same ? kept : { opId: newOpId(), account: preview.account, localId: preview.localId, revision: preview.revision, duplicates: preview.duplicates, basis: preview.answer.basis ?? 0, exportedAt: preview.exportedAt, at: Date.now() };
  // Written before sending: the answer may be lost, the retry must be the same request.
  storage.set(MERGE_KEY, record);
  const file = await local.exportFile(preview.exportedAt, { onlyUsedFolders: true });
  try {
    const answer = await httpTransport.items.restoreCollection({ opId: record.opId, file, duplicates: record.duplicates, dryRun: false, basis: record.basis });
    storage.remove(MERGE_KEY);
    return { ok: true, answer };
  } catch (e) {
    if (e instanceof HttpError && e.code === 'PLAN_STALE') {
      storage.remove(MERGE_KEY);
      return { ok: false, stale: true, message: '账号里的收藏在预览之后有了变化，已重新预览' };
    }
    if (e instanceof HttpError && e.code === 'IDEMPOTENCY_KEY_REUSED') {
      storage.remove(MERGE_KEY);
      return { ok: false, stale: true, message: '这次合并需要重新预览' };
    }
    if (e instanceof NetworkError) return { ok: false, stale: false, message: '网络中断，合并没有确认完成。此浏览器的收藏没有改动；再次点击「确认合并」会继续同一次合并，不会重复导入。' };
    if (e instanceof HttpError && e.code === 'QUOTA_EXCEEDED') return { ok: false, stale: false, code: e.code, message: `${e.message}。账号里的收藏没有改动；可以先在此浏览器删除一些收藏再合并，或者选择只使用账号里的收藏。` };
    if (e instanceof HttpError && e.status === 401) return { ok: false, stale: false, code: 'UNAUTHENTICATED', message: '登录已失效，请重新登录后再合并。此浏览器的收藏没有改动。' };
    return { ok: false, stale: false, message: e instanceof HttpError ? e.message : '合并失败，请重试' };
  }
}
