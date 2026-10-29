import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * AES-256-GCM for service credentials at rest. The key comes from NEXUS_SECRET; without it a random
 * key file is created in the data directory (a database copied on its own then stays unreadable).
 */
export class SecretBox {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('secret key must be 32 bytes');
    this.key = key;
  }

  static fromEnv(secret: string | undefined, keyFile: string): { box: SecretBox; generated: boolean } {
    if (secret) return { box: new SecretBox(createHash('sha256').update(secret).digest()), generated: false };
    if (existsSync(keyFile)) return { box: new SecretBox(Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')), generated: false };
    mkdirSync(dirname(keyFile), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
    return { box: new SecretBox(key), generated: true };
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
}
