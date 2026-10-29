import { describe, expect, it } from 'vitest';
import { parseServer } from './server';

describe('parseServer', () => {
  it('takes the origin, adding https:// when no scheme is typed', () => {
    expect(parseServer('nexus.example.com')).toEqual({ ok: true, origin: 'https://nexus.example.com', insecure: false });
    expect(parseServer(' https://Nexus.Example.com:8443/settings?x=1 ')).toEqual({ ok: true, origin: 'https://nexus.example.com:8443', insecure: false });
  });

  it('allows plain http only for this computer and the home network, with a warning flag', () => {
    for (const a of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://192.168.1.20', 'http://10.0.0.5:8080', 'http://172.20.1.1', 'http://100.101.1.2', 'http://nexus.lan', 'http://nas', 'http://[::1]:8787']) {
      expect(parseServer(a)).toMatchObject({ ok: true, insecure: true });
    }
    for (const a of ['http://nexus.example.com', 'http://8.8.8.8', 'http://172.32.0.1']) expect(parseServer(a).ok).toBe(false);
  });

  it('refuses other schemes, credentials and garbage', () => {
    expect(parseServer('').ok).toBe(false);
    expect(parseServer('ftp://nexus.example.com').ok).toBe(false);
    expect(parseServer('javascript:alert(1)').ok).toBe(false);
    expect(parseServer('https://user:pw@nexus.example.com').ok).toBe(false);
    expect(parseServer('https://exa mple.com').ok).toBe(false);
  });
});
