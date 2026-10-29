/**
 * Read-only device access (v0.3) for the Chrome extension. A device never sees the access password
 * or a session cookie: it is paired once (approved by the signed-in user in the portal) and then
 * reads the configuration with its own revocable token.
 */

/** `Authorization: Bearer nxd_…` — 32 random bytes, base64url. */
export const DEVICE_TOKEN = /^nxd_[A-Za-z0-9_-]{43}$/;

/** Pairing codes avoid look-alikes (0/O, 1/I/L); shown as XXXX-XXXX. */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIR_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** POST /api/pair/start {name} */
export interface PairStartResponse {
  pairId: string;
  /** Proves to /api/pair/poll that the caller started this pairing; never displayed. */
  secret: string;
  code: string;
  /** Seconds until the request expires, and between polls. */
  expiresIn: number;
  interval: number;
}

/** POST /api/pair/poll {pairId, secret}. An unknown or wrong pairing reads as `expired`. */
export type PairPollResponse = { status: 'pending' } | { status: 'denied' } | { status: 'expired' } | { status: 'approved'; token: string; device: DeviceInfo };

/** GET /api/devices/pairing/:code — what the portal shows before the user approves. */
export interface PairingRequest {
  code: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  /** Network address and browser the request came from, to spot a request that is not yours. */
  ip: string;
  userAgent: string;
}

/** Address of the portal page that approves a pairing (opened by the extension). */
export const pairPath = (code: string) => `/settings/data?pair=${encodeURIComponent(code)}`;
