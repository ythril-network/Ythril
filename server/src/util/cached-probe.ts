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
 * ## The clock and the bound
 *
 * The TTL runs from the moment the probe ANSWERED, so a probe that took three seconds is not three seconds stale when it returns.
 * The cache holds at most {@link MAX_KEYS} keys (the least recently asked is dropped): a key a caller influences must not grow it
 * for ever. The clock is injectable for a test.
 */
import { LruMap } from './lru-map.js';

const MAX_KEYS = 1_000;

interface Entry {
  /** The answer, once the probe has answered; the promise of it while it is in flight. */
  readonly answer: Promise<boolean>;
  /** When the probe answered, or `undefined` while it is in flight. */
  at: number | undefined;
}

export interface ProbeCache {
  /** The probe's answer: cached for `ttlMs` from when it answered, shared with callers that arrive while it is in flight. */
  probe(key: string, ttlMs: number, fn: () => Promise<boolean>): Promise<boolean>;
  /** Forget every key that starts with `keyPrefix`, or every key when none is given. */
  forget(keyPrefix?: string): void;
  /** How many keys are remembered. */
  readonly size: number;
}

export function createProbeCache({ now = Date.now }: { now?: () => number } = {}): ProbeCache {
  // `LruMap` cannot be walked, and a prefix forget has to: the keys are kept beside it, and leave it when the bound drops them.
  const keys = new Set<string>();
  const entries = new LruMap<string, Entry>(MAX_KEYS, (key) => { keys.delete(key); });
  const cache: ProbeCache = {
    probe(key, ttlMs, fn) {
      const hit = entries.get(key);
      if (hit && (hit.at === undefined || now() - hit.at < ttlMs)) return hit.answer;
      const entry: Entry = {
        at: undefined,
        answer: (async () => {
          try { return (await fn()) === true; } catch { return false; }
        })().then((ok) => { entry.at = now(); return ok; }),
      };
      entries.set(key, entry);
      keys.add(key);
      return entry.answer;
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
export function cachedProbe(key: string, ttlMs: number, fn: () => Promise<boolean>): Promise<boolean> {
  return shared.probe(key, ttlMs, fn);
}

/** Forget the process-wide cache's keys that start with `keyPrefix` (all of them when none is given): for tests. */
export function forgetCachedProbes(keyPrefix?: string): void {
  shared.forget(keyPrefix);
}

/** The process-wide cache itself, for a module that wants a clock of its own to be the only difference. */
export const sharedProbeCache: ProbeCache = shared;
