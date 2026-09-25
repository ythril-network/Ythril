/**
 * The admin patch for the assist model's budget and fallback (`F-33`): what the body may say, when the fallback is
 * refused, and how the two fields merge into the stored block.
 *
 * ## Absent keeps, `null` removes — unlike the rest of the block
 *
 * The other assist fields are replaced WHOLE by every patch, which works because the Models card always sends them
 * all. Two NEW fields cannot rely on that: a client written before them never sends them, and under the whole-block
 * rule its next save would silently delete a budget the operator set — the one control that caps spending on a paid
 * model. So here an omitted field keeps what is stored, and only an explicit `null` removes it.
 *
 * ## The fallback is egress like the primary, unless it is local
 *
 * A fallback on loopback or a bare service name sends nothing off the instance and needs neither the public-URL rule
 * nor a consent. Any other URL gets both checks the primary gets, so a fallback cannot become the unconsented way out.
 * Its API key never reaches config.json; it goes to secrets as `docAssistFallbackApiKey`.
 */
import { z } from 'zod';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import { isLocalModelEndpoint, allowPrivateForSlot, privateAddressHint } from './model-egress-policy.js';
import { refuseUnacknowledgedEgress } from './egress-consent.js';

/** `tokens` over a rolling `perHours` (1 hour to 30 days); `null` removes it. */
export const AssistBudgetPatch = z.object({
  tokens: z.number().int().min(1).max(1_000_000_000_000),
  perHours: z.number().min(1).max(720),
}).strict().optional().nullable();

/** The endpoint that answers when the primary may not; `null` removes it. */
export const AssistFallbackPatch = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().max(128).optional(),
  apiKey: z.string().max(512).optional().nullable(),
  acknowledgedHost: z.string().max(255).optional().nullable(),
  acknowledgedHostForConversations: z.string().max(255).optional().nullable(),
}).strict().optional().nullable();

type FallbackPatch = z.infer<typeof AssistFallbackPatch>;

/**
 * Why this fallback is refused, or null. `repairReachable`: whether document repair can run after this patch, the
 * use that sends document content — the same condition the primary's consent check is asked under.
 */
export function refuseAssistFallback(fb: FallbackPatch, repairReachable: boolean): { status: number; body: unknown } | null {
  const url = fb?.baseUrl;
  if (!url || isLocalModelEndpoint(url)) return null;
  if (!isSsrfSafeUrl(url, allowPrivateForSlot('assist'))) {
    return { status: 400, body: { error: 'assistModel.fallback.baseUrl rejected: must be a public http(s) URL, or a local one (loopback or a bare service name)' + privateAddressHint('assist') } };
  }
  return refuseUnacknowledgedEgress({
    what: 'external assist model fallback',
    sends: 'document content (OCR text, and page images for image-based uses)',
    effBaseUrl: url, effAck: fb?.acknowledgedHost ?? undefined,
    reachableAfterThisPatch: repairReachable, causedByThisPatch: true,
  });
}

/** The fallback key change for secrets: `undefined` keeps it, `null` removes it, a string sets it. */
export function assistFallbackKeyChange(patch: { fallback?: FallbackPatch } | undefined): string | null | undefined {
  if (!patch || !('fallback' in patch)) return undefined;
  if (patch.fallback === null) return null;
  return patch.fallback && 'apiKey' in patch.fallback ? patch.fallback.apiKey ?? null : undefined;
}

/**
 * Put the budget and the fallback into `next`, the assist block about to be stored: absent keeps `stored`'s value,
 * `null` removes it, and the fallback's key and its unset consents never reach config.json.
 */
export function mergeAssistExtras(next: Record<string, unknown>, stored: Record<string, unknown> | undefined): void {
  for (const key of ['budget', 'fallback'] as const) {
    if (!(key in next)) { if (stored?.[key] !== undefined) next[key] = stored[key]; continue; }
    if (next[key] === null) { delete next[key]; continue; }
  }
  if (next['fallback'] && typeof next['fallback'] === 'object') {
    const fb = { ...(next['fallback'] as Record<string, unknown>) };
    delete fb['apiKey'];
    for (const k of ['acknowledgedHost', 'acknowledgedHostForConversations']) if (fb[k] == null) delete fb[k];
    next['fallback'] = fb;
  }
}
