import { describe, expect, it } from 'vitest';
import { hashPassword } from './password';
import { passwordFromCompose } from './compose-env';

describe('password from compose config', () => {
  it('undoes the $$ escaping of compose config, as the container sees the value', () => {
    // Container env: pa$word with  and 'q' (an unset $x became empty).
    const json = JSON.stringify({ services: { nexus: { environment: { NEXUS_PASSWORD: "pa$$word with  and 'q'" } } } });
    expect(passwordFromCompose(json)).toEqual({ plain: "pa$word with  and 'q'", hasHash: false });
  });

  it('reports an existing hash and ignores empty values', async () => {
    const hash = (await hashPassword('long enough password')).replace(/\$/g, '$$$$');
    expect(passwordFromCompose(JSON.stringify({ services: { nexus: { environment: { NEXUS_PASSWORD_HASH: hash, NEXUS_PASSWORD: '' } } } }))).toEqual({ plain: null, hasHash: true });
    expect(passwordFromCompose(JSON.stringify({ services: { other: { environment: { NEXUS_PASSWORD: '  secret pass  ' } } } }))).toEqual({ plain: 'secret pass', hasHash: false });
    expect(passwordFromCompose('{}')).toEqual({ plain: null, hasHash: false });
  });
});
