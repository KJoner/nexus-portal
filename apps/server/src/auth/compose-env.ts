import { isArgon2Hash } from './password';

/**
 * The access password a deployment currently uses, read from `docker compose config --format json`
 * (exactly what the container receives), for migrating a plain NEXUS_PASSWORD to a hash.
 */
export function passwordFromCompose(json: string): { plain: string | null; hasHash: boolean } {
  const config = JSON.parse(json) as { services?: Record<string, { environment?: Record<string, string | null> }> };
  const services = Object.entries(config.services ?? {});
  const raw = (services.find(([name]) => name === 'nexus') ?? services.find(([, s]) => s.environment && 'NEXUS_PASSWORD' in s.environment))?.[1].environment ?? {};
  // `compose config` writes `$` as `$$` (its output is itself valid Compose); the container sees one.
  const env = (key: string) => raw[key]?.replace(/\$\$/g, '$') ?? null;
  const hash = env('NEXUS_PASSWORD_HASH');
  // Same trimming as the server applies to NEXUS_PASSWORD, so the same password keeps working.
  return { plain: env('NEXUS_PASSWORD')?.trim() || null, hasHash: !!hash && isArgon2Hash(hash.trim()) };
}
