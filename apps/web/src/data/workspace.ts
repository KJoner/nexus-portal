import { storage } from '../lib/storage';

/**
 * 数据空间 (v0.5 · U1): which collection this browser shows and edits — separate from who is signed
 * in and from syncing (02-LOCAL-MODE §2).
 *
 *  - local    本地收藏: this browser's own collection (IndexedDB), nobody's account. The default for
 *             a first visit; signing in never changes it by itself.
 *  - account  the collection of one account on this server: its cache and its unsent changes are
 *             kept per account (config-store), and only that account's session may send them.
 *
 * The choice is remembered per browser. Switching is a fresh page load, so nothing in flight for
 * one space (an answer, a retry, a live event) can reach the other.
 */
export type WorkspaceRef = { kind: 'local' } | { kind: 'account'; id: string };

const KEY = 'nexus.workspace.v1';
/** Pre-v0.5: the account this browser last verified — such a browser keeps using that account. */
const LEGACY_ACCOUNT_KEY = 'nexus.account.v1';

export function readWorkspace(): WorkspaceRef {
  const raw = storage.get<WorkspaceRef>(KEY);
  if (raw?.kind === 'local') return { kind: 'local' };
  if (raw?.kind === 'account' && typeof raw.id === 'string' && raw.id) return { kind: 'account', id: raw.id };
  const legacy = storage.get<{ id?: string }>(LEGACY_ACCOUNT_KEY);
  const ws: WorkspaceRef = legacy?.id ? { kind: 'account', id: legacy.id } : { kind: 'local' };
  storage.set(KEY, ws);
  return ws;
}

export function writeWorkspace(ws: WorkspaceRef): boolean {
  return storage.set(KEY, ws);
}

/** Changes the data space and loads the page afresh (at `path`, default the home page). */
export function switchWorkspace(ws: WorkspaceRef, path = '/'): void {
  writeWorkspace(ws);
  location.assign(path);
}

// ── 登录同步: the person asked to sign in from a local collection ─────────────
const INTENT_KEY = 'nexus.signin.v1';

export interface SignInIntent {
  /** Where to go back to (a path of this app). */
  from: string;
  at: number;
}

const safePath = (p: string | null | undefined) => (p && p.startsWith('/') && !p.startsWith('//') ? p : '/');

export function rememberSignIn(from: string): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ from: safePath(from), at: Date.now() } satisfies SignInIntent));
  } catch {
    /* storage disabled: the connect page still works, it just returns to the home page */
  }
}

export function signInIntent(): SignInIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<SignInIntent>) : null;
    // A sign-in started more than a day ago is not this one.
    return v && typeof v.at === 'number' && Date.now() - v.at < 86_400_000 ? { from: safePath(v.from), at: v.at } : null;
  } catch {
    return null;
  }
}

export function forgetSignIn(): void {
  try {
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    /* nothing kept */
  }
}

// ── a message for the page that loads after a switch ───────────────────────
const NOTICE_KEY = 'nexus.notice.v1';

export function leaveNotice(msg: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, msg);
  } catch {
    /* shown nowhere: the switch itself still happened */
  }
}

export function takeNotice(): string | null {
  try {
    const m = sessionStorage.getItem(NOTICE_KEY);
    if (m) sessionStorage.removeItem(NOTICE_KEY);
    return m;
  } catch {
    return null;
  }
}
