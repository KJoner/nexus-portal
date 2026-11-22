import { request, type FullConfig } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Captures the fresh server's default configuration so each test can start from it. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const api = await request.newContext({ baseURL });
  await api.post('/api/auth/login', { headers: { 'X-Nexus-Client': '1' }, data: { password: 'e2e-password' } });
  const res = await api.get('/api/config');
  // The dock suites start from the five pinned sites of the self-hosted seed. (UI v2 N2's one-time
  // migration also pins the services its home page showed — covered by the unit tests; the current
  // home page still shows them in its services strip as well, until that strip goes.)
  const baseline = (await res.json()).config as { pins: string[]; apps: { id: string; kind: string }[] };
  const services = new Set(baseline.apps.filter((a) => a.kind === 'service').map((a) => a.id));
  baseline.pins = baseline.pins.filter((id) => !services.has(id));
  writeFileSync(join(import.meta.dirname, '.baseline.json'), JSON.stringify(baseline));
  await api.dispose();
}
