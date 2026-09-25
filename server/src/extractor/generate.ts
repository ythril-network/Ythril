/**
 * The extractors' generation client (`F-31`) — the few steps that must WRITE: a claim's sentence (5.2), an arc
 * (5.8), an entity's description (4.10). Everything a model can answer by choosing goes to `decide()` instead;
 * the decomposition keeps this list short on purpose, because generated text is the one output nothing
 * structural can check, which is why a claim is linted (5.3) and citation-checked (5.10) after it is written.
 *
 * The writer is the assist model (`documentProcessing.assistModel`, F11-b): a System One endpoint answers typed
 * questions and does not write prose. Which endpoint writes — the primary, or its fallback once the primary is over
 * budget, failing or not consented — is `config/assist-backend.ts`'s decision (`F-33`), re-made at every call; with
 * neither available the call is refused up front, naming the setting.
 */
import { assistBackend, viaAssist, type AssistEndpoint } from '../config/assist-backend.js';
import { slotTimeoutMs } from '../config/model-slots.js';
import { getModelSlots } from '../config/loader.js';
import { chatUrlFor } from '../files/converters/vlm-endpoint.js';
import { modelFetch } from '../util/model-fetch.js';
import { boundedJson } from '../util/bounded-read.js';
import { postWithBackoff, type ModelTransport } from './model-post.js';

/** `which` says whether this is the assist model's primary or its fallback — the budget and cooldown follow it. */
export interface GenerationBackend { baseUrl: string; model: string; apiKey?: string; which?: AssistEndpoint['which'] }

export class GenerationUnavailableError extends Error {
  constructor() {
    super('No model is available to write with: configure `documentProcessing.assistModel` and consent it for '
      + 'conversations — extraction sends conversation text there.');
    this.name = 'GenerationUnavailableError';
  }
}

export class GenerationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GenerationError';
  }
}

/**
 * The writer, from the endpoint `assistBackend('conversations')` chose — already checked for its CONVERSATIONS
 * consent (a claim is written from conversation turns, which a documents consent never named), its budget and its
 * cooldown. Pure.
 */
export function pickGenerationBackend(assist: AssistEndpoint | null): GenerationBackend | null {
  if (!assist) return null;
  return { baseUrl: assist.baseUrl, model: assist.model, which: assist.which, ...(assist.apiKey ? { apiKey: assist.apiKey } : {}) };
}

/** The writer this instance would use now, or `GenerationUnavailableError`. */
export function generationBackend(): GenerationBackend {
  const b = pickGenerationBackend(assistBackend('conversations'));
  if (!b) throw new GenerationUnavailableError();
  return b;
}

export interface Generation {
  text: string;
  /** The model the backend REPORTS having used, else the one requested. */
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Write one piece of text. Deterministic settings: temperature 0, bounded output. An assist-model backend is charged
 * to its budget and, when its primary cannot answer now, the same call is written by the fallback (`viaAssist`).
 */
export async function generate(
  backend: GenerationBackend,
  prompt: { system: string; user: string; maxTokens?: number },
  transport: ModelTransport = {},
): Promise<Generation> {
  if (!backend.which) return generateOnce(backend, prompt, transport);
  const sent = prompt.system.length + prompt.user.length;
  return viaAssist('conversations', { ...backend, which: backend.which }, async ep => {
    const g = await generateOnce({ ...backend, ...ep }, prompt, transport);
    return { value: g, ...(g.usage ? { usage: g.usage as Record<string, unknown> } : {}), chars: sent + g.text.length };
  });
}

async function generateOnce(
  backend: GenerationBackend,
  prompt: { system: string; user: string; maxTokens?: number },
  transport: ModelTransport,
): Promise<Generation> {
  const post = transport.post ?? ((url, init) => modelFetch(url,
    { ...init, signal: AbortSignal.timeout(slotTimeoutMs('assist', getModelSlots())) }, 'assist'));
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
