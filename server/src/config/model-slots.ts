/**
 * How long ONE call to each model slot may take, and where that number comes from.
 *
 * ## Why this exists
 *
 * The canary operator asked why they could not configure the vision deadline (2026-08-29T1445Z), and the
 * answer was that only the document pipeline was ever settable. Every other model call carried a literal: two
 * exported constants in `files/media/providers.ts`, one in `face-external.ts`, bare
 * `AbortSignal.timeout(20_000)` in the NLI and rerank clients, `30_000` in the embedder, and `?? 60_000`
 * repeated **five times** in `vlm-client.ts`. Ten slots, four mechanisms, and no way to change any of them
 * short of a rebuild.
 *
 * ## Why one slot-keyed table rather than a field on each provider block
 *
 * `MediaProviderConfig` covers `vision`, `stt`, `nli` and `rerank` — four of the ten. `embedding` has its own
 * shape, the face detector uses a literal, and the four document slots are flat keys inside
 * `DocumentProcessingConfig`. Putting `timeoutMs` on the provider interface would reach four slots and need
 * five more homes for the rest, which is the "one rule, several implementations" defect by construction. Keyed
 * by slot, every slot is reached the same way and an eleventh is one row.
 *
 * It also unlocks the three document slots that are env-only today: because the tuning is keyed BY slot rather
 * than nested inside each slot's own config block, a budget becomes settable without also opening that slot's
 * model and URL fields to the admin PATCH.
 *
 * ## Why this module imports nothing
 *
 * It is read from the config loader, from two brain clients, from the media providers and from the document
 * converter — several of which the loader itself imports. Anything it depended on would close a runtime import
 * cycle, which this codebase has produced twice already. So it is pure and total: it takes the config block as
 * an argument and returns a number. `MODEL_SLOTS` lives here for the same reason, with
 * `model-egress-policy.ts` re-exporting it as `EGRESS_SLOTS` — one vocabulary, not a second one that agrees by
 * coincidence.
 *
 * ## The stall floor is not optional here
 *
 * `hopBudgets()` feeds the stall detector the longest thing one job step may take, and `stall-floor.ts` raises
 * the stall timeout above it. Fed a constant while the operator's value is larger, the detector would keep
 * protecting the DEFAULT — and a call longer than the stall timeout gets re-queued mid-flight, abandons its
 * work, and reaches the same call again. That is the loop `stall-floor.ts` exists to prevent, re-armed by the
 * control meant to help. So the floor resolves through this module too, and
 * `a-model-slot-timeout-is-settable.test.js` asserts it.
 */

/**
 * Every model slot, in one vocabulary.
 *
 * Identical in value to what `model-egress-policy.ts` has always called `EGRESS_SLOTS`; that module now
 * re-exports this so the egress policy and the budget table cannot describe different sets of slots.
 */
export const MODEL_SLOTS = [
  'vision', 'stt', 'embedding', 'rerank', 'nli',
  'assist', 'docVlm', 'docRepair', 'docVerify', 'faceExternal', 'decision',
] as const;

export type ModelSlot = (typeof MODEL_SLOTS)[number];

/** Per-slot tuning an operator may set. The shape is what kept the second field from needing a second home. */
export interface ModelSlotTuning {
  /**
   * Wall-clock budget for ONE call to this slot, in milliseconds. Absent means the built-in default.
   *
   * On `vision` this replaces both legs. The 120 s local and 60 s external defaults exist because a cold local
   * model is slower than a hosted API; an operator who names one number has overridden that reasoning on
   * purpose, and both legs take it.
   */
  timeoutMs?: number;

  /**
   * How hard a thinking model should think on this slot. Absent means the field is not sent at all.
   *
   * See `REASONING_EFFORTS` below for the vocabulary and for why it is llama.cpp's rather than a neutral
   * three — one of the values the neutral scale would have shipped breaks the model this was reported from.
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * The shipped budget for each slot — exactly the literals these call sites carried before they were settable.
 *
 * Deliberately unchanged. A change that made budgets configurable *and* moved them would make any resulting
 * regression impossible to attribute to either half.
 */
export const MODEL_SLOT_DEFAULT_MS: Record<ModelSlot, number> = {
  vision: 120_000,        // a cold local caption model
  stt: 300_000,           // long audio; equal to the default stalledJobTimeoutMs, hence the floor
  embedding: 30_000,
  rerank: 20_000,
  nli: 20_000,
  assist: 60_000,         // the four below were `opts.timeoutMs ?? 60_000`, five times over
  docVlm: 60_000,
  docRepair: 60_000,
  docVerify: 60_000,
  faceExternal: 30_000,
  decision: 60_000,       // one batch of extractor questions (F-31); the same budget as the other hosted LLM slot
};

/** What an operator may have configured, as stored. */
export type ModelSlotsConfig = Partial<Record<ModelSlot, ModelSlotTuning | undefined>>;

/**
 * The range the admin PATCH accepts for a slot budget.
 *
 * The ceiling matches the widest one already in the admin schema (`ocrTimeoutMs`, 30 minutes) rather than
 * being invented: these are all "one call to a model", and a document OCR pass is the longest such call the
 * product already permits. The floor is 1 s for the same reason `describeTimeoutMs` uses it — a sub-second
 * budget is a mistake, not a preference.
 *
 * There is deliberately **no environment variable** for these. Every setting that had both doors was found to
 * have two different legal ranges, and the fix for that shipped one commit ago; adding ten more dual-door
 * settings on the same day would be re-opening it. `YTHRIL_PINNED_FIELDS` already gives infra what it needs
 * here — it can fix a slot at whatever the config resolves to, which is the actual requirement.
 */
export const MODEL_TIMEOUT_MIN_MS = 1_000;
export const MODEL_TIMEOUT_MAX_MS = 1_800_000;

/**
 * The budget to actually use for one call to `slot`.
 *
 * **A value that is not a usable number falls back rather than propagating.** `config.json` can be hand-edited,
 * so the PATCH schema is not the only way in — and a `NaN` here would reach `AbortSignal.timeout`, where every
 * comparison against it is false. That is the same failure a mistyped `MAX_FILE_SIZE_BYTES` produced one layer
 * down, and the answer is the same: refuse the value, keep the guarantee.
 *
 * Zero and negatives fall back too. A zero budget is not "no limit", it is "abort immediately", and nobody
 * means that — it is what a half-finished edit looks like.
 */
export function slotTimeoutMs(slot: ModelSlot, cfg: ModelSlotsConfig | undefined): number {
  const set = cfg?.[slot]?.timeoutMs;
  return usableMs(set) ?? MODEL_SLOT_DEFAULT_MS[slot];
}

/** A budget only if it is one. Shared so both sides of `slotTimeoutMsOr` refuse the same values. */
function usableMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * The budget for one call to `slot`, when the CALLER also has a number of its own.
 *
 * ## The bug this exists to make unwriteable
 *
 * The document pipeline has a per-page control, `documentProcessing.pageTimeoutMs`, and it was handed to the
 * model clients as `opts.timeoutMs ?? slotTimeoutMs(slot, …)`. `??` takes the left side whenever it is
 * present, so the caller's number won every time and the resolver was dead code on that path. Four slots —
 * `docVlm`, `docRepair`, `docVerify` and `assist` — were documented in the field table, accepted by the admin
 * PATCH and pinnable, with no effect at all.
 *
 * **Both defaults are 60 000 ms**, so the documented number and the used number agreed exactly until an
 * operator changed one. Nothing ever contradicted it.
 *
 * ## The ordering, and why it is here rather than at each call site
 *
 * Operator's slot setting, then the caller's default, then the built-in. A caller supplying a default is
 * saying *"this is the number when nobody chose one"* — which is what `pageTimeoutMs` is for the document
 * slots, and why it stays meaningful for operators who never open the per-slot controls.
 *
 * Written at the three call sites instead, this is one `??` away from being the original defect again, and
 * the two spellings read identically in a diff. `a-slot-budget-is-not-shadowed.test.js` refuses a caller
 * value in front of the resolver anywhere in the model path for exactly that reason.
 *
 * A caller that genuinely OWNS the deadline — the Verify probe, which must not hang for the half hour a slot
 * budget may legally be — passes its number as a hard `timeoutMs` and does not come through here.
 *
 * Both sides are refused the same way `slotTimeoutMs` refuses one: `pageTimeoutMs` reaches this from a config
 * block that a hand edit can put a `NaN` in, and a `NaN` at `AbortSignal.timeout` makes every comparison
 * against it false.
 */
export function slotTimeoutMsOr(
  slot: ModelSlot,
  cfg: ModelSlotsConfig | undefined,
  callerDefaultMs: number | undefined,
): number {
  return usableMs(cfg?.[slot]?.timeoutMs) ?? usableMs(callerDefaultMs) ?? MODEL_SLOT_DEFAULT_MS[slot];
}
/**
 * How hard a thinking model should think, per slot — the values llama.cpp's own server accepts.
 *
 * ## Why this is settable at all
 *
 * Reported by a fleet operator 2026-09-06 with the measurement that makes the case: their 27B answers, and
 * it takes **3m32.79s** at its template default. Nothing was misconfigured and it was never unreachable — it
 * thinks for three and a half minutes and there was no seam to ask it for less. Around that one success three
 * callers were losing at three different deadlines against the same endpoint: two at 3m00 on `describe`, an
 * api-gateway at 15m00 on chat. **None of them could ask for less thinking, so each one only had a deadline
 * to fail on.** A longer timeout is not a fix for that shape.
 *
 * ## Why the vocabulary is llama.cpp's and not a neutral three
 *
 * The reporter asked for `low` / `medium` / `high`, arguing that the OpenAI scale outlives a model swap —
 * which is a good argument and would have shipped a value that breaks the model they actually run.
 * **Qwen3.8's chat template accepts `low`, `medium` and `xhigh`, and throws on `minimal`, `high` and `max`.**
 * The server starts, and then every request fails.
 *
 * So the set here is the one `llama-server` documents for `--reasoning-effort`, and the operator picks what
 * their model supports. `low` and `medium` are in both vocabularies, so the reporter's argument still holds
 * for the two values it actually rests on.
 *
 * ## `none` is here, and it is not the fourth value they declined
 *
 * They argued against an `off` because it would be Qwen's template vocabulary. It is not: llama.cpp handles
 * `none` ITSELF — *"if none, reasoning/thinking is disabled; otherwise the value is made available to the
 * jinja template"* — so it is the one value that does not depend on the model having been trained for it.
 * Their own answer, that a slot which must not think should point at a model that does not, remains the
 * better arrangement where a second model is available. This is for where one is not.
 *
 * ## Absent means SEND NOTHING
 *
 * Not a default of `medium`. A model that was never trained for this ignores the field at best and errors at
 * worst, and an instance that starts sending a new parameter to every endpoint after an upgrade would be
 * changing behaviour nobody asked it to change. The operator turns it on per slot.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The `reasoning_effort` field to merge into an OpenAI-shaped request body, or nothing at all.
 *
 * Returns an object to SPREAD rather than a value to test, so a call site cannot accidentally send
 * `reasoning_effort: undefined` — which serialises to a key some servers reject and others ignore, and is the
 * shape that makes a parameter look supported when it is not.
 *
 * An unrecognised value is dropped rather than forwarded. `config.json` is hand-editable, so the admin PATCH
 * is not the only way in, and forwarding a typo would fail EVERY request to that slot with an error naming
 * the model rather than the setting.
 */
export function reasoningEffortBody(
  slot: ModelSlot,
  cfg: ModelSlotsConfig | undefined,
): { reasoning_effort: ReasoningEffort } | Record<string, never> {
  const set = cfg?.[slot]?.reasoningEffort;
  return typeof set === 'string' && (REASONING_EFFORTS as readonly string[]).includes(set)
    ? { reasoning_effort: set as ReasoningEffort }
    : {};
}

