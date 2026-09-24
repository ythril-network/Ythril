/**
 * The extractors' generation client (`F-31`) — the few steps that must WRITE: a claim's sentence (5.2), an arc
 * (5.8), an entity's description (4.10). Everything a model can answer by choosing goes to `decide()` instead;
 * the decomposition keeps this list short on purpose, because generated text is the one output nothing
 * structural can check, which is why a claim is linted (5.3) and citation-checked (5.10) after it is written.
 *
 * The writer is the assist model (`documentProcessing.assistModel`, F11-b): a System One endpoint answers typed
 * questions and does not write prose. Only once its host is consented to — the same rule, re-checked at the call
 * (`config/egress-consent.ts`) — and otherwise refused up front, naming the setting. `F-33` adds its budget and a
 * local fallback; this is the one place that will change.
 */
import { egressConsented } from '../config/egress-consent.js';
import { allowPrivateForSlot } from '../config/model-egress-policy.js';
import { slotTimeoutMs } from '../config/model-slots.js';
import { getDocumentProcessingConfig, getDocAssistApiKey, getModelSlots } from '../config/loader.js';
import { chatUrlFor } from '../files/converters/vlm-endpoint.js';
import { ssrfSafeFetch } from '../util/ssrf.js';
import { boundedJson } from '../util/bounded-read.js';
import { postWithBackoff, type ModelTransport } from './model-post.js';

export interface GenerationBackend { baseUrl: string; model: string; apiKey?: string }

export class GenerationUnavailableError extends Error {
  constructor() {
    super('No model is available to write with: configure `documentProcessing.assistModel` and acknowledge its host '
      + '— extraction sends conversation text there.');
    this.name = 'GenerationUnavailableError';
  }
}

export class GenerationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GenerationError';
  }
}

type Slot = { baseUrl?: string; model?: string; acknowledgedHost?: string; apiKey?: string } | undefined;

/** The assist model as a writer, when it is configured and its host consented to. Pure. */
export function pickGenerationBackend(assist: Slot): GenerationBackend | null {
  if (!assist?.baseUrl || !assist.model || !egressConsented(assist)) return null;
  return { baseUrl: assist.baseUrl, model: assist.model, ...(assist.apiKey ? { apiKey: assist.apiKey } : {}) };
}

/** The writer this instance would use now, or `GenerationUnavailableError`. */
export function generationBackend(): GenerationBackend {
  const assist = getDocumentProcessingConfig().assistModel;
  const b = pickGenerationBackend(assist && { ...assist, apiKey: getDocAssistApiKey() });
  if (!b) throw new GenerationUnavailableError();
  return b;
}

export interface Generation {
  text: string;
  /** The model the backend REPORTS having used, else the one requested. */
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Write one piece of text. Deterministic settings: temperature 0, bounded output. */
export async function generate(
  backend: GenerationBackend,
  prompt: { system: string; user: string; maxTokens?: number },
  transport: ModelTransport = {},
): Promise<Generation> {
  const post = transport.post ?? ((url, init) => ssrfSafeFetch(url,
    { ...init, signal: AbortSignal.timeout(slotTimeoutMs('assist', getModelSlots())) },
    { allowPrivate: allowPrivateForSlot('assist') }));
  const sleep = transport.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const res = await postWithBackoff({ post, sleep }, chatUrlFor('openai', backend.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {}) },
    body: JSON.stringify({
      model: backend.model,
      temperature: 0,
      max_tokens: prompt.maxTokens ?? 400,
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    }),
  }, (message, status) => new GenerationError(`Generation backend ${message}`, status));
  const body = await boundedJson<{ model?: string; choices?: { message?: { content?: unknown } }[]; usage?: Generation['usage'] }>(res, 'Generation');
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new GenerationError('Generation backend returned an empty answer');
  return { text, model: body.model ?? backend.model, ...(body.usage ? { usage: body.usage } : {}) };
}
