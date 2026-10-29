export type ServerCheck = { ok: true; origin: string; insecure: boolean } | { ok: false; error: string };

/** Loopback, private ranges (incl. Tailscale's 100.64/10) and names that only resolve at home. */
function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !h.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(h);
}

/**
 * The portal's address as typed by the user → its origin. Nexus is always served from the root of
 * its origin, so a path is ignored. HTTPS is required except for this computer and the home
 * network, where a plain-HTTP deployment is common (the user is warned).
 */
export function parseServer(input: string): ServerCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: '请输入 Nexus Portal 的地址' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: '地址格式不正确' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: '只支持 https:// 地址' };
  if (url.username || url.password) return { ok: false, error: '地址中不能包含用户名或密码' };
  if (!url.hostname) return { ok: false, error: '地址格式不正确' };
  const insecure = url.protocol === 'http:';
  if (insecure && !isLocalHost(url.hostname)) return { ok: false, error: '公网地址请使用 https://（只有本机和局域网地址允许 http://）' };
  return { ok: true, origin: url.origin, insecure };
}

/** Host-permission pattern for exactly this origin (any port is part of the origin). */
export const originPattern = (origin: string) => `${origin}/*`;
