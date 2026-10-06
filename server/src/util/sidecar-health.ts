/**
 * Is a first-party sidecar up? A cached `/health` probe, one per sidecar URL.
 *
 * Every sidecar client asks this before routing work to it: the render sidecars decide between page images and
 * OCR, and the NLP sidecar decides whether a conversation can be extracted at all. Written once in
 * `renderer.ts` and about to be written again for the NLP sidecar, so it is here instead.
 *
 * **What a copy would drop is the cache.** Without it, a caller routing per document probes `/health` per
 * document, and a sidecar under load answers slower still. The probe also never throws: an unreachable
 * sidecar is `false`, which is the answer, not an error. Both live in `util/cached-probe.ts`, which this and the
 * housekeeping walks' "does the store answer" (`db/store-answers.ts`) share.
 *
 * A plain `fetch`, not the SSRF-guarded one: these URLs come from compose, not from an operator's model
 * settings.
 */
import { cachedProbe, forgetCachedProbes } from './cached-probe.js';

const TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
/** The prefix of this module's keys in the shared probe cache, so forgetting them leaves other probes' answers alone. */
const KEY_PREFIX = 'sidecar:';

export function sidecarHealthy(baseUrl: string): Promise<boolean> {
  return cachedProbe(`${KEY_PREFIX}${baseUrl}`, TTL_MS, async () =>
    (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok);
}

/** Forget every cached sidecar probe (tests). */
export function resetSidecarHealth(): void { forgetCachedProbes(KEY_PREFIX); }
