import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { newAppId, validateApp, validateEngine } from './validate';

const c = defaultConfig();
const litebox = c.apps.find((a) => a.id === 'litebox')!;

describe('validateApp', () => {
  it('requires a full http(s) address', () => {
    expect(validateApp({ ...litebox, url: 'jellyfin.home' }, c.apps).errors.url).toBe('请输入完整网址，以 http:// 或 https:// 开头');
  });
  it('needs a LAN address when LAN is the default', () => {
    expect(validateApp({ ...litebox, prefer: 'lan', lanUrl: '' }, c.apps).errors.lanUrl).toBeDefined();
  });
  it('keeps health checks on the app’s own hosts', () => {
    const d = { ...litebox, lanUrl: 'http://192.168.1.10:8008', health: { enabled: true, target: 'http://169.254.169.254/latest', intervalSec: 60 as const } };
    expect(validateApp(d, c.apps).errors.health).toBe('检查地址必须与外网或内网地址同一主机');
    expect(validateApp({ ...d, health: { ...d.health, target: 'http://192.168.1.10:8008/api/status' } }, c.apps).ok).toBe(true);
    expect(validateApp({ ...d, health: { ...d.health, target: '/healthz' } }, c.apps).ok).toBe(true);
  });
  it('warns, but allows, a duplicate address', () => {
    const gh = c.apps.find((a) => a.id === 'github')!;
    const v = validateApp({ ...gh, id: 'gh2' }, c.apps);
    expect(v.ok).toBe(true);
    expect(v.warnings.url).toContain('GitHub');
  });
});

describe('validateEngine', () => {
  it('needs %s and a unique prefix', () => {
    expect(validateEngine({ id: 'x', name: 'MDN', urlTemplate: 'https://developer.mozilla.org/search?q=', prefix: '' }, c.engines).errors.url).toContain('%s');
    expect(validateEngine({ id: 'x', name: 'MDN', urlTemplate: 'https://developer.mozilla.org/search?q=%s', prefix: 'g' }, c.engines).errors.prefix).toContain('Google');
  });
});

it('newAppId avoids collisions', () => {
  expect(newAppId('GitHub', c.apps)).toBe('github-2');
  expect(newAppId('哔哩', c.apps)).toBe('app');
});
