import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isAllowed, type NetPolicy } from './ip';
import { guardedLookup } from './probe';

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'network' | 'blocked' | 'timeout' | 'status' | 'too_large' | 'invalid',
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * GET + JSON against a user-configured upstream (e.g. Linkwarden) under the same network policy as
 * health checks: no loopback / metadata targets, no redirects, bounded time and size.
 */
export function getJson(url: URL, headers: Record<string, string>, policy: NetPolicy, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<unknown> {
  const { timeoutMs = 4000, maxBytes = 2 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new UpstreamError('invalid', '地址只能是 http 或 https'));
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isAllowed(literal, policy)) return reject(new UpstreamError('blocked', '目标地址不允许访问（回环、链路本地或保留地址）'));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', lookup: guardedLookup(policy), headers: { accept: 'application/json', 'user-agent': 'Nexus/1', ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new UpstreamError('too_large', '响应过大'));
        } else chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          return reject(new UpstreamError('invalid', `返回的不是 JSON（HTTP ${res.statusCode}）`, res.statusCode));
        }
        const status = res.statusCode ?? 0;
        if (status >= 300) reject(new UpstreamError('status', `HTTP ${status}`, status, body));
        else resolve(body);
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new UpstreamError('timeout', `请求超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'EBLOCKED' ? new UpstreamError('blocked', '目标地址不允许访问（回环、链路本地或保留地址）') : new UpstreamError('network', e.code === 'ECONNREFUSED' ? '连接被拒绝' : e.code === 'ENOTFOUND' ? '无法解析域名' : `连接失败（${e.code ?? e.message}）`));
    });
    req.end();
  });
}

export interface FetchedBytes {
  body: Buffer;
  type: string;
  /** Where the bytes finally came from, after redirects. */
  url: URL;
}

/**
 * GET raw bytes from a user-supplied address (remote wallpaper import). Same network policy as
 * `getJson`, re-checked on every redirect hop (at most 3), with a hard size and time limit.
 */
export function getBytes(url: URL, policy: NetPolicy, opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}, hops = 0): Promise<FetchedBytes> {
  const { timeoutMs = 15_000, maxBytes = 15 * 1024 * 1024, accept = 'image/*' } = opts;
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new UpstreamError('invalid', '地址只能是 http 或 https'));
    if (url.username || url.password) return reject(new UpstreamError('invalid', '地址中不能包含用户名或密码'));
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isAllowed(literal, policy)) return reject(new UpstreamError('blocked', '目标地址不允许访问（内网、回环或保留地址）'));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', lookup: guardedLookup(policy), headers: { accept, 'user-agent': 'Nexus/1' }, agent: false }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        if (hops >= 3) return reject(new UpstreamError('invalid', '重定向次数过多'));
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          return reject(new UpstreamError('invalid', '重定向地址无效'));
        }
        return getBytes(next, policy, opts, hops + 1).then(resolve, reject);
      }
      if (status >= 300) {
        res.resume();
        clearTimeout(timer);
        return reject(new UpstreamError('status', `HTTP ${status}`, status));
      }
      if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
        req.destroy();
        clearTimeout(timer);
        return reject(new UpstreamError('too_large', `文件超过 ${Math.round(maxBytes / 1048576)} MB`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          clearTimeout(timer);
          reject(new UpstreamError('too_large', `文件超过 ${Math.round(maxBytes / 1048576)} MB`));
        } else chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ body: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(), url });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new UpstreamError('timeout', `下载超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'EBLOCKED' ? new UpstreamError('blocked', '目标地址不允许访问（内网、回环或保留地址）') : new UpstreamError('network', e.code === 'ECONNREFUSED' ? '连接被拒绝' : e.code === 'ENOTFOUND' ? '无法解析域名' : `连接失败（${e.code ?? e.message}）`));
    });
    req.end();
  });
}
