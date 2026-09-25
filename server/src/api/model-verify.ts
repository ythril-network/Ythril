/**
 * Verify — one real request against a configured model, using synthetic content.
 *
 * ## Why listing models is not enough
 *
 * `test-connection` lists an endpoint's models. That answers "is something there", and it is deliberately
 * cheap and content-free. What it cannot answer is the question an operator actually has: **does my
 * configured model work?**
 *
 * Two reports made the gap concrete:
 *
 *  - A vision endpoint was listed, reachable, and failed on **every single image** — the request carried
 *    `data:application/octet-stream;base64,…` and strict servers rejected it outright. No list probe
 *    could ever have seen that; a single real call would have shown it immediately.
 *  - An endpoint that serves **aliases** (llama-swap roles, gateways, Azure deployments) does not
 *    enumerate the names it answers to, so "not listed" says nothing at all. The only way to find out is
 *    to ask it.
 *
 * ## Synthetic content, not user content
 *
 * Every payload here is generated: a 1×1 PNG, a few milliseconds of silence, the word `ping`. Verify
 * exercises the real provider path — the same wire format, the same guard, the same model name — without
 * sending anything belonging to the operator. That matters because for several targets the real path is
 * an egress path, and a diagnostic must not become one.
 *
 * ## Cold starts are not failures
 *
 * A reporter's successful vision call took **34.7 seconds**, and that was not inference: their
 * llama-swap was swapping the model in, because one GPU serves vision, STT, OCR, chat and embedding.
 * A short timeout here would reintroduce exactly the false negative this endpoint exists to remove — a
 * healthy system reported broken. So the budget is generous, and a timeout is reported as its own
 * outcome (`still-loading`) rather than as a failure, because on a swapping backend a slow first call is
 * normal and the correct advice is "try again", not "fix your endpoint".
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAdminMfa } from '../auth/middleware.js';
import { getMediaEmbeddingConfig, getEmbeddingConfig } from '../config/loader.js';
import { createMediaProviders } from '../files/media/providers.js';
import { embed } from '../brain/embedding.js';
import { repairMarkdownExternal } from '../files/converters/vlm-client.js';
import { log } from '../util/log.js';
import { assistProbeTarget } from '../config/assist-backend.js';
import { envInt } from '../config/env-num.js';

export const modelVerifyRouter = Router();

/**
 * How long one verification may take.
 *
 * Three minutes, because the failure this replaces is a false negative on a healthy system. A model
 * swapping in on a shared GPU took 34.7s in the field; 180s leaves room for a larger model on a busier
 * host without ever making the operator wonder whether the button did anything.
 */
const VERIFY_TIMEOUT_MS = envInt('MODEL_VERIFY_TIMEOUT_MS', 180_000);

/**
 * A 1×1 transparent PNG.
 *
 * The smallest thing that is genuinely an image. It exercises the whole vision path — MIME resolution,
 * the data URI, the SSRF guard, the model name — which is precisely the set of things that were broken
 * while every list probe reported green.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** ~40ms of silence as a minimal RIFF/WAVE file, built rather than shipped as a fixture. */
function silentWav(ms = 40, sampleRate = 8000): Buffer {
  const samples = Math.floor((sampleRate * ms) / 1000);
  const data = Buffer.alloc(samples * 2); // 16-bit mono silence
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // PCM chunk size
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export type VerifyOutcome = 'ok' | 'failed' | 'still-loading' | 'unconfigured';

export interface VerifyResult {
  target: string;
  outcome: VerifyOutcome;
  latencyMs: number;
  /** What the model said, truncated — evidence that it really answered. */
  sample?: string;
  detail?: string;
}

const VerifySchema = z.object({
  target: z.enum(['vision', 'stt', 'embedding', 'assist']),
  // `F-33`: on the assist target, exercise its fallback instead of the primary.
  fallback: z.boolean().optional(),
}).strict();

/** Race a real call against the budget, so a swapping backend reports `still-loading`, not `failed`. */
async function withBudget<T>(work: Promise<T>): Promise<{ value?: T; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), VERIFY_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([work.then(value => ({ value })), timeout]);
    if (r === 'timeout') return { timedOut: true };
    return { value: (r as { value: T }).value, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one verification.
 *
 * Exported so it can be tested without an HTTP round trip. Never throws: a verification that blew up is
 * a `failed` outcome with the reason, not a 500 — the whole point is to report on a broken endpoint.
 */
export async function verifyTarget(target: z.infer<typeof VerifySchema>['target'], opts: { fallback?: boolean } = {}): Promise<VerifyResult> {
  const started = Date.now();
  const done = (outcome: VerifyOutcome, extra: Partial<VerifyResult> = {}): VerifyResult =>
    ({ target, outcome, latencyMs: Date.now() - started, ...extra });

  try {
    // Inside the try, deliberately. `getMediaEmbeddingConfig()` throws when config is not loaded, and
    // reading it above meant this function could throw instead of returning a result — which defeats the
    // contract that a diagnostic always reports rather than crashes. Caught by its own test.
    const media = getMediaEmbeddingConfig();
    if (target === 'embedding') {
      const emb = getEmbeddingConfig();
      if (!emb.model) return done('unconfigured', { detail: 'no embedding model is configured' });
      const r = await withBudget(embed('ping'));
      if (r.timedOut) return done('still-loading');
      const dims = r.value?.vector?.length ?? 0;
      return dims > 0
        ? done('ok', { sample: `${dims}-dimensional vector` })
        : done('failed', { detail: 'the endpoint answered but returned no vector' });
    }

    if (target === 'assist') {
      // The primary or its fallback (`F-33`), each over the API it speaks — the Claude API included (`F-33.1`).
      const assist = assistProbeTarget(opts.fallback === true);
      if (!assist.baseUrl || !assist.model) return done('unconfigured', { detail: `no assist model ${opts.fallback ? 'fallback ' : ''}is configured` });
      // The assist path is an acknowledged egress path, so it gets synthetic text like everything else.
      const r = await withBudget(repairMarkdownExternal({
        baseUrl: assist.baseUrl, model: assist.model, api: assist.wire, ...(assist.apiKey ? { apiKey: assist.apiKey } : {}),
        draft: 'ping', evidence: 'ping', hardTimeoutMs: VERIFY_TIMEOUT_MS,
      }));
      if (r.timedOut) return done('still-loading');
      return done('ok', { sample: (r.value?.text ?? '').slice(0, 120) });
    }

    // vision / stt both go through the media provider pair, so Verify exercises the SAME client the
    // worker uses — including the wire format and the guard, which is where both field failures were.
    const providers = createMediaProviders(
      media.vision ?? {}, media.stt ?? {},
      media.visionProvider ?? 'local', media.sttProvider ?? 'local',
      false,
    );

    if (target === 'vision') {
      if (!media.vision?.model) return done('unconfigured', { detail: 'no vision model is configured' });
      const r = await withBudget(providers.vision.caption(ONE_PIXEL_PNG, 'image/png'));
      if (r.timedOut) return done('still-loading');
      const caption = (r.value ?? '').trim();
      return caption.length > 0
        ? done('ok', { sample: caption.slice(0, 120) })
        : done('failed', { detail: 'the model answered with an empty caption' });
    }

    if (!media.stt?.model) return done('unconfigured', { detail: 'no speech-to-text model is configured' });
    const r = await withBudget(providers.stt.transcribe(silentWav(), 'audio/wav'));
    if (r.timedOut) return done('still-loading');
    // Silence legitimately transcribes to nothing. Reaching a structured response IS the pass here —
    // asserting on transcript text would fail a perfectly working endpoint.
    return r.value
      ? done('ok', { sample: r.value.text?.trim() ? r.value.text.slice(0, 120) : '(silence transcribed to no text, as expected)' })
      : done('failed', { detail: 'the endpoint returned no transcription object' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`Model verify (${target}) failed: ${detail}`);
    return done('failed', { detail });
  }
}

/**
 * POST /api/admin/media-config/verify
 *
 * Admin + MFA, like `test-connection`. Unlike it, this makes a REAL request — it costs latency and, on a
 * metered endpoint, money. The UI says so on the button.
 */
modelVerifyRouter.post('/verify', requireAdminMfa, async (req, res) => {
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }
  res.json(await verifyTarget(parsed.data.target, { fallback: parsed.data.fallback === true }));
});
