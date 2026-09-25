/**
 * Which assist-model backend answers this call, and may it — the ONE place that decides (`F-33`).
 *
 * Owner, 2026-09-24: *"we need a fallback assistant model and a budget on assistant model (x tokens resets every y
 * hours) - that way one can add a big hosted public model like claude and say you have x token per hour and when that
 * isnt reachable or session limit or the specified token per hour are used fallback to a local llm"*.
 *
 * ## Why one module
 *
 * Four paths reach the assist slot — the document repair pass, the document description, the extractor's writer and
 * its decision fallback — and each read `documentProcessing.assistModel` itself. A budget or a fallback added to three
 * of them is a fourth that spends without counting. So they ask here, name their use, and report back what the call
 * cost and whether it failed; `the-assist-model-falls-back-and-keeps-a-budget.test.js` refuses a caller that picks an
 * endpoint on its own.
 *
 * ## The rules
 *
 * - The PRIMARY answers while it is configured, consented for this use (`assistConsented`), not cooling down after a
 *   failure, and not over its budget in the rolling window.
 * - Otherwise the FALLBACK, if configured and either local (`isLocalModelEndpoint`: loopback or a bare service name —
 *   nothing leaves the instance) or consented for this use itself. An external fallback is egress like any other.
 * - Otherwise nothing, and the caller does what it did before there was an assist model.
 *
 * The budget binds the primary only: it exists to cap a paid hosted model, and a local fallback costs nothing to run.
 * A reply that reports no usage is counted at an estimate from the characters sent and received — never as free, or
 * an endpoint that omits `usage` would never spend its budget, which is the one failure a budget exists to prevent.
 *
 * Usage persists in `<data>/assist-usage.json` so a restart does not reset the window; a lost write costs at most the
 * last few seconds of accounting, never a crash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assistConsented, type AssistUse } from './egress-consent.js';
import { isLocalModelEndpoint } from './model-egress-policy.js';
import { getDataRoot, getDocumentProcessingConfig, getDocAssistApiKey, getDocAssistFallbackApiKey } from './loader.js';
import { log } from '../util/log.js';

/** One assist endpoint as the config holds it. */
export interface AssistSlotConfig {
  baseUrl?: string;
  model?: string;
  acknowledgedHost?: string;
  acknowledgedHostForConversations?: string;
}

/** `tokens` over a rolling `perHours`. */
export interface AssistBudget { tokens: number; perHours: number }

export interface UsageEntry { at: number; tokens: number }

/**
 * The two fields F-33 adds to the stored assist block. `budget`: `tokens` over a rolling `perHours`, binding the
 * primary only. `fallback`: the endpoint that answers when the primary may not — usually a local LLM, which needs no
 * consent; an external one is consented per use like the primary. Its key lives in secrets as `docAssistFallbackApiKey`.
 */
export interface AssistModelExtras { budget?: AssistBudget; fallback?: AssistSlotConfig }

/** The endpoint a call goes to, and which of the two it is — reported beside the model on every result. */
export interface AssistEndpoint { which: 'primary' | 'fallback'; baseUrl: string; model: string; apiKey?: string }

/** How long a primary that failed is passed over before it is tried again. */
export const PRIMARY_COOLDOWN_MS = 60_000;

/** Characters per token for the estimate a reply without `usage` is charged at. Conservative: over-counts English. */
const CHARS_PER_TOKEN = 3;

const configured = (s: AssistSlotConfig | undefined): s is AssistSlotConfig & { baseUrl: string; model: string } =>
  !!s?.baseUrl?.trim() && !!s?.model?.trim();

/** Tokens spent in the `perHours` window ending at `now`. */
export function spentInWindow(usage: readonly UsageEntry[], now: number, perHours: number): number {
  const from = now - perHours * 3_600_000;
  return usage.reduce((sum, u) => (u.at > from && u.at <= now ? sum + u.tokens : sum), 0);
}

/**
 * What a reply cost: its reported usage in the OpenAI shape (`prompt_tokens`/`completion_tokens`/`total_tokens`) or
 * the System One one (`input_tokens`/`output_tokens`), else an estimate from `chars` — sent plus received.
 */
export function tokensOf(usage: Record<string, unknown> | undefined, chars: number): number {
  const n = (k: string) => (typeof usage?.[k] === 'number' && Number.isFinite(usage[k]) ? usage[k] as number : 0);
  const reported = n('total_tokens') || (n('prompt_tokens') + n('completion_tokens')) || (n('input_tokens') + n('output_tokens'));
  return reported > 0 ? reported : Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** The decision, pure: which backend answers `use` now, or null. */
export function pickAssistBackend(input: {
  primary: AssistSlotConfig | undefined;
  fallback: AssistSlotConfig | undefined;
  budget?: AssistBudget;
  usage: readonly UsageEntry[];
  primaryDownUntil?: number;
  now: number;
  use: AssistUse;
}): Omit<AssistEndpoint, 'apiKey'> | null {
  const { primary, fallback, budget, usage, primaryDownUntil, now, use } = input;
  const overBudget = !!budget && budget.tokens > 0 && spentInWindow(usage, now, budget.perHours) >= budget.tokens;
  if (configured(primary) && assistConsented(primary, use) && !(primaryDownUntil !== undefined && primaryDownUntil > now) && !overBudget) {
    return { which: 'primary', baseUrl: primary.baseUrl, model: primary.model };
  }
  if (configured(fallback) && (isLocalModelEndpoint(fallback.baseUrl) || assistConsented(fallback, use))) {
    return { which: 'fallback', baseUrl: fallback.baseUrl, model: fallback.model };
  }
  return null;
}

// ── State: the window's usage and the primary's cooldown ─────────────────────────────────────────────────────────

let usage: UsageEntry[] | null = null;
let primaryDownUntil: number | undefined;
let flushTimer: NodeJS.Timeout | null = null;

const usageFile = () => path.join(getDataRoot(), 'assist-usage.json');

function loadUsage(): UsageEntry[] {
  if (usage) return usage;
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(), 'utf8')) as unknown;
    usage = Array.isArray(raw) ? raw.filter((u): u is UsageEntry => typeof u?.at === 'number' && typeof u?.tokens === 'number') : [];
  } catch {
    usage = [];   // absent on a fresh install, and unreadable is no reason to stop answering
  }
  return usage;
}

/** Keep only what the configured window can still count, so the file stays the size of one window. */
function prune(now: number): void {
  let perHours = 24;
  try { perHours = getDocumentProcessingConfig().assistModel?.budget?.perHours ?? 24; } catch { /* no config yet: a day */ }
  const from = now - Math.max(perHours, 1) * 3_600_000;
  usage = loadUsage().filter(u => u.at > from);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { fs.writeFileSync(usageFile(), JSON.stringify(usage ?? [])); }
    catch (err) { log.warn(`assist budget: could not persist usage (${err instanceof Error ? err.message : String(err)}) — the window still counts in memory`); }
  }, 5_000);
  flushTimer.unref?.();
}

/** The backend `use` goes to now, with its key, or null. */
export function assistBackend(use: AssistUse, now = Date.now()): AssistEndpoint | null {
  const a = getDocumentProcessingConfig().assistModel;
  const picked = pickAssistBackend({
    primary: a, fallback: a?.fallback, ...(a?.budget ? { budget: a.budget } : {}),
    usage: loadUsage(), ...(primaryDownUntil !== undefined ? { primaryDownUntil } : {}), now, use,
  });
  if (!picked) return null;
  const apiKey = picked.which === 'primary' ? getDocAssistApiKey() : getDocAssistFallbackApiKey();
  return { ...picked, ...(apiKey ? { apiKey } : {}) };
}

/** A failure that means the primary cannot answer NOW, as opposed to a request it will never accept. */
const unavailable = (status: number | undefined) => status === undefined || status === 429 || status === 529 || status === 402 || status >= 500;

/**
 * What a call to `endpoint` came to. A success is charged to the budget (the primary's only); a failure that means
 * the primary cannot answer now — unreachable, rate- or session-limited, overloaded — passes it over for a minute.
 * A 4xx that is the request's own fault is not the endpoint being down, so it changes nothing.
 */
export function recordAssistOutcome(
  endpoint: Pick<AssistEndpoint, 'which'>,
  outcome: { ok: true; usage?: Record<string, unknown>; chars: number } | { ok: false; status?: number },
  now = Date.now(),
): void {
  if (endpoint.which !== 'primary') return;
  if (outcome.ok) {
    prune(now);
    usage!.push({ at: now, tokens: tokensOf(outcome.usage, outcome.chars) });
    scheduleFlush();
    return;
  }
  const s = outcome.status;
  if (unavailable(s)) {
    primaryDownUntil = now + PRIMARY_COOLDOWN_MS;
    log.warn(`assist model: the primary ${s === undefined ? 'could not be reached' : `answered ${s}`} — the fallback answers for ${PRIMARY_COOLDOWN_MS / 1000}s`);
  }
}

/**
 * Run one assist call on `first`, record what it came to, and — when the PRIMARY could not answer now — run it once
 * more on the fallback, in the same call. Every caller goes through this, because the three parts are the ones a
 * hand-written copy drops one of: the charge, the cooldown, and the second attempt.
 *
 * `run` reports the reply's `usage` and the characters sent and received, which is what a reply without usage is
 * charged at. A failure carries the HTTP status as `status` when there was one (the extractor and converter errors
 * all do); none means the endpoint was not reached.
 */
export async function viaAssist<T>(
  use: AssistUse,
  first: AssistEndpoint,
  run: (endpoint: AssistEndpoint) => Promise<{ value: T; usage?: Record<string, unknown>; chars: number }>,
): Promise<T> {
  try {
    const r = await run(first);
    recordAssistOutcome(first, { ok: true, ...(r.usage ? { usage: r.usage } : {}), chars: r.chars });
    return r.value;
  } catch (err) {
    const raw = (err as { status?: unknown } | null)?.status;
    const status = typeof raw === 'number' ? raw : undefined;
    recordAssistOutcome(first, { ok: false, ...(status !== undefined ? { status } : {}) });
    if (first.which !== 'primary' || !unavailable(status)) throw err;
    const next = assistBackend(use);
    if (!next || next.which !== 'fallback') throw err;
    log.info(`assist model: answering on the fallback ${next.model} after the primary failed`);
    return (await run(next)).value;
  }
}

/**
 * What one assist step can cost in time: one leg, or BOTH when a fallback is set, because `viaAssist` makes the same
 * call again on the fallback after the primary fails. The stall floor fed one leg would re-queue a job in the middle
 * of its second attempt — the loop `providerHopMs` already closes for the media provider chain.
 */
export function assistHopMs(legMs: number | undefined, hasFallback: boolean): number | undefined {
  return legMs === undefined ? undefined : hasFallback ? legMs * 2 : legMs;
}

/** For the pipeline status: what the window has spent, and whether the primary is being passed over. */
export function assistBudgetStatus(now = Date.now()): { spent: number; budget?: AssistBudget; primaryCoolingDown: boolean } {
  const budget = getDocumentProcessingConfig().assistModel?.budget;
  return {
    spent: spentInWindow(loadUsage(), now, budget?.perHours ?? 24),
    ...(budget ? { budget } : {}),
    primaryCoolingDown: primaryDownUntil !== undefined && primaryDownUntil > now,
  };
}
