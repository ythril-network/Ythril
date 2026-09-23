/**
 * Model/media egress policy — where the **external** provider endpoints are allowed to live.
 *
 * The provider shapes encode a PROTOCOL, not a trust level: `local` speaks Ollama's wire protocol,
 * `external` speaks OpenAI's. That left one real deployment with no usable shape at all — a self-hosted
 * OpenAI-compatible server (llama.cpp `llama-server`, vLLM, LocalAI) on a private cluster address:
 * `local` speaks a protocol it does not implement, and `external` rejected the address on save.
 *
 * `allowPrivateModelEndpoints` closes that. It is deliberately NOT "turn the guard off":
 * `ssrfSafeFetch` still DNS-resolves, pins the resolved IP for the connection and re-validates every
 * redirect — only the private-address rejection relaxes. A declared-private external endpoint therefore
 * ends up better protected than a `local` provider, which uses a plain `fetch` with no guard at all.
 *
 * Env override → config key → safe default, matching `allowPrivatePeers` / `trustProxy` precedence.
 * It is read here rather than passed through the media-config API on purpose: a field that turns into an
 * egress target must never be widenable from the admin surface.
 */
import { getConfig } from './loader.js';

/**
 * True when external provider endpoints may resolve to private/reserved addresses
 * (env `YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS` → config `allowPrivateModelEndpoints` → false).
 */
export function allowPrivateModelEndpoints(): boolean {
  if (process.env['YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS'] === 'true') return true;
  try {
    return getConfig().allowPrivateModelEndpoints === true;
  } catch {
    return false; // config not loaded yet (first run) — stay closed
  }
}

/**
 * The model slots that can become egress targets, each settable on its own.
 *
 * Keyed by slot rather than by URL, because the same host can legitimately hold several of them and the
 * question "may THIS endpoint reach a private address" is per-endpoint.
 */
/*
 * The slot vocabulary moved to `config/model-slots.ts` and is re-exported here unchanged.
 *
 * That module is a leaf — it imports nothing — because the per-slot call budgets are read from the loader, the
 * media providers and two brain clients, several of which this file's own importers already pull in. Owning
 * the list here and importing it there would close a runtime import cycle. Re-exporting keeps all fourteen
 * existing `EgressSlot` import sites working and, more importantly, means the egress policy and the budget
 * table cannot come to describe different sets of slots.
 */
import { MODEL_SLOTS } from './model-slots.js';
import type { ModelSlot } from './model-slots.js';
export const EGRESS_SLOTS = MODEL_SLOTS;
export type EgressSlot = ModelSlot;

/**
 * The env var pinning each slot. Written out rather than derived from the slot name.
 *
 * Deriving it (`YTHRIL_ALLOW_PRIVATE_${snake(slot)}`) is shorter and worse: the names then exist nowhere
 * in the source, so `grep YTHRIL_ALLOW_PRIVATE_DOC_VLM` finds nothing, and the doc-coverage gate — which
 * looks for exactly that — cannot tell a documented setting from a phantom one. Ten literals is the price
 * of a setting an operator can actually search for.
 */
export const SLOT_ENV_VARS = {
  vision: 'YTHRIL_ALLOW_PRIVATE_VISION',
  stt: 'YTHRIL_ALLOW_PRIVATE_STT',
  embedding: 'YTHRIL_ALLOW_PRIVATE_EMBEDDING',
  rerank: 'YTHRIL_ALLOW_PRIVATE_RERANK',
  nli: 'YTHRIL_ALLOW_PRIVATE_NLI',
  assist: 'YTHRIL_ALLOW_PRIVATE_ASSIST',
  docVlm: 'YTHRIL_ALLOW_PRIVATE_DOC_VLM',
  docRepair: 'YTHRIL_ALLOW_PRIVATE_DOC_REPAIR',
  docVerify: 'YTHRIL_ALLOW_PRIVATE_DOC_VERIFY',
  faceExternal: 'YTHRIL_ALLOW_PRIVATE_FACE_EXTERNAL',
  decision: 'YTHRIL_ALLOW_PRIVATE_DECISION',
} as const satisfies Record<EgressSlot, string>;

/** The env var pinning one slot's permission. */
export function slotEnvVar(slot: EgressSlot): string {
  return SLOT_ENV_VARS[slot];
}

/**
 * The "here is how to allow this" tail for a rejected private URL — empty when the slot ALREADY allows
 * private addresses, because then the rejection is a crown-jewel one and no setting will lift it. Telling
 * an operator to enable a flag that is already on is how a support round-trip starts.
 *
 * Exported next to the resolver on purpose: the message names the exact knob the resolver reads, and the
 * two drifting apart is what turns a correct guard into an unactionable error.
 */
export function privateAddressHint(slot: EgressSlot): string {
  if (allowPrivateForSlot(slot)) return '';
  return ` (set allowPrivateModelEndpointsBySlot.${slot}, ${slotEnvVar(slot)}=true, or the instance-wide`
    + ' allowPrivateModelEndpoints, to permit a self-hosted endpoint on a private address — loopback and'
    + ' cloud-metadata addresses stay blocked regardless)';
}

/**
 * May THIS endpoint resolve to a private address?
 *
 * Per-slot **overrides** the global flag in both directions, which is the whole point. The global
 * `allowPrivateModelEndpoints` is all-or-nothing, so an operator running everything on their own infra
 * except one genuinely external model had to enable it globally — loosening the guard on precisely the
 * endpoint where a private-address resolution is a red flag rather than a convenience. Per-slot is
 * least-privilege: `YTHRIL_ALLOW_PRIVATE_ASSIST=false` keeps that one strict while the internal ones stay
 * reachable.
 *
 * Precedence: **per-slot (if set, wins) → global → closed.** A per-slot `false` beating a global `true`
 * is not an edge case; it is the case this exists for.
 *
 * Env or config, never the admin API — same reason the global flag is read here rather than passed
 * through media-config: a field that turns into an egress target must not be widenable from the admin
 * surface. And no setting here reaches the crown-jewel ranges: loopback, link-local / cloud metadata and
 * the unspecified address stay blocked in `ssrfSafeFetch` whatever this returns.
 */
export function allowPrivateForSlot(slot: EgressSlot): boolean {
  const env = process.env[SLOT_ENV_VARS[slot]];
  if (env === 'true') return true;
  if (env === 'false') return false;
  try {
    const perSlot = getConfig().allowPrivateModelEndpointsBySlot?.[slot];
    if (typeof perSlot === 'boolean') return perSlot;
  } catch { /* config not loaded yet — fall through to the global, which is closed by default */ }
  return allowPrivateModelEndpoints();
}

/** Slots whose setting differs from the global flag — what the posture must report instead of one boolean. */
export function egressSlotOverrides(): Array<{ slot: EgressSlot; allowPrivate: boolean }> {
  const globalAllows = allowPrivateModelEndpoints();
  return EGRESS_SLOTS
    .map(slot => ({ slot, allowPrivate: allowPrivateForSlot(slot) }))
    .filter(s => s.allowPrivate !== globalAllows);
}

/**
 * True for a bundled/sidecar endpoint — loopback or a bare hostname with no dot, i.e. a compose or
 * cluster service name. Those get a plain `fetch`; anything else is egress and goes through
 * `ssrfSafeFetch`.
 *
 * Lives here rather than in one client because more than one provider needs the same rule, and two
 * copies of a security predicate is how they drift. Deliberately conservative: an unparseable URL is
 * NOT local, so a malformed endpoint gets the guard rather than the bare fetch.
 */
export function isLocalModelEndpoint(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || !h.includes('.');
  } catch {
    return false;
  }
}
