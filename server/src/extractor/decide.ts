/**
 * The extractors' decision client (`F-31`, `conversation/DECOMPOSITION.md` → "How every jev step is asked").
 *
 * Every judgement an extractor cannot make in code — *which of these people is "she"*, *is this turn pasted
 * material*, *which of these existing records is this claim* — is asked here, as a typed question over a
 * state, and answered in ONE shape whichever model answered it. The shape is TypeSafe's System One contract
 * (docs.typesafe.ai/api.md), because that is what the steps are written against:
 *
 *   noul    the probability a condition holds, 0…1
 *   choice  one option of a set the CALLER lists — select, never generate
 *   score   a position on levels the caller describes, 0…levels-1
 *
 * ## Two backends, one contract
 *
 * Owner, 2026-09-23: *"the jev endpoint is configurable model right? also as fallback this has to be handled
 * with the assistant llm"*.
 *
 *  - **`jev`** — the `decisionModel` slot. Sent the request verbatim; answers carry the full distribution.
 *  - **`assist`** — `documentProcessing.assistModel` (F11-b), asked the same questions as an OpenAI chat call
 *    whose JSON schema only admits the listed options. It returns a pick, not a distribution, so its
 *    `probabilities` and `confidence` are `null` — a threshold written against a real distribution must not
 *    be fed an invented one.
 *
 * Neither consented to → `DecisionUnavailableError`, naming both settings. An extraction without a judge is
 * refused before it starts, never guessed.
 *
 * ## Software governs
 *
 * **Every answer is checked against its question by code before anything reads it**, from either backend: a
 * choice outside the criteria, a number outside its range, a missing answer — each becomes `invalid` with the
 * reason and a `null` value. Not a throw: one bad answer in a batch of twenty is one step to escalate, not
 * twenty to redo. And every `choice` must list a no-match option (`NO_MATCH_OPTIONS`) or it is refused before
 * it is sent — a question with no way to say "none of these" forces a wrong pick, which is the failure the
 * decomposition's own gate exists to stop.
 */
import { egressConsented, assistConsented } from '../config/egress-consent.js';
import { allowPrivateForSlot, type EgressSlot } from '../config/model-egress-policy.js';
import { slotTimeoutMs } from '../config/model-slots.js';
import { getDocumentProcessingConfig, getDocAssistApiKey, getModelSlots } from '../config/loader.js';
import { getDecisionModelConfig, getDecisionApiKey } from '../config/decision-model.js';
import { chatUrlFor, systemOneUrlFor } from '../files/converters/vlm-endpoint.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { boundedJson } from '../util/bounded-read.js';
import { postWithBackoff, type ModelTransport } from './model-post.js';

/** An instruction or a criterion: TypeSafe accepts a string, an object or an array, and so do we. */
type Rubric = string | Record<string, unknown> | unknown[];

export type Question =
  | { type: 'noul'; instructions: Rubric; criteria?: { true?: Rubric; false?: Rubric } }
  | { type: 'choice'; instructions: Rubric; criteria: Record<string, Rubric | null> }
  | { type: 'score'; instructions: Rubric; criteria: Rubric[] };

/** Why an answer was refused. Present only on a refused answer, whose value is then `null`. */
interface Refusable { invalid?: string }
export type Answer =
  | ({ type: 'noul'; noul: number | null } & Refusable)
  | ({ type: 'choice'; choice: string | null; probabilities: Record<string, number> | null; confidence: number | null } & Refusable)
  | ({ type: 'score'; score: number | null; legend: Record<string, string>; probabilities: Record<string, number> | null; confidence: number | null } & Refusable);

export interface Decision {
  /** Which backend answered — recorded with the run, because the two are not equally calibrated. */
  backend: 'jev' | 'assist';
  /** The model the backend REPORTS having used (`jev-1.13.0`), else the one requested. */
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface DecisionBackend {
  kind: 'jev' | 'assist';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/**
 * Option keys that mean "none of these". Every `choice` must carry one. The same vocabulary the
 * decomposition's gate requires of every choice STEP (`the-extractor-decomposition-counts-itself.test.js`).
 */
export const NO_MATCH_OPTIONS = ['none', 'new', 'neither', 'unclear'] as const;

/** No backend is consented to. The message is the operator's instruction, so it names both settings. */
export class DecisionUnavailableError extends Error {
  constructor() {
    super('No decision model is available: configure `decisionModel` (a System One endpoint, TypeSafe by default) '
      + 'and acknowledge its host, or consent `documentProcessing.assistModel` for conversations — extraction sends '
      + 'conversation text there.');
    this.name = 'DecisionUnavailableError';
  }
}

/** A request that failed as a whole. `status` is the backend's HTTP status when there was one. */
export class DecisionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'DecisionError';
  }
}

type SlotInput = { baseUrl?: string; model?: string; acknowledgedHost?: string; acknowledgedHostForConversations?: string; apiKey?: string } | undefined;

/**
 * Which backend answers, from the two slots as configured. Pure, so the choice is testable without a config.
 * The decision slot first; the assist model only when the decision slot is not consented to.
 */
export function pickDecisionBackend(slots: { decision?: SlotInput; assist?: SlotInput }): DecisionBackend | null {
  const { decision, assist } = slots;
  if (decision?.baseUrl && decision.model && egressConsented(decision)) {
    return { kind: 'jev', baseUrl: decision.baseUrl, model: decision.model, ...(decision.apiKey ? { apiKey: decision.apiKey } : {}) };
  }
  // The assist model answers only under its CONVERSATIONS consent: the questions carry conversation turns.
  if (assist?.baseUrl && assist.model && assistConsented(assist, 'conversations')) {
    return { kind: 'assist', baseUrl: assist.baseUrl, model: assist.model, ...(assist.apiKey ? { apiKey: assist.apiKey } : {}) };
  }
  return null;
}

/** The backend this instance would use now, or `DecisionUnavailableError`. */
export function decisionBackend(): DecisionBackend {
  const assist = getDocumentProcessingConfig().assistModel;
  const b = pickDecisionBackend({
    decision: { ...getDecisionModelConfig(), apiKey: getDecisionApiKey() },
    assist: assist && { ...assist, apiKey: getDocAssistApiKey() },
  });
  if (!b) throw new DecisionUnavailableError();
  return b;
}

/** How the request travels — the shared shape, so both extractor model clients are driven the same way in tests. */
export type DecideTransport = ModelTransport;

/**
 * Ask `questions` about `state`, and get one checked answer per question.
 *
 * Throws `DecisionError` only when the request as a whole failed — refused (4xx), still overloaded after the
 * retries, or unreadable. A single bad answer inside a good reply is marked `invalid` instead.
 */
export async function decide(
  backend: DecisionBackend,
  state: unknown,
  questions: Record<string, Question>,
  transport: DecideTransport = {},
): Promise<Decision> {
  refuseQuestionsWithoutNoMatch(questions);
  const slot: EgressSlot = backend.kind === 'jev' ? 'decision' : 'assist';
  const post = transport.post ?? ((url, init) => ssrfSafeFetch(url,
    { ...init, signal: AbortSignal.timeout(slotTimeoutMs(slot, getModelSlots())) },
    { allowPrivate: allowPrivateForSlot(slot) }));
  const sleep = transport.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  const request = backend.kind === 'jev'
    ? { url: systemOneUrlFor(backend.baseUrl), body: { model: backend.model, state, questions } }
    : { url: chatUrlFor('openai', backend.baseUrl), body: assistRequest(backend.model, state, questions) };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {}),
  };

  const res = await postWithBackoff({ post, sleep }, request.url, { method: 'POST', headers, body: JSON.stringify(request.body) },
    (message, status) => new DecisionError(`Decision backend ${message}`, status));
  const reply = await boundedJson<Record<string, unknown>>(res, `Decision (${backend.kind})`)
    .catch((e: unknown) => { throw new DecisionError(`Decision (${backend.kind}): unreadable reply — ${e instanceof Error ? e.message : String(e)}`); });

  const raw = backend.kind === 'jev' ? jevAnswers(reply) : assistAnswers(reply);
  const answers: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) answers[id] = govern(q, raw[id], backend.kind);
  return {
    backend: backend.kind,
    model: typeof reply['model'] === 'string' ? reply['model'] : backend.model,
    answers,
    ...(reply['usage'] && typeof reply['usage'] === 'object' ? { usage: reply['usage'] as Decision['usage'] } : {}),
  };
}

function refuseQuestionsWithoutNoMatch(questions: Record<string, Question>): void {
  const missing = Object.entries(questions)
    .filter(([, q]) => q.type === 'choice' && !Object.keys(q.criteria).some(k => (NO_MATCH_OPTIONS as readonly string[]).includes(k)))
    .map(([id]) => id);
  if (missing.length) {
    throw new DecisionError(`Choice question(s) ${missing.join(', ')} list no no-match option — add one of `
      + `${NO_MATCH_OPTIONS.join(' / ')}, or the model is forced to pick a wrong answer.`);
  }
}

// ── Jev ──────────────────────────────────────────────────────────────────────

function jevAnswers(reply: Record<string, unknown>): Record<string, unknown> {
  const a = reply['answers'];
  return a && typeof a === 'object' ? a as Record<string, unknown> : {};
}

// ── Assist ───────────────────────────────────────────────────────────────────

const ASSIST_INSTRUCTIONS = [
  'You answer typed questions about a state. Judge only from the state; never invent facts.',
  'For each question id, reply with ONE value:',
  '- "choice": exactly one of the option keys listed in its criteria — choose the no-match option when none fits;',
  '- "noul": the probability from 0 to 1 that the answer is yes;',
  '- "score": the index of the level that fits best, 0 for the first level.',
  'Reply with JSON only: {"answers": {"<id>": <value>, ...}}.',
].join('\n');

/** The same questions, as an OpenAI chat request whose schema admits only well-formed answers. */
function assistRequest(model: string, state: unknown, questions: Record<string, Question>) {
  const properties: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    properties[id] = q.type === 'choice' ? { type: 'string', enum: Object.keys(q.criteria) }
      : q.type === 'noul' ? { type: 'number', minimum: 0, maximum: 1 }
        : { type: 'integer', minimum: 0, maximum: q.criteria.length - 1 };
  }
  const ids = Object.keys(questions);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: ASSIST_INSTRUCTIONS },
      { role: 'user', content: JSON.stringify({ state, questions }) },
    ],
    // Strict structured output where the server supports it. Where it does not, the instructions above ask
    // for the same shape, and `govern` refuses whatever does not fit either way — the schema is a help to
    // the model, never the check.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'answers',
        strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['answers'],
          properties: { answers: { type: 'object', additionalProperties: false, required: ids, properties } },
        },
      },
    },
  };
}

/** The assist model's `{answers: {id: value}}`, lifted into Jev's per-type answer objects. */
function assistAnswers(reply: Record<string, unknown>): Record<string, unknown> {
  const choices = reply['choices'];
  const content = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
    : undefined;
  if (typeof content !== 'string') return {};
  // A model that ignored response_format often wraps the JSON in a fence; read through it rather than fail.
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const a = (parsed as { answers?: unknown } | null)?.answers;
  if (!a || typeof a !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(a as Record<string, unknown>)) out[id] = { assistValue: v };
  return out;
}

// ── Governance ───────────────────────────────────────────────────────────────

/** One answer, checked against its question. Never trusts the backend's shape, the value, or its presence. */
function govern(q: Question, raw: unknown, kind: 'jev' | 'assist'): Answer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const present = raw !== undefined && (kind === 'jev' || 'assistValue' in r);
  const value = kind === 'assist' ? r['assistValue'] : r[q.type];
  const probabilities = kind === 'jev' && r['probabilities'] && typeof r['probabilities'] === 'object'
    ? r['probabilities'] as Record<string, number> : null;
  const confidence = kind === 'jev' && typeof r['confidence'] === 'number' ? r['confidence'] : null;
  const why = (reason: string) => (present ? reason : 'no answer was returned for this question');

  if (q.type === 'choice') {
    const options = Object.keys(q.criteria);
    const ok = typeof value === 'string' && options.includes(value);
    return ok
      ? { type: 'choice', choice: value, probabilities, confidence }
      : { type: 'choice', choice: null, probabilities, confidence,
        invalid: why(`${JSON.stringify(value)} is not one of ${options.join(', ')}`) };
  }
  if (q.type === 'noul') {
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    return ok ? { type: 'noul', noul: value } : { type: 'noul', noul: null, invalid: why(`${JSON.stringify(value)} is not a probability from 0 to 1`) };
  }
  const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), typeof c === 'string' ? c : JSON.stringify(c)]));
  const max = q.criteria.length - 1;
  // Jev's score is probability-weighted and may land between levels; the assist model's is a level index.
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    && (kind === 'jev' || Number.isInteger(value));
  return ok
    ? { type: 'score', score: value, legend, probabilities, confidence }
    : { type: 'score', score: null, legend, probabilities, confidence, invalid: why(`${JSON.stringify(value)} is not a level from 0 to ${max}`) };
}
