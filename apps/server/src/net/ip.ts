import { isIP } from 'node:net';

export type IpClass = 'public' | 'private' | 'loopback' | 'linklocal' | 'unspecified' | 'multicast' | 'reserved';

function v4(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function classifyV4([a, b]: number[]): IpClass {
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'linklocal'; // includes cloud metadata 169.254.169.254
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b! >= 64 && b! <= 127) return 'private'; // CGNAT — Tailscale / carrier NAT
  // Benchmarking range, used as "fake IPs" by local proxies (Clash / Mihomo / Surge TUN): every
  // public name resolves here and the proxy makes the real connection. Nothing sensitive lives here.
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  if (a! >= 224 && a! <= 239) return 'multicast';
  if (a! >= 240 || (a === 192 && b === 0)) return 'reserved';
  return 'public';
}

/** Expands an IPv6 address to 8 hextets; returns null when malformed. */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = v4(tail[1]!);
    if (!p) return null;
    s = s.slice(0, -tail[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  if (s.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : null;
  const parts = r ? [...h, ...Array(8 - h.length - r.length).fill('0'), ...r] : h;
  if (parts.length !== 8) return null;
  const nums = parts.map((x) => parseInt(x, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

export function classifyIp(ip: string): IpClass {
  const kind = isIP(ip);
  if (kind === 4) return classifyV4(v4(ip)!);
  if (kind !== 6) return 'reserved';
  const h = hextets(ip);
  if (!h) return 'reserved';
  const zeroPrefix = h.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address: judge that.
  if ((zeroPrefix && h[5] === 0xffff) || (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0))) {
    return classifyV4([h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]);
  }
  if (h.every((x) => x === 0)) return 'unspecified';
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'loopback';
  if ((h[0]! & 0xffc0) === 0xfe80) return 'linklocal';
  if ((h[0]! & 0xff00) === 0xff00) return 'multicast';
  // AWS IPv6 instance metadata lives inside the ULA range: always refuse it.
  if (h[0] === 0xfd00 && h[1] === 0x0ec2) return 'linklocal';
  if ((h[0]! & 0xfe00) === 0xfc00) return 'private';
  if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0) return 'private'; // 2001:2::/48 benchmarking, fake-IP proxies
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'reserved';
  return 'public';
}

export interface NetPolicy {
  /** LAN / Tailscale addresses — the usual home of self-hosted services. */
  allowPrivate: boolean;
  /** 127.0.0.1 / ::1 — off by default so checks cannot reach Nexus itself or local admin ports. */
  allowLoopback: boolean;
}

export function isAllowed(ip: string, policy: NetPolicy): boolean {
  const c = classifyIp(ip);
  return c === 'public' || (c === 'private' && policy.allowPrivate) || (c === 'loopback' && policy.allowLoopback);
}
