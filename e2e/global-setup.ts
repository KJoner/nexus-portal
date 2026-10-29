import { request, type FullConfig } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Captures the fresh server's default configuration so each test can start from it. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const api = await request.newContext({ baseURL });
  await api.post('/api/auth/login', { headers: { 'X-Nexus-Client': '1' }, data: { password: 'e2e-password' } });
  const res = await api.get('/api/config');
  writeFileSync(join(import.meta.dirname, '.baseline.json'), JSON.stringify((await res.json()).config));
  await api.dispose();
}
