/**
 * Is a first-party sidecar up? A cached `/health` probe, one per sidecar URL.
 *
 * Every sidecar client asks this before routing work to it: the render sidecars decide between page images and
 * OCR, and the NLP sidecar decides whether a conversation can be extracted at all. Written once in
 * `renderer.ts` and about to be written again for the NLP sidecar, so it is here instead.
 *
 * **What a copy would drop is the cache.** Without it, a caller routing per document probes `/health` per
 * document, and a sidecar under load answers slower still. The probe also never throws: an unreachable
 * sidecar is `false`, which is the answer, not an error.
 *
 * A plain `fetch`, not the SSRF-guarded one: these URLs come from compose, not from an operator's model
 * settings.
 */
const TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

const cache = new Map<string, { at: number; ok: boolean }>();

export async function sidecarHealthy(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(baseUrl);
  if (hit && now - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    ok = (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok;
  } catch {
    ok = false;
  }
  cache.set(baseUrl, { at: now, ok });
  return ok;
}

/** Forget every cached probe (tests). */
export function resetSidecarHealth(): void { cache.clear(); }
