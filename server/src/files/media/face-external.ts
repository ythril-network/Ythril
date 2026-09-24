import { ssrfSafeFetch } from '../../util/ssrf.js';
import { isUsableDescriptor } from './face-descriptor.js';
import { boundedJson } from '../../util/bounded-read.js';
import { getConfig, getSecrets } from '../../config/loader.js';
import { allowPrivateForSlot } from '../../config/model-egress-policy.js';
import { log } from '../../util/log.js';
import { egressConsented } from '../../config/egress-consent.js';
import { slotTimeoutMs } from '../../config/model-slots.js';
import { getModelSlots } from '../../config/loader.js';

/** One detected face, in exactly the shape the in-process recogniser produces. */
export interface ExternalFace {
  /** FACE_DESCRIPTOR_DIMS wide. Anything else is rejected — the gallery's cosine search assumes this width. */
  embedding: number[];
  /** `[x, y, w, h]`, normalised 0–1, like `human`'s `boxRaw`. Optional: only used for the size filter. */
  boxRaw?: [number, number, number, number];
}

/** Wire shape a provider must return: `{ faces: [{ embedding, boxRaw? }] }`. */
interface ExternalFaceResponse { faces?: Array<{ embedding?: unknown; boxRaw?: unknown }> }

/**
 * Exported so `hopBudgets()` can see it. 30 s is comfortably under the 300 s stall default, but
 * `stalledJobTimeoutMs` may be set as low as 30 000 (admin schema minimum) — at which point this single call
 * is exactly the stall timeout, and a job would be re-queued in the same instant the call gave up.
 */
export const FACE_TIMEOUT_MS = 30_000;
/** A single image cannot legitimately contain more than this; caps a hostile or broken provider. */
const MAX_FACES = 64;

/** Is the external face model configured AND consented to — see `egressConsented` for why it is re-checked here. */
export function externalFaceReady(): boolean {
  return egressConsented(getConfig().mediaEmbedding?.faceRecognition?.externalModel);
}

/**
 * May a configured-but-failing external provider hand off to the bundled in-process model?
 *
 * Defaults to `false` — see `allowInProcessFallback` in the config type for why a skip beats a silent
 * substitution. Exported so the embedder asks this question in one place rather than reading config inline.
 *
 * Deliberately NOT combined with `externalFaceReady()`. They answer different questions and the caller
 * needs both separately: an instance with no external provider must keep running in-process, so the
 * fallback flag has to be irrelevant there rather than switching recognition off.
 */
export function fallbackAllowedIn(ext?: { allowInProcessFallback?: boolean }): boolean {
  // `=== true` and not a truthy read: a config hand-edited on disk can carry the STRING "false", which is
  // truthy, and would turn the operator's explicit refusal into an enable.
  return ext?.allowInProcessFallback === true;
}

/** `fallbackAllowedIn` against the live config. Split so the rule itself is testable without it. */
export function inProcessFallbackAllowed(): boolean {
  return fallbackAllowedIn(getConfig().mediaEmbedding?.faceRecognition?.externalModel);
}

/**
 * Detect + embed faces via the configured external provider.
 *
 * Returns `null` on ANY failure — unconfigured, unacknowledged, unreachable, malformed. Returning rather
 * than throwing is what lets the caller decide: an instance with no provider runs in-process, and an
 * instance whose provider failed skips the image unless `allowInProcessFallback` says otherwise. This
 * function deliberately does not know which of those applies — it reports the failure and nothing more.
 *
 * `ssrfSafeFetch` rather than `fetch`: the URL is admin-settable through the API, and a plain fetch would
 * follow a redirect into link-local metadata. Validating the URL at write time is not enough on its own —
 * DNS can change between the save and the call.
 */
export async function detectFacesExternal(imageBytes: Buffer, expectedDims: number): Promise<ExternalFace[] | null> {
  if (!externalFaceReady()) return null;
  const ext = getConfig().mediaEmbedding?.faceRecognition?.externalModel;
  const baseUrl = ext?.baseUrl?.trim();
  if (!baseUrl) return null;

  const apiKey = (getSecrets() as any)?.mediaEmbedding?.faceApiKey as string | undefined;

  try {
    const res = await ssrfSafeFetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(ext?.model ? { model: ext.model } : {}),
        image: imageBytes.toString('base64'),
      }),
      signal: AbortSignal.timeout(slotTimeoutMs('faceExternal', getModelSlots())),
    }, {
      // Matches the assist model: a self-hosted recogniser may live on a private cluster address. The
      // guard stays on — DNS-resolve, IP-pin and redirect re-validation all still apply; only the
      // private-address rejection lifts. Without this the WRITE check accepts such an endpoint and every
      // call then fails, which is a configurable feature that silently does not work.
      allowPrivate: allowPrivateForSlot('faceExternal'),
    });
    if (!res.ok) {
      // Deliberately does not say what happens next: that is the caller's decision and it depends on
      // `allowInProcessFallback`. Claiming a fallback here would be wrong on the default configuration.
      log.warn(`External face model: HTTP ${res.status} — no descriptors from this provider`);
      return null;
    }
    const body = await boundedJson<ExternalFaceResponse>(res, 'external face provider');
    const raw = Array.isArray(body?.faces) ? body.faces.slice(0, MAX_FACES) : [];

    const faces: ExternalFace[] = [];
    for (const f of raw) {
      // Exactly as many floats as the gallery's index was built with. A provider returning a different width
      // would corrupt gallery similarity scores rather than fail loudly, so the wrong shape is dropped here,
      // not downstream.
      if (!isUsableDescriptor(f?.embedding, 'external', expectedDims)) continue;
      // `isUsableDescriptor` has already established this is an array of the right LENGTH; the values are
      // still a provider's word for it, so they are checked before anything stores them.
      const emb = f.embedding as unknown[];
      if (!emb.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) continue;
      const box = f.boxRaw;
      const boxRaw = Array.isArray(box) && box.length === 4 && box.every(n => typeof n === 'number' && Number.isFinite(n))
        ? [box[0], box[1], box[2], box[3]] as [number, number, number, number]
        : undefined;
      faces.push({ embedding: f.embedding as number[], ...(boxRaw ? { boxRaw } : {}) });
    }
    return faces;
  } catch (err) {
    log.warn(`External face model unreachable (${err instanceof Error ? err.message : String(err)}) — no descriptors from this provider`);
    return null;
  }
}
