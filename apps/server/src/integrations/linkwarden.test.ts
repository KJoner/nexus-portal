import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db';
import { Linkwarden, LinkwardenError } from './linkwarden';
import { SecretBox } from './secret';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.test-token-3f2a';

/** Mimics Linkwarden GET /api/v1/search as implemented upstream (Bearer token, data.links / data: []). */
function fakeLinkwarden(): Promise<{ server: Server; base: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.headers.authorization} ${req.url}`);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname !== '/api/v1/search') return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ response: 'Your session has expired, please log in again.' }));
    const q = url.searchParams.get('searchQueryString') ?? '';
    res.setHeader('content-type', 'application/json');
    if (q === 'nothing') return res.end(JSON.stringify({ success: true, message: 'Nothing found.', data: [] }));
    res.end(
      JSON.stringify({
        success: true,
        message: 'Success',
        data: {
          nextCursor: null,
          links: [
            { id: 7, name: 'Rust 异步编程入门', url: 'https://rust-lang.github.io/async-book/', description: '', collection: { id: 1, name: '编程' }, tags: [] },
            { id: 8, name: '', url: 'https://example.com/a', collection: null },
            { id: 9, name: 'note without url', url: null },
            { id: 10, name: 'scripted', url: 'javascript:alert(1)' },
          ],
        },
      }),
    );
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })));
}

describe('Linkwarden integration', () => {
  let db: DB;
  let lw: Linkwarden;
  let fake: Awaited<ReturnType<typeof fakeLinkwarden>>;
  beforeEach(async () => {
    db = openDb(':memory:');
    fake = await fakeLinkwarden();
    lw = new Linkwarden(db, new SecretBox(randomBytes(32)), { allowPrivate: true, allowLoopback: true });
  });
  afterEach(() => {
    fake.server.close();
    db.close();
  });

  it('verifies the token before storing it, and stores it encrypted', async () => {
    await expect(lw.connect(fake.base, 'wrong')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(lw.status().configured).toBe(false);
    const s = await lw.connect(`${fake.base}/`, TOKEN);
    expect(s).toMatchObject({ configured: true, baseUrl: fake.base, tokenLast4: '3f2a', lastError: null });
    const row = db.prepare('select token_enc from integrations').get() as { token_enc: string };
    expect(row.token_enc).not.toContain('test-token');
  });

  it('maps search results and keeps only http(s) links', async () => {
    await lw.connect(fake.base, TOKEN);
    expect(await lw.search('rust')).toEqual([
      { id: '7', title: 'Rust 异步编程入门', url: 'https://rust-lang.github.io/async-book/', collection: '编程' },
      { id: '8', title: 'https://example.com/a', url: 'https://example.com/a', collection: undefined },
    ]);
    expect(fake.seen.at(-1)).toBe(`Bearer ${TOKEN} /api/v1/search?sort=0&searchQueryString=rust`);
    expect(await lw.search('nothing')).toEqual([]);
  });

  it('keeps the stored token when only the address is re-saved', async () => {
    await lw.connect(fake.base, TOKEN);
    expect((await lw.connect(fake.base, undefined)).tokenLast4).toBe('3f2a');
  });

  it('refuses loopback targets under the default policy', async () => {
    const strict = new Linkwarden(db, new SecretBox(randomBytes(32)), { allowPrivate: true, allowLoopback: false });
    await expect(strict.connect(fake.base, TOKEN)).rejects.toThrow(/不允许/);
    await expect(strict.connect('http://169.254.169.254', TOKEN)).rejects.toThrow(/不允许/);
  });

  it('search without a connection is a clear error', async () => {
    await expect(lw.search('x')).rejects.toEqual(new LinkwardenError('not_configured', '尚未连接 Linkwarden'));
  });
});

describe('SecretBox', () => {
  it('round-trips and detects tampering', () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal('secret');
    expect(box.open(sealed)).toBe('secret');
    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1]! ^= 1;
    expect(() => box.open(bytes.toString('base64'))).toThrow();
  });
});
