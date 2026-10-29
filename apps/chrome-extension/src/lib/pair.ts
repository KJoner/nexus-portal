import { pairPath } from '@nexus/shared';
import { ApiError, deviceApi, type Fetch } from './api';
import type { ServerRecord } from './storage';

export class PairError extends Error {
  constructor(
    readonly reason: 'denied' | 'expired' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'PairError';
  }
}

/** "Chrome · Windows" — shown in the portal next to the approval and in the device list. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : 'Chrome';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || (/Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '');
  return platform ? `${browser} · ${platform}` : browser;
}

export interface PairOptions {
  fetch: Fetch;
  signal: AbortSignal;
  /** Called once the server has issued a code: show it, open the approval page. */
  onCode(code: string, approveUrl: string, expiresAt: number): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new PairError('cancelled', '已取消'))), { once: true });
  });

/**
 * Device pairing: ask for a code, let the signed-in user approve it in the portal, then pick up
 * the token. Network hiccups while waiting are retried until the request expires.
 */
export async function pair(origin: string, name: string, opts: PairOptions): Promise<ServerRecord> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? wait;
  const api = deviceApi(origin, opts.fetch);
  const start = await api.pairStart(name);
  const expiresAt = now() + start.expiresIn * 1000;
  opts.onCode(start.code, `${origin}${pairPath(start.code)}`, expiresAt);
  while (now() < expiresAt) {
    await sleep(Math.max(1, start.interval) * 1000, opts.signal);
    let r;
    try {
      r = await api.pairPoll(start.pairId, start.secret);
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'offline' || e.kind === 'server')) continue;
      throw e;
    }
    if (r.status === 'approved') return { origin, token: r.token, deviceId: r.device.id, deviceName: r.device.name, pairedAt: r.device.createdAt };
    if (r.status === 'denied') throw new PairError('denied', '连接请求已在 Nexus Portal 中被拒绝');
    if (r.status === 'expired') break;
  }
  throw new PairError('expired', '连接请求已过期（10 分钟内有效），请重新连接');
}
