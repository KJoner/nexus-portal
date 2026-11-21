import { describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce';

/** NEX-05: the background's send runs one at a time, and nobody who asks during a run is left out. */
describe('coalesce (the background send)', () => {
  it('one run at a time; calls made during a run share exactly one more run, started after it', async () => {
    const log: string[] = [];
    const release: (() => void)[] = [];
    let n = 0;
    const run = coalesce(async () => {
      const i = ++n;
      log.push(`start ${i}`);
      await new Promise<void>((r) => release.push(r));
      log.push(`end ${i}`);
    });
    const a = run();
    const b = run();
    const c = run();
    expect(b).toBe(c);
    expect(log).toEqual(['start 1']);
    release.shift()!();
    await a;
    await vi.waitFor(() => expect(log).toEqual(['start 1', 'end 1', 'start 2']));
    release.shift()!();
    await b;
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    // Nothing under way: the next call starts at once.
    const d = run();
    expect(log.at(-1)).toBe('start 3');
    release.shift()!();
    await d;
  });

  it('a failed run is reported to its callers and does not stop the one after it', async () => {
    let n = 0;
    let release!: () => void;
    const run = coalesce(async () => {
      n++;
      if (n === 1) {
        await new Promise<void>((r) => (release = r));
        throw new Error('offline');
      }
    });
    const a = run();
    const b = run();
    release();
    await expect(a).rejects.toThrow('offline');
    await expect(b).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
});
