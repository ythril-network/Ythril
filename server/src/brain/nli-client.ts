/**
 * NLI (natural-language-inference) client — the contradiction judge's model call (F-REVIEW).
 *
 * Classifies a premise/hypothesis pair as `entailment` | `neutral` | `contradiction`. The model is an
 * encoder classifier (roberta/deberta-MNLI class), served either by a local sidecar or an external
 * endpoint, configured exactly like the vision and STT providers.
 *
 * **Why this is not an embedding comparison.** Similarity is not contradiction. "The service runs on
 * port 8080" and "The service does not run on port 8080" are about as embedding-similar as two sentences
 * get — opposite claims share subject, vocabulary and structure, so cosine distance ranks them as a near
 * duplicate. Embeddings are the right tool for finding the candidate PAIR; only an entailment model can
 * say whether the pair agrees or disagrees.
 *
 * **Egress.** Record text is document content. When the endpoint is not local it goes through
 * `ssrfSafeFetch` with the same private-address policy as every other model call, so a misconfigured or
 * attacker-supplied endpoint cannot be used to reach cluster-internal services.
 */
import { getModelSlots, getMediaEmbeddingConfig } from '../config/loader.js';
import { boundedJson } from '../util/bounded-read.js';
import { allowPrivateForSlot, isLocalModelEndpoint as isLocalEndpoint } from '../config/model-egress-policy.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { log } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { slotTimeoutMs } from '../config/model-slots.js';

export type NliLabel = 'entailment' | 'neutral' | 'contradiction';

export interface NliVerdict {
  label: NliLabel;
  /** Confidence for `label`, 0..1. Callers gate on this — a low-confidence contradiction is noise. */
  score: number;
}

/** True when an NLI endpoint AND model are both configured. Without both there is nothing to call. */
export function nliConfigured(): boolean {
  const nli = getMediaEmbeddingConfig().nli;
  return !!nli?.baseUrl?.trim() && !!nli?.model?.trim();
}

/**
 * True when the configured judge runs locally — i.e. judging a pair costs CPU but sends nothing anywhere.
 *
 * Callers use this to decide how *freely* they may judge. The distinction is not speed: an MNLI encoder is
 * a single forward pass either way. It is that every judged pair on a remote endpoint is document content
 * leaving the instance, and that cost does not shrink with a faster model or a bigger machine.
 *
 * Unconfigured counts as NOT local: there is nothing to call, so nothing may be assumed cheap.
 */
export function nliIsLocal(): boolean {
  const url = getMediaEmbeddingConfig().nli?.baseUrl?.trim();
  return !!url && isLocalEndpoint(url);
}

// Loopback/sidecar hosts are the bundled service; anything else is egress and gets the SSRF guard.
// The predicate now lives in model-egress-policy.ts — the reranker needs the same rule, and two copies
// of a security predicate is how they drift.

/** Normalise whatever shape the server returned into a verdict, or null when it is unreadable. */
/**
 * Warn once per distinct unrecognised label.
 *
 * Once per label, not once per call: a wrong-shaped model produces one of these for every pair in a sweep,
 * and a thousand identical lines say nothing the first one did not while burying everything else.
 */
const labelWarnings = warnOnce<string>();
function logUnknownLabel(rawLabel: string): void {
  const key = rawLabel || '<missing>';
  labelWarnings(key, () => log.warn(
    `NLI judge returned the label '${key}', which is not one of entailment / neutral / contradiction ` +
    '(or LABEL_0..2). The contradiction scanner will treat every pair as unjudged, which looks identical ' +
    'to an unreachable endpoint. The most common cause is a 2-class head such as a zeroshot/NLI model ' +
    "emitting 'not_entailment' — this feature needs a 3-class MNLI head.",
  ));
}

/** Exported for the tests: the pure label decision, which is where the wrong-shape trap lives. */
export function parseVerdict(body: unknown): NliVerdict | null {
  // Two shapes are common: {label, score} and HF-style [{label, score}, …] sorted by score.
  const first = Array.isArray(body) ? (Array.isArray(body[0]) ? body[0][0] : body[0]) : body;
  if (!first || typeof first !== 'object') return null;
  const rec = first as Record<string, unknown>;
  const rawLabel = typeof rec['label'] === 'string' ? rec['label'].toLowerCase() : '';
  const score = typeof rec['score'] === 'number' ? rec['score'] : Number.NaN;
  if (!Number.isFinite(score)) return null;
  // MNLI heads label these several ways: entailment/neutral/contradiction, ENTAILMENT, or LABEL_0..2
  // (0=contradiction, 1=neutral, 2=entailment in the standard MNLI ordering).
  const map: Record<string, NliLabel> = {
    entailment: 'entailment', neutral: 'neutral', contradiction: 'contradiction',
    label_0: 'contradiction', label_1: 'neutral', label_2: 'entailment',
  };
  const label = map[rawLabel];
  if (!label) {
    // Say WHICH label was not understood. Returning a bare null here made a wrong-shaped model
    // indistinguishable from an unreachable one: a 2-class head ({0: entailment, 1: not_entailment}) emits
    // `not_entailment`, which maps to nothing, so the scanner recorded `judge-unavailable` and parked its
    // cursor exactly as it would for a dead endpoint. A reporter lost a rebuild to that silence.
    //
    // Still null, and still fail-open: this changes what the operator can SEE, not what the caller gets.
    logUnknownLabel(rawLabel);
    return null;
  }
  return { label, score };
}

/**
 * Classify a premise/hypothesis pair.
 *
 * Returns null — never throws and never guesses — when the judge cannot answer: no endpoint configured,
 * the call failed, or the response was unreadable. A null must be treated as "no verdict", not as
 * "no contradiction": silently downgrading an unreachable judge to "these records agree" would quietly
 * empty the review queue and look exactly like a clean instance.
 */
export async function classify(premise: string, hypothesis: string): Promise<NliVerdict | null> {
  const nli = getMediaEmbeddingConfig().nli;
  if (!nliConfigured() || !nli?.baseUrl || !nli.model) return null;

  const url = `${nli.baseUrl.replace(/\/+$/, '')}/classify`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(nli.apiKey ? { authorization: `Bearer ${nli.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: nli.model, premise, hypothesis }),
    signal: AbortSignal.timeout(slotTimeoutMs('nli', getModelSlots())),
  };

  try {
    const res = isLocalEndpoint(nli.baseUrl)
      ? await fetch(url, init)
      : await ssrfSafeFetch(url, init, { allowPrivate: allowPrivateForSlot('nli') });
    if (!res.ok) {
      log.warn(`NLI classify: ${res.status} from the judge endpoint — treating as no verdict`);
      return null;
    }
    return parseVerdict(await boundedJson(res, 'NLI'));
  } catch (err) {
    // Deliberately does not include the pair text: it is record content, and this line goes to the log.
    log.warn(`NLI classify failed — treating as no verdict: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
