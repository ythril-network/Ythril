/**
 * One setting has ONE legal range, whichever door it arrives through.
 *
 * ## The defect this closes
 *
 * Four settings can be written two ways — by an environment variable that infra sets, and by the admin
 * `PATCH /api/admin/media-config` an operator uses. Each door validated the value against its own numbers, and
 * the numbers disagreed:
 *
 * | setting | env door | admin door |
 * |---|---|---|
 * | `documentProcessing.ocrTimeoutMs` | 1 000 … 3 600 000 | 10 000 … 1 800 000 |
 * | `documentProcessing.describeTimeoutMs` | 1 000 … 3 600 000 | 1 000 … **600 000** |
 * | `embedding.dimensions` | 1 … 8 192 | 1 … **16 384** |
 * | `embedding.embedConcurrency` | 1 … **256** | 1 … 32 |
 *
 * So the same number was legal or a boot failure depending on which door you used, and the disagreement ran in
 * both directions — the env door six times wider on one field and half as wide on another. That is this
 * codebase's most-produced defect exactly: one rule, two implementations, and which one you get decided by
 * something the operator did not choose.
 *
 * ## The sharpest one, and why this is not merely untidy
 *
 * `MAX_EMBED_CONCURRENCY` is 32 and says why in its own docblock — *"Hard ceiling on the operator override, so
 * a typo cannot turn into hundreds of parallel requests."* The admin schema imports that constant rather than
 * repeating it, and says so in a comment. The env door allowed **256**: `EMBEDDING_CONCURRENCY=256` passed
 * validation, was reported as accepted, and was then silently clamped to 32 by `embedConcurrency()`. Validation
 * that accepts a value the runtime will not honour is worse than no validation, because it answers the
 * operator's question wrongly rather than not answering it.
 *
 * ## Where each number comes from
 *
 * **Whatever the runtime actually enforces wins; where nothing enforces it, the admin schema wins** — because
 * that is the surface with the reasons written beside it. `describeTimeoutMs`'s ceiling is generous *"because a
 * single-GPU host may have to load a model before it can answer"*, and `ocrTimeoutMs`'s floor is 10 000 because
 * a scan cannot finish faster. The env entries carried a uniform 1 000 … 3 600 000 across both, which is a
 * default rather than a decision.
 *
 * `embedding.dimensions` is the one with no reason on either side: nothing downstream constrains it,
 * `vector-index.ts` passes `numDimensions` through to Atlas unexamined, and neither ceiling appears in the
 * docs. It takes the admin number for the same reason as the rest — that is the door an operator reads — and
 * this paragraph exists so the next person knows it was arbitrary rather than derived.
 *
 * ## What keeps it true
 *
 * `one-setting-one-range.test.js` derives the pairs from source and fails when a field reachable through both
 * doors has two ranges. Deriving rather than listing is the point: a hand-kept list of dual-door settings would
 * be a third place to forget, which is the shape of the bug rather than a fix for it.
 */
import { MAX_EMBED_CONCURRENCY } from '../files/converters/embed-concurrency.js';

/**
 * The reranker's candidate window, defined HERE rather than in `rerank-client.ts`.
 *
 * `rerank-client.ts` imports `config/loader.ts`, and the loader imports this file — so taking the constants
 * from there would close a runtime import cycle. `rerank-client.ts` re-exports them, so its existing importers
 * are untouched and there is still exactly one definition. `embed-concurrency.ts` needs no such move because it
 * imports nothing at all.
 */
export const MIN_CANDIDATE_MULTIPLIER = 2;
export const MAX_CANDIDATE_MULTIPLIER = 10;

/** A setting's legal range, and what it means — the `what` is read aloud in an env failure message. */
export interface SettingBound {
  min: number;
  max: number;
  what: string;
}

/**
 * Every setting reachable through more than one door, keyed by its config path.
 *
 * The key is the CONFIG PATH rather than the env-var name, because the config path is what both doors have in
 * common: the env var writes it and the PATCH schema addresses it. Keying on the env name would leave the admin
 * schema joining on something it never mentions.
 */
export const DUAL_DOOR_BOUNDS = {
  'documentProcessing.ocrTimeoutMs': {
    min: 10_000, max: 1_800_000,
    what: 'how long an OCR extraction may take',
  },
  'documentProcessing.describeTimeoutMs': {
    min: 1_000, max: 600_000,
    what: 'how long a document description may take',
  },
  'embedding.dimensions': {
    min: 1, max: 16_384,
    what: 'the embedding vector width',
  },
  'embedding.embedConcurrency': {
    min: 1, max: MAX_EMBED_CONCURRENCY,
    what: 'how many embeds run at once',
  },
  // The five `getMediaEmbeddingConfig()` reads through its own `pick()`. These were worse than divergent:
  // `pick` coerced with a bare `Number(envRaw)` and checked nothing, so a typo became NaN and travelled.
  // `maxFileSizeBytes` is the one that matters — `input.bytes > NaN` is FALSE, so a mistyped
  // `MAX_FILE_SIZE_BYTES` does not raise the media size limit, it REMOVES it, silently and for every upload.
  'mediaEmbedding.workerConcurrency': {
    min: 1, max: 16,
    what: 'how many media jobs run at once',
  },
  'mediaEmbedding.workerPollIntervalMs': {
    min: 100, max: 60_000,
    what: 'how often the media worker looks for work',
  },
  'mediaEmbedding.workerMaxPollIntervalMs': {
    min: 1_000, max: 600_000,
    what: 'the longest the media worker backs off to when idle',
  },
  'mediaEmbedding.maxFileSizeBytes': {
    min: 1, max: 10_737_418_240,
    what: 'the largest media file that will be processed',
  },
  'mediaEmbedding.stalledJobTimeoutMs': {
    min: 30_000, max: 3_600_000,
    what: 'how long a media job may run before it is treated as stalled',
  },
  // Not a NaN case — `candidateMultiplier()` guards with `Number.isFinite` before clamping — but the same
  // divergence as `embedConcurrency`, and it is the one worth naming because it looks harmless: the env door
  // accepted 500 and the consumer silently clamped it to 10, while the admin door answered 400 for the same
  // value. Silently honouring less than an operator asked for is the failure that is never reported, because
  // nothing looks wrong from either end.
  'mediaEmbedding.rerank.candidateMultiplier': {
    min: MIN_CANDIDATE_MULTIPLIER, max: MAX_CANDIDATE_MULTIPLIER,
    what: 'how many candidates the reranker considers per result',
  },
} as const satisfies Record<string, SettingBound>;

/**
 * Which environment variable writes which config path.
 *
 * Both the env registry and the gate read this, so the join is stated once. An entry here without a matching
 * `DUAL_DOOR_BOUNDS` row is a setting with two doors and no shared range — which is the thing being fixed, so
 * the gate refuses it rather than skipping it.
 */
export const ENV_TO_CONFIG_PATH = {
  DOC_OCR_TIMEOUT_MS: 'documentProcessing.ocrTimeoutMs',
  DOC_DESCRIBE_TIMEOUT_MS: 'documentProcessing.describeTimeoutMs',
  EMBEDDING_DIMENSIONS: 'embedding.dimensions',
  EMBEDDING_CONCURRENCY: 'embedding.embedConcurrency',
  WORKER_CONCURRENCY: 'mediaEmbedding.workerConcurrency',
  WORKER_POLL_INTERVAL_MS: 'mediaEmbedding.workerPollIntervalMs',
  WORKER_MAX_POLL_INTERVAL_MS: 'mediaEmbedding.workerMaxPollIntervalMs',
  MAX_FILE_SIZE_BYTES: 'mediaEmbedding.maxFileSizeBytes',
  STALLED_JOB_TIMEOUT_MS: 'mediaEmbedding.stalledJobTimeoutMs',
  RERANK_CANDIDATE_MULTIPLIER: 'mediaEmbedding.rerank.candidateMultiplier',
} as const satisfies Record<string, keyof typeof DUAL_DOOR_BOUNDS>;

/**
 * Validate a dual-door environment value, or stop the boot naming what is wrong with it.
 *
 * The refusal is deliberate and matches `assertNumericEnvOrExit`: a malformed setting that starts the instance
 * anyway is the whole defect class this file closes. Continuing with a default would be worse than either
 * alternative, because the operator's value is then discarded with nothing said.
 */
export function dualDoorOrExit(envName: keyof typeof ENV_TO_CONFIG_PATH, raw: string): number {
  const checked = checkDualDoorValue(envName, raw);
  if (checked && !checked.ok) {
    console.error(`Configuration: ${checked.why}`);
    process.exit(1);
  }
  return checked && checked.ok ? checked.value : Number(raw);
}

/**
 * Coerce any numeric environment value, validating it when it is one this file knows.
 *
 * The whole branch lives here rather than at the call site because `loader.ts` is a frozen file under
 * `no-new-god-files.test.js`, and that gate's advice is the right advice: *"put the new behaviour beside it
 * rather than inside it."* A setting's rules belong with the other setting rules in any case — the loader's job
 * is to decide precedence, not to know which values are legal.
 *
 * A name this file does not know is coerced without bounds, exactly as before. That is not a loophole: the
 * settings with two doors are the ones whose ranges can disagree, and a single-door numeric env var is already
 * covered by `env-num.ts`.
 */
export function numericEnvOrExit(envName: string, raw: string): number {
  return isDualDoorEnv(envName) ? dualDoorOrExit(envName, raw) : Number(raw);
}

/**
 * Validate a numeric environment value against its shared range, or return the reason it is refused.
 *
 * Returns `undefined` for an unset variable — "not configured" and "configured wrongly" are different answers
 * and the caller must be able to tell them apart. A NaN is a REFUSAL rather than a passthrough: the whole
 * defect being closed here is a mistyped value arriving as NaN and comparing false against everything.
 */
export function checkDualDoorValue(
  envName: keyof typeof ENV_TO_CONFIG_PATH,
  raw: string | undefined,
): { ok: true; value: number } | { ok: false; why: string } | undefined {
  if (raw === undefined) return undefined;
  const b = DUAL_DOOR_BOUNDS[ENV_TO_CONFIG_PATH[envName]];
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, why: `${envName}="${raw}" is not a number. It sets ${b.what}.` };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, why: `${envName}="${raw}" must be a whole number. It sets ${b.what}.` };
  }
  if (n < b.min || n > b.max) {
    return { ok: false, why: `${envName}=${n} is outside ${b.min}…${b.max}. It sets ${b.what}, and the same `
      + 'range applies through Settings → Models & Media.' };
  }
  return { ok: true, value: n };
}

/** Whether an arbitrary env name is one of the dual-door settings — the narrowing a generic reader needs. */
export function isDualDoorEnv(name: string): name is keyof typeof ENV_TO_CONFIG_PATH {
  return Object.prototype.hasOwnProperty.call(ENV_TO_CONFIG_PATH, name);
}

