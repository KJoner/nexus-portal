import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');

describe('scripts/deploy.sh', () => {
  it('knows the compose.yaml of this release, so it can tell local edits from an old version', () => {
    const sha = createHash('sha256').update(readFileSync(join(root, 'compose.yaml'))).digest('hex');
    const script = readFileSync(join(root, 'scripts/deploy.sh'), 'utf8');
    expect(script).toContain(sha);
  });
});
