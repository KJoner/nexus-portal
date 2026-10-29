import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Argon2id (v0.2.1) with OWASP's first recommended setting: 19 MiB, 2 passes, 1 lane, 16-byte
 * random salt. Stored and configured as a standard PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`).
 */
const ARGON2 = { memorySize: 19_456, iterations: 2, parallelism: 1, hashLength: 32 } as const;
/** Bounds for hashes coming from outside (NEXUS_PASSWORD_HASH): sane cost, nothing that can stall the server. */
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{32,}$/;

export function isArgon2Hash(value: string): boolean {
  const m = PHC.exec(value.trim());
  if (!m) return false;
  const [mem, t, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mem >= 7_168 && mem <= 262_144 && t >= 1 && t <= 10 && p >= 1 && p <= 8;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password: password.normalize('NFKC'), salt: randomBytes(16), ...ARGON2, outputType: 'encoded' });
}

function scryptKey(password: string, salt: Buffer, opts: ScryptOptions & { keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Verifies Argon2id hashes, and the `scrypt$N$r$p$salt$hash` hashes stored by v0.1–v0.2.0. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$argon2id$')) {
    if (!isArgon2Hash(stored)) return false;
    try {
      return await argon2Verify({ password: password.normalize('NFKC'), hash: stored });
    } catch {
      return false;
    }
  }
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptKey(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Older hashes are replaced after the next successful check. */
export const needsRehash = (stored: string) => !stored.startsWith('$argon2id$');
