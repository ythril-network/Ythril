/**
 * "Is that thing up?" — a probe whose answer is cached, which never throws, and which is asked once at a time.
 *
 * ## Why a module
 *
 * It was written for the sidecars' `/health` (`util/sidecar-health.ts`), and the housekeeping walks' "does the store answer a
 * ping" (`db/store-answers.ts`) is the second site, so it is here instead. Three things a hand-written copy drops, and each is
 * the reason a caller reaches for this and not for a `Map`:
 *
 * - **The cache.** A caller that routes per document probes per document; a walk that fails a hundred records asks the store a
 *   hundred times, each ask costing the probe's whole timeout when the thing is down. A `false` is cached like a `true`: "down"
 *   is the answer that is expensive to find out.
 * - **That it never throws.** An unreachable thing is `false`, which IS the answer. A probe that threw out of the failure path of
 *   a walk would replace the failure the walk was asked about.
 * - **One probe in flight per key.** A hundred callers arriving while the first probe waits are one probe, not a hundred.
 *
 * Only an explicit `true` from the probe is a yes: a probe that returns a truthy non-boolean is a probe that is not answering the
 * question it was written for.
 *
 * ## How long an answer lives
 *
 * A bare number is one TTL for every answer. A {@link ProbeTtl} object gives each kind its own: a yes that is revalidated rarely
 * and a no that is looked at again soon (a build that finished is noticed without anyone saying so), and a probe that FAILED (it
 * threw), which is `false` for the caller either way but need not be remembered: "the store did not answer" is not an answer
 * about the thing asked, so `failedMs: 0` forgets it at once. `failedMs` defaults to `noMs`. The TTLs are read when a key is
 * ASKED, so one entry can be asked with different TTLs.
 *
 * ## The clock and the bound
 *
 * The TTL runs from the moment the probe ANSWERED, so a probe that took three seconds is not three seconds stale when it returns.
 * The cache holds at most `maxKeys` keys (default {@link MAX_KEYS}; the least recently asked is dropped): a key a caller influences
 * must not grow it for ever. The clock is injectable for a test. A caller that already KNOWS the answer (a pass that has just
 * built the thing) says so with {@link ProbeCache.prime}, instead of leaving the next ask to find it out.
 */
import { LruMap } from './lru-map.js';

const MAX_KEYS = 1_000;

/** How long each kind of answer is reused, ms. A number is the same for all three. */
export type ProbeTtl = number | {
  /** A `true` answer. */
  readonly yesMs: number;
  /** A `false` answer. */
  readonly noMs: number;
  /** A probe that threw; defaults to `noMs`. `0` forgets it at once. */
  readonly failedMs?: number;
};

type Outcome = 'yes' | 'no' | 'failed';

const ttlFor = (ttl: ProbeTtl, outcome: Outcome): number =>
  typeof ttl === 'number' ? ttl : outcome === 'yes' ? ttl.yesMs : outcome === 'no' ? ttl.noMs : ttl.failedMs ?? ttl.noMs;

interface Entry {
  /** The answer, once the probe has answered; the promise of it while it is in flight. */
  readonly answer: Promise<boolean>;
  /** When the probe answered, or `undefined` while it is in flight. */
  at: number | undefined;
  /** What kind of answer it was, once it has answered. */
  outcome: Outcome;
}

export interface ProbeCache {
  /** The probe's answer: cached for `ttl` from when it answered, shared with callers that arrive while it is in flight. */
  probe(key: string, ttl: ProbeTtl, fn: () => Promise<boolean>): Promise<boolean>;
  /** Record an answer the caller already holds, as if the probe had just given it. */
  prime(key: string, answer: boolean): void;
  /** Forget every key that starts with `keyPrefix`, or every key when none is given. */
  forget(keyPrefix?: string): void;
  /** How many keys are remembered. */
  readonly size: number;
}

export function createProbeCache(
  { now = Date.now, maxKeys = MAX_KEYS }: { now?: () => number; maxKeys?: number } = {},
): ProbeCache {
  // `LruMap` cannot be walked, and a prefix forget has to: the keys are kept beside it, and leave it when the bound drops them.
  const keys = new Set<string>();
  const entries = new LruMap<string, Entry>(maxKeys, (key) => { keys.delete(key); });
  const cache: ProbeCache = {
    probe(key, ttl, fn) {
      const hit = entries.get(key);
      if (hit && (hit.at === undefined || now() - hit.at < ttlFor(ttl, hit.outcome))) return hit.answer;
      const entry: Entry = {
        at: undefined,
        outcome: 'failed',
        answer: (async (): Promise<Outcome> => {
          try { return (await fn()) === true ? 'yes' : 'no'; } catch { return 'failed'; }
        })().then((outcome) => { entry.outcome = outcome; entry.at = now(); return outcome === 'yes'; }),
      };
      entries.set(key, entry);
      keys.add(key);
      return entry.answer;
    },
    prime(key, answer) {
      entries.set(key, { answer: Promise.resolve(answer), at: now(), outcome: answer ? 'yes' : 'no' });
      keys.add(key);
    },
    forget(keyPrefix) {
      for (const key of [...keys]) {
        if (keyPrefix !== undefined && !key.startsWith(keyPrefix)) continue;
        entries.delete(key);
        keys.delete(key);
      }
    },
    get size() { return entries.size; },
  };
  return cache;
}

const shared = createProbeCache();

/** {@link ProbeCache.probe} on the process-wide cache and the real clock. */
export function cachedProbe(key: string, ttl: ProbeTtl, fn: () => Promise<boolean>): Promise<boolean> {
  return shared.probe(key, ttl, fn);
}

/** Forget the process-wide cache's keys that start with `keyPrefix` (all of them when none is given): for tests. */
export function forgetCachedProbes(keyPrefix?: string): void {
  shared.forget(keyPrefix);
}

/** The process-wide cache itself, for a module that wants a clock of its own to be the only difference. */
export const sharedProbeCache: ProbeCache = shared;
