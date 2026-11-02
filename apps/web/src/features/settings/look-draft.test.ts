import { defaultConfig, type Settings } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { lookDiff, lookPatch } from './look-draft';

const applied = (): Settings['look'] => defaultConfig().settings.look;

describe('look draft', () => {
  it('carries only what the draft edits', () => {
    const before = applied();
    const draft = { ...before, tone: 'original' as const, rotation: { ...before.rotation, mode: 'potd' as const } };
    expect(lookDiff(draft, before)).toBe(2);
    expect(lookPatch(draft, before)).toEqual({ tone: 'original', rotation: draft.rotation });
  });

  it('a favorite added while a draft is open survives applying the draft', () => {
    const draft = { ...applied(), tone: 'original' as const };
    const now = { ...applied(), favorites: ['up-kept0000000'] };
    expect(lookPatch(draft, now)).toEqual({ tone: 'original' });
  });
});
