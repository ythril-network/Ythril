/**
 * Client for the NLP sidecar (`sidecars/doc-nlp`, `F-31`): the spans spaCy finds in a batch of turns.
 *
 * The sidecar is bundled like the other models, but can be left out (`DOC_NLP_REPLICAS=0`) or be down, so an
 * extraction checks `isNlpAvailable()` first and is refused with the setting named when it is not running,
 * rather than silently proposing nothing.
 *
 * Requests are split to stay under the sidecar's own caps (`NLP_MAX_TEXTS`, `NLP_MAX_CHARS` in its app.py),
 * so a long conversation is several calls, never a 413.
 */
import { boundedJson, boundedErrorText } from '../../util/bounded-read.js';
import { sidecarHealthy } from '../../util/sidecar-health.js';

const NLP_URL = (process.env['NLP_SIDECAR_URL'] ?? 'http://localhost:8102').replace(/\/$/, '');

/** Kept below the sidecar's defaults (256 texts, 200 000 characters) so a request never meets them. */
const BATCH_TEXTS = 128;
const BATCH_CHARS = 100_000;
/** One batch on CPU: measured at ~30 ms a turn, so a full batch is a few seconds; this is the ceiling. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface Span {
  text: string;
  start: number;
  end: number;
  kind: 'entity' | 'phrase';
  /** spaCy's entity label, for `entity` spans. A hint, never a type: the type is 4.2's judgement. */
  label?: string;
  /** The head noun of a `phrase` span (*"church"* in *"a local church"*). */
  head?: { start: number; end: number };
}

export function isNlpAvailable(): Promise<boolean> { return sidecarHealthy(NLP_URL); }

export class NlpUnavailableError extends Error {
  constructor(detail: string) {
    super(`The NLP sidecar (doc-nlp) is not available (${detail}). It is left out when DOC_NLP_REPLICAS=0, and `
      + 'NLP_SIDECAR_URL says where it is — conversation extraction needs it to find what a conversation is about.');
    this.name = 'NlpUnavailableError';
  }
}

/** The spans of every text, in order. `post` is handed in by tests. */
export async function spansOf(
  texts: string[],
  post: (url: string, body: string) => Promise<Response> = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }),
): Promise<Span[][]> {
  const out: Span[][] = [];
  for (let i = 0; i < texts.length;) {
    const batch: string[] = [];
    let chars = 0;
    while (i < texts.length && batch.length < BATCH_TEXTS && (batch.length === 0 || chars + texts[i]!.length <= BATCH_CHARS)) {
      chars += texts[i]!.length;
      batch.push(texts[i++]!);
    }
    let res: Response;
    try { res = await post(`${NLP_URL}/mentions`, JSON.stringify({ texts: batch })); }
    catch (e) { throw new NlpUnavailableError(e instanceof Error ? e.message : String(e)); }
    if (!res.ok) throw new NlpUnavailableError(`HTTP ${res.status}: ${await boundedErrorText(res)}`);
    const body = await boundedJson<{ results?: { spans?: Span[] }[] }>(res, 'NLP sidecar');
    if (!Array.isArray(body.results) || body.results.length !== batch.length) {
      throw new NlpUnavailableError(`expected ${batch.length} results, got ${body.results?.length ?? 'none'}`);
    }
    for (const r of body.results) out.push(r.spans ?? []);
  }
  return out;
}
