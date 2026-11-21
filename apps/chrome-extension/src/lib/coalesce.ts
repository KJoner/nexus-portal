/**
 * One run at a time — and a call made while a run is under way is not answered by that run: it may
 * already be past the point that would have seen the caller's change (a send that has read the
 * queue for the last time). The call gets one more run after the current one instead, shared by
 * everyone who asked meanwhile.
 *
 * NEX-05: the background's send (flush) was single-flight, so a save committed while a send was
 * finishing joined that send, was not in it, and stayed waiting until something else asked —
 * found by the release-package test in a real browser (e2e/extension-release.spec.ts).
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const current = run().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  };
  return () => {
    if (!running) return start();
    next ??= running
      .catch(() => undefined)
      .then(() => {
        next = null;
        // Someone may have started a run in between: it began after the change, so it is enough.
        return running ?? start();
      });
    return next;
  };
}
