import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function derive(password: string, salt: Buffer, opts: ScryptOptions & { keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
