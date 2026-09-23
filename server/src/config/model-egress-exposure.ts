/**
 * Effective model/media egress exposure — what the instance can actually reach, not what a flag says.
 *
 * `allowPrivateModelEndpoints is on` reports intent. It does not tell an operator whether anything is
 * *using* that permission, or which endpoint went where. Since the whole reason the flag is surfaced is
 * that it widens egress, the check has to name the exposure or it is decorative:
 *
 *     egress.privateModelEndpoints  vision → 10.1.2.3 (private); documentAssist → api.example.com (public)
 *
 * Classification is deliberately synchronous — the posture check is pure, and resolving DNS at boot would
 * make it fail on a slow resolver. An IP literal is classified exactly; a hostname is reported as such,
 * because only the resolution-time guard inside `ssrfSafeFetch` can know where it actually points.
 */
import { getConfig, getMediaEmbeddingConfig, getEmbeddingConfig } from './loader.js';
import { getDecisionModelConfig } from './decision-model.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import { allowPrivateForSlot, isLocalModelEndpoint, type EgressSlot } from './model-egress-policy.js';
import { resolveVlmEndpoint } from '../files/converters/vlm-endpoint.js';

export type EndpointClass = 'public' | 'private' | 'hostname' | 'invalid';

export interface EndpointExposure {
  /** Which provider this endpoint serves: vision, stt, embedding, documentAssist. */
  provider: string;
  /** Host as configured (never the full URL — a query string could carry a key). */
  host: string;
  klass: EndpointClass;
  /** The policy slot deciding whether THIS endpoint may resolve privately. */
  slot: EgressSlot;
  /** What that slot resolved to — per-slot setting if present, else the instance-wide flag. */
  allowsPrivate: boolean;
}

/**
 * Classify a configured endpoint without resolving it.
 *
 * Provider-agnostic despite the module name — the OIDC issuer posture check
 * (`security-posture.ts`, `oidc.issuer`) uses it too, for the same reason: reporting *which class of
 * address* a configured URL is, without a DNS round-trip at boot.
 *  - `private`  — an IP literal that only the opt-in permits (10/8, 172.16/12, 192.168/16, CGNAT, ULA…)
 *  - `public`   — passes the guard with the opt-in off
 *  - `hostname` — not an IP literal; where it points is decided at call time
 *  - `invalid`  — unparseable, or blocked even with the opt-in on (a crown jewel)
 */
export function classifyEndpoint(raw: string): { host: string; klass: EndpointClass } {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return { host: raw.slice(0, 60), klass: 'invalid' };
  }
  if (isSsrfSafeUrl(raw, false)) {
    // Passes with the opt-in OFF. A bare hostname also lands here, so separate the two: only an IP
    // literal can be called "public" on a static check.
    const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    return { host, klass: isLiteral ? 'public' : 'hostname' };
  }
  if (isSsrfSafeUrl(raw, true)) return { host, klass: 'private' }; // only the opt-in permits it
  return { host, klass: 'invalid' };                               // blocked either way — crown jewel
}

/**
 * Every EXTERNAL provider endpoint currently configured, with its classification and its own permission.
 *
 * Covers **all ten** egress slots, not the four this once listed. The omissions were not cosmetic: the
 * reranker, the contradiction judge, the external face model and the three document stages are all
 * admin-configurable egress targets, and one of them (the document VLM) turned out to be egressing with no
 * guard at all. A posture check that enumerates a subset reports "nothing else is exposed" by omission —
 * the same absence-as-evidence mistake the classifier below refuses to make about hostnames.
 */
export function modelEndpointExposure(): EndpointExposure[] {
  const out: EndpointExposure[] = [];
  const add = (provider: string, slot: EgressSlot, url: string | undefined | null) => {
    if (!url) return;
    out.push({ provider, slot, allowsPrivate: allowPrivateForSlot(slot), ...classifyEndpoint(url) });
  };

  try {
    const media = getMediaEmbeddingConfig();
    if (media.visionProvider === 'external') add('vision', 'vision', media.vision?.baseUrl);
    if (media.sttProvider === 'external') add('stt', 'stt', media.stt?.baseUrl);
    // No provider switch for these two — a reranker or judge is either the bundled sidecar or it is egress,
    // and the LOCAL-endpoint predicate is what the clients themselves branch on.
    if (media.rerank?.baseUrl && !isLocalModelEndpoint(media.rerank.baseUrl)) add('rerank', 'rerank', media.rerank.baseUrl);
    if (media.nli?.baseUrl && !isLocalModelEndpoint(media.nli.baseUrl)) add('contradictionJudge', 'nli', media.nli.baseUrl);
    // Biometric egress: face crops. External whenever configured at all.
    add('faceModel', 'faceExternal', media.faceRecognition?.externalModel?.baseUrl);
  } catch { /* pre-setup */ }

  try {
    const emb = getEmbeddingConfig();
    if (emb.provider === 'external') add('embedding', 'embedding', emb.baseUrl);
  } catch { /* pre-setup */ }

  try {
    // The document stages resolve exactly as the extractor does, including the fall back to the vision
    // endpoint when no document base URL is set — which is how page images reached an off-instance host
    // that nothing on this list mentioned.
    for (const [docSlot, provider, slot] of [
      ['vlm', 'documentVlm', 'docVlm'],
      ['repair', 'documentRepair', 'docRepair'],
      ['verify', 'documentVerify', 'docVerify'],
    ] as const) {
      const e = resolveVlmEndpoint(docSlot);
      if (e.external) add(provider, slot, e.baseUrl);
    }
  } catch { /* pre-setup */ }

  try {
    // The assist model is external by definition (F11-b) — no provider switch to check.
    add('documentAssist', 'assist', getConfig().mediaEmbedding?.documentProcessing?.assistModel?.baseUrl);
  } catch { /* pre-setup */ }

  try {
    // The decision slot has a DEFAULT base URL, so "has a URL" is not "is in use". It is in use once the
    // operator consented to a host — which is also the only state in which anything is sent there.
    const d = getDecisionModelConfig();
    if (d.acknowledgedHost) add('decisionModel', 'decision', d.baseUrl);
  } catch { /* pre-setup */ }

  return out;
}

/**
 * How each class reads in a posture line.
 *
 * `hostname` is spelled out rather than left as a bare word. On its own it looks like a fourth peer of
 * public/private/invalid — a verdict — when it is the opposite of a verdict: the check did not resolve
 * the name, so it does not know. An operator whose cluster endpoints are all DNS names would otherwise
 * read a list of `(hostname)` tags as "none of these are private", which is exactly backwards from the
 * caution the line is trying to convey.
 */
const KLASS_LABEL: Record<EndpointClass, string> = {
  public: 'public',
  private: 'private',
  hostname: 'hostname, not resolved here',
  invalid: 'invalid',
};

/** One-line summary for the posture check: `vision → 10.1.2.3 (private); stt → api.x.com (public)`. */
export function formatExposure(exposure: EndpointExposure[]): string {
  return exposure.map(e => `${e.provider} → ${e.host} (${KLASS_LABEL[e.klass]})`).join('; ');
}
