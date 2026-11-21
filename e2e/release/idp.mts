// A test identity provider over HTTP (e2e only): the repository's fakeIdp (apps/server/src/testing)
// behind a real port, so a production server process can sign two synthetic accounts in through the
// browser. The authorization endpoint signs in whoever was set with POST /test/user (no password page:
// the extension tests are about the extension, not about the identity service).
//   node --import tsx e2e/release/idp.mts <port>
import { createServer } from 'node:http';
import { fakeIdp } from '../../apps/server/src/testing/fake-idp.ts';

const port = Number(process.argv[2] ?? 39521);
const issuer = `http://127.0.0.1:${port}/realms/accounts`;
const idp = await fakeIdp({ issuer, clientId: 'nexus-web', clientSecret: 'e2e-client-secret' });
let user = { sub: 'e2e-user-a', email: 'a@e2e.example.test', name: '测试账号 A' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'POST' && url.pathname === '/test/user') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      user = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.endsWith('/protocol/openid-connect/auth')) {
      const code = idp.authorize(url, user);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname.endsWith('/protocol/openid-connect/logout')) {
      const to = url.searchParams.get('post_logout_redirect_uri');
      if (to) res.writeHead(302, { location: to }).end();
      else res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('已退出');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await idp.fetch(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`[e2e-idp] ${issuer}`));
