/**
 * A stand-in for the inference host, for tests of what CALLS it (`embed()`, the brain embed worker).
 *
 * The real host is tested in its own files. Here the caller is the subject, so the host is an object the test
 * scripts: what it answers, how long it holds a request, what it reports for its backoff. It has the same
 * surface `_setLocalInferenceForTests` accepts (`request`, `warm`, `recycle`, `forgetLoadFailures`,
 * `waitOutBackoff`, `stop`, `state`), so a caller that reaches for something else fails against this the same way
 * it would against the real one.
 */
import { vectorFor } from './_fixtures/fixture-pipeline.mjs';

export function createScriptedHost() {
  const host = {
    /** Every request the code under test made, in order. */
    calls: [],
    /** Every warm() call. */
    warms: [],
    /** What `request` does. Replace it per test; it receives the request and the host. */
    behaviour: async (r) => ({
      vector: Array.from(vectorFor(r.modelId, r.input)), modelId: r.modelId, inferenceMs: 5,
    }),
    /** What `waitOutBackoff` returns. */
    backoff: () => Promise.resolve(),
    stopped: 0,

    request(r) { host.calls.push(r); return host.behaviour(r, host); },
    warm(r) { host.warms.push(r); return Promise.resolve(); },
    recycle: async () => {},
    forgetLoadFailures: () => {},
    waitOutBackoff: () => host.backoff(),
    stop: async () => { host.stopped++; },
    state: () => ({
      phase: 'none', modelId: null, pid: null, inFlight: 0, queued: 0, spawns: 0,
      consecutiveLosses: 0, backoffRemainingMs: 0, loadFailure: null,
    }),
  };
  return host;
}

/** A gate a test opens by hand: `await g.promise` in the host, `g.open()` in the test. */
export function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}
