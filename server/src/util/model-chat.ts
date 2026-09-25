/**
 * One chat call to a model endpoint, over whichever wire it speaks — Ollama, OpenAI-compatible, or the Claude API.
 *
 * ## Why one module
 *
 * The assist callers — the extractor's writer and its decision fallback, the document description and the repair
 * pass — each built an OpenAI body and read `choices[0]` by hand. A third wire added at each of them would be three
 * more copies of the parts a copy drops: the Claude headers, the missing `temperature`, the usage the budget is
 * charged, the status a fallback is decided on. So the request and the reply are built HERE, and a caller only says
 * what it wants to ask (`F-33.1`).
 *
 * ## The Claude API, within its terms
 *
 * Owner, 2026-09-25: *"assist models should be able to go for claude models/api as well if thats within tos and
 * possible"*. It is, with an API key: the Claude API is the supported way for an application to call Claude, through
 * the official SDK. A Claude.ai or Claude Code subscription credential is not, and this takes an API key only.
 *
 * The SDK is handed the CALLER'S transport as its `fetch`, so the SSRF guard, the per-slot timeout and a test's stub
 * see every request exactly as they do on the other wires; its own retries are off because the caller already has a
 * backoff. Current Claude models refuse sampling parameters, so no `temperature` is sent; output is bounded by
 * `max_tokens`. A refusal (`stop_reason: "refusal"`) is thrown marked `refused`, which `viaAssist` answers on the
 * fallback without cooling the primary down — the endpoint is fine, it declined this content.
 */
import Anthropic from '@anthropic-ai/sdk';
import { boundedJson, boundedErrorText } from './bounded-read.js';
import { chatUrlFor } from '../files/converters/vlm-endpoint.js';
import { postWithBackoff } from '../extractor/model-post.js';

export type ChatWire = 'ollama' | 'openai' | 'anthropic';

export interface ChatEndpoint { wire: ChatWire; baseUrl: string; model: string; apiKey?: string }

/** One turn; `images` are base64 PNGs, the only image type the render sidecar emits. */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; images?: string[] }

export interface ChatRequest {
  system?: string;
  turns: ChatTurn[];
  maxTokens: number;
  /** Structured output: an OpenAI `response_format` json_schema, a Claude `output_config.format`. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Extra top-level fields for the OpenAI wire only (e.g. a slot's `reasoning_effort`). */
  openAiExtras?: Record<string, unknown>;
}

/** `text` is the model's text as it came — a transcription's whitespace is content; a caller that wants it trimmed trims. */
export interface ChatReply { text: string; truncated: boolean; model?: string; usage?: Record<string, unknown> }

export interface ChatTransport {
  /** The caller's own transport — the guarded fetch with its slot timeout, or a test's stub. */
  post: (url: string, init: RequestInit & { headers: Record<string, string>; body: string }) => Promise<Response>;
  /** Given, a retryable status is retried on the shared backoff schedule; absent, one attempt. */
  sleep?: (ms: number) => Promise<void>;
}

/** The Messages API version this module speaks. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Where the Claude API lives under an operator's base URL, with or without the `/v1` they typed. */
const claudeBase = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

/**
 * How to list a Claude endpoint's models — for the probe, so it reaches the same host with the same credential
 * shape inference uses. A Bearer token is not how the Claude API takes a key, so the OpenAI-style probe would
 * report a working endpoint as refusing its credential. The reply is `{ data: [{ id }] }`, the OpenAI list shape.
 */
export function claudeListRequest(baseUrl: string, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
  return {
    url: `${claudeBase(baseUrl)}/v1/models`,
    headers: { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  };
}

export async function chatOnce(
  endpoint: ChatEndpoint,
  req: ChatRequest,
  transport: ChatTransport,
  fail: (message: string, status?: number) => Error,
): Promise<ChatReply> {
  if (endpoint.wire === 'anthropic') return claude(endpoint, req, transport, fail);

  const url = chatUrlFor(endpoint.wire, endpoint.baseUrl);
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    ...req.turns.map(t => endpoint.wire === 'ollama'
      ? (t.images ? { role: t.role, content: t.content, images: t.images } : { role: t.role, content: t.content })
      : (t.images
        ? { role: t.role, content: [{ type: 'text', text: t.content }, ...t.images.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))] }
        : { role: t.role, content: t.content })),
  ];
  const body = endpoint.wire === 'ollama'
    ? { model: endpoint.model, stream: false, options: { temperature: 0, num_predict: req.maxTokens }, messages }
    : {
      model: endpoint.model, temperature: 0, max_tokens: req.maxTokens, messages, ...(req.openAiExtras ?? {}),
      ...(req.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } } } : {}),
    };
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) } as Record<string, string>,
    body: JSON.stringify(body),
  };
  const res = transport.sleep
    ? await postWithBackoff({ post: transport.post, sleep: transport.sleep }, url, init, fail)
    : await transport.post(url, init).then(async r => {
      if (!r.ok) throw fail(`HTTP ${r.status}: ${await boundedErrorText(r)}`, r.status);
      return r;
    }, (e: unknown) => { throw fail(`unreachable (${url}): ${e instanceof Error ? e.message : String(e)}`); });

  if (endpoint.wire === 'ollama') {
    const j = await boundedJson<{ model?: string; message?: { content?: unknown }; done_reason?: string; error?: unknown }>(res, 'Model');
    if (j.error) throw fail(`error: ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error).slice(0, 200)}`);
    const text = typeof j.message?.content === 'string' ? j.message.content : '';
    return { text, truncated: j.done_reason === 'length', ...(j.model ? { model: j.model } : {}) };
  }
  const j = await boundedJson<{ model?: string; choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: Record<string, unknown>; error?: unknown }>(res, 'Model');
  if (j.error) throw fail(`error: ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error).slice(0, 200)}`);
  const content = j.choices?.[0]?.message?.content;
  return {
    text: typeof content === 'string' ? content : '',
    truncated: j.choices?.[0]?.finish_reason === 'length',
    ...(j.model ? { model: j.model } : {}),
    ...(j.usage ? { usage: j.usage } : {}),
  };
}

async function claude(endpoint: ChatEndpoint, req: ChatRequest, transport: ChatTransport, fail: (m: string, s?: number) => Error): Promise<ChatReply> {
  const client = new Anthropic({
    apiKey: endpoint.apiKey ?? null,
    baseURL: claudeBase(endpoint.baseUrl),
    maxRetries: 0,
    // The SDK's own init, re-spelled into the shape every transport here takes: plain header record, string body.
    fetch: ((url: string | URL | Request, init?: RequestInit) => transport.post(String(url), {
      ...init, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : '',
    })) as typeof fetch,
  });
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: endpoint.model,
    max_tokens: req.maxTokens,
    ...(req.system ? { system: req.system } : {}),
    messages: req.turns.map(t => ({
      role: t.role,
      content: [
        ...(t.images ?? []).map(data => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } })),
        { type: 'text' as const, text: t.content },
      ],
    })),
    ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema.schema } } } : {}),
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const msg = await client.messages.create(params);
      if (msg.stop_reason === 'refusal') throw Object.assign(fail('declined this request (refusal)'), { refused: true });
      const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      return { text, truncated: msg.stop_reason === 'max_tokens', model: msg.model, usage: { ...msg.usage } as Record<string, unknown> };
    } catch (err) {
      if ((err as { refused?: boolean }).refused) throw err;
      if (err instanceof Anthropic.APIConnectionError) throw fail(`unreachable (${endpoint.baseUrl}): ${err.message}`);
      if (err instanceof Anthropic.APIError) {
        const retryable = err.status === 429 || err.status === 529 || (err.status ?? 0) >= 500;
        if (transport.sleep && retryable && attempt < 2) { await transport.sleep(1_000 * 2 ** attempt); continue; }
        throw fail(`HTTP ${err.status}: ${err.message}`, err.status);
      }
      throw err;
    }
  }
}
