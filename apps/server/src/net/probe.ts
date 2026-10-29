import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isAllowed, type NetPolicy } from './ip';

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';
}

/**
 * DNS lookup that refuses disallowed addresses. Node calls it while connecting, so the address
 * that was validated is the address that gets connected to (no DNS-rebinding window).
 */
export function guardedLookup(policy: NetPolicy): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const bad = addresses.find((a) => !isAllowed(a.address, policy));
      if (bad || !addresses.length) return callback(new BlockedAddressError(`blocked ${bad?.address ?? hostname}`), '', 0);
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as LookupFunction;
}

export interface ProbeResult {
  /** An HTTP response arrived (any status). */
  reached: boolean;
  status?: number;
  latencyMs?: number;
  /** TLS chain not trusted (self-signed, expired, wrong name). */
  untrustedCert?: string;
  certDaysLeft?: number;
  errorCode?: string;
  message: string;
}

const ERRORS: Record<string, string> = {
  ECONNREFUSED: '连接被拒绝',
  ENOTFOUND: '无法解析域名',
  EAI_AGAIN: '域名解析暂时失败',
  ETIMEDOUT: '连接超时',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EBLOCKED: '目标地址不允许检查（回环、链路本地或保留地址）',
  TIMEOUT: '请求超时',
  EPROTO: 'TLS 握手失败',
};

const BODY_LIMIT = 64 * 1024;

/**
 * One GET with a hard timeout. Redirects are not followed (a redirect still proves the service
 * answers); the body is read up to 64 KB and discarded; no cookies or credentials are sent.
 */
export function probe(url: URL, policy: NetPolicy, timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return resolve({ reached: false, errorCode: 'EPROTO', message: '只支持 http 与 https' });
    // Node connects to IP literals without calling `lookup`, so they must be vetted here.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isAllowed(literal, policy)) return resolve({ reached: false, errorCode: 'EBLOCKED', message: ERRORS.EBLOCKED! });
    const started = performance.now();
    let settled = false;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const fail = (code: string) => done({ reached: false, errorCode: code, message: ERRORS[code] ?? `连接失败（${code}）` });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(policy),
        headers: { 'user-agent': 'Nexus-HealthCheck/1', accept: '*/*' },
        // Self-signed certificates are common at home: connect anyway, report trust separately.
        rejectUnauthorized: false,
        agent: false,
      },
      (res: IncomingMessage) => {
        const latencyMs = Math.round(performance.now() - started);
        const tls = res.socket as TLSSocket;
        let untrustedCert: string | undefined;
        let certDaysLeft: number | undefined;
        if (url.protocol === 'https:' && typeof tls.authorized === 'boolean') {
          if (!tls.authorized) untrustedCert = String(tls.authorizationError ?? '证书不受信任');
          const cert = tls.getPeerCertificate?.();
          if (cert?.valid_to) certDaysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
        }
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > BODY_LIMIT) res.destroy();
        });
        const finish = () => done({ reached: true, status: res.statusCode ?? 0, latencyMs, untrustedCert, certDaysLeft, message: `HTTP ${res.statusCode}` });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => fail(e.code ?? (e instanceof BlockedAddressError ? 'EBLOCKED' : 'ERROR')));
    req.end();
  });
}
