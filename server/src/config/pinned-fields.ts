/**
 * `YTHRIL_PINNED_FIELDS` — how an operator fixes a field at its RESOLVED value, including empty.
 *
 * ## The request, and why nothing else answers it
 *
 * The canary operator asked twice, 2026-08-12T1238Z (Q3), and their framing is the requirement: *"once the URL is
 * infra-pinned to an in-cluster unauthenticated endpoint, an editable key field is a control with nothing behind
 * it. Empty is the CORRECT value, and we would like to pin the correct value."* Owner ruled **A** on 2026-08-19.
 *
 * **The value channel cannot express it, and that was established by trying.** An empty env var deliberately does
 * NOT pin: `docker compose` passes `${VAR:-}` and leaves a variable defined-but-empty when the operator set
 * nothing, so reading "defined" as "pinned" would lock every field on every Compose deployment and show controls
 * nobody can use or explain. All twenty pins were converted to presence checks before
 * `face-recognition-env.test.js` failed with exactly that reasoning; it was reverted. **Do not re-derive it.**
 *
 * A separate list cannot be produced by accident: no Compose default writes `YTHRIL_PINNED_FIELDS`, so its
 * presence is unambiguous, and `RERANK_API_KEY` keeps meaning only *the key*.
 *
 * ## An unrecognised path is REPORTED, never ignored
 *
 * The whole failure this avoids is a control that looks fixed and is not. So a typo must not quietly pin nothing:
 * unknown entries come back in `pinnedUnknown`, which the admin API returns and the UI can render, **and** a warn
 * names them at boot. Reporting only in the log would put the one thing an operator needs to see in the one place
 * they are not looking.
 *
 * It does not refuse to boot. A renamed field in a Helm values file would take the instance down, and the
 * pin-that-did-not-apply is visible either way — the same posture the storage pins already take with a malformed
 * number ("ignored, loudly").
 */
import { log } from '../util/log.js';

/**
 * Every field path a pin may name.
 *
 * ## Why this list exists at all, given the drift risk
 *
 * It is the vocabulary the validation checks against, and it has to be readable at module scope in the loader.
 * Deriving it from `MediaConfigPatchSchema` — the authoritative set of fields the admin API can write, which is
 * exactly what a pin must refuse — would be better, and it is not possible at runtime: that schema lives in
 * `api/media-config.ts`, which imports the loader, and the reranker bounds it uses come from `brain/rerank-client.ts`,
 * which imports the loader too. Importing it back would evaluate `z.number().min(MIN_CANDIDATE_MULTIPLIER)` with
 * `undefined` on one leg of the cycle.
 *
 * **So the second copy is deliberate and it is GATED rather than trusted.**
 * `pinned-fields-match-the-writable-surface.test.js` compares this list against the patch schema's own shape and
 * against the loader's `locked.push` calls, and fails if any of the three disagree. A coverage check would only
 * see that the list exists; drift needs the copies compared.
 */
export const PINNABLE_FIELD_PATHS: readonly string[] = [
  // Top-level media fields.
  'visionProvider', 'sttProvider', 'workerConcurrency', 'workerPollIntervalMs', 'workerMaxPollIntervalMs',
  'fallbackToExternal', 'maxFileSizeBytes', 'stalledJobTimeoutMs',
  // Provider blocks.
  'vision.label', 'vision.baseUrl', 'vision.model', 'vision.apiKey',
  'stt.label', 'stt.baseUrl', 'stt.model', 'stt.apiKey',
  'nli.baseUrl', 'nli.model', 'nli.apiKey',
  'rerank.baseUrl', 'rerank.model', 'rerank.apiKey', 'rerank.candidateMultiplier',
  'rerank.maxPassagesPerRequest',
  'embedding.provider', 'embedding.baseUrl', 'embedding.model', 'embedding.apiKey', 'embedding.dimensions',
  'embedding.prefixScheme', 'embedding.embedConcurrency', 'embedding.similarity',
  // Per-slot model call budgets, pinned at the SLOT rather than at `modelSlots.<slot>.timeoutMs`.
  //
  // Depth 2 matches how `documentProcessing.assistModel` and `faceRecognition.externalModel` pin a whole
  // nested block, and it is what `blockedByInfra` can actually enforce — that check walks two levels. A depth-3
  // path would be accepted here and then reported as successfully written while never taking effect.
  'modelSlots.vision', 'modelSlots.stt', 'modelSlots.embedding', 'modelSlots.rerank', 'modelSlots.nli',
  'modelSlots.assist', 'modelSlots.docVlm', 'modelSlots.docRepair', 'modelSlots.docVerify',
  'modelSlots.faceExternal', 'modelSlots.decision',
  // F-31 — the extractors' decision model, the whole block, like the assist model's.
  'decisionModel',
  // Document processing — the whole block, so an infra deployment can fix the extraction policy and its budgets.
  'documentProcessing.mode', 'documentProcessing.strategy', 'documentProcessing.assistModel',
  'documentProcessing.extractImages', 'documentProcessing.renderDpi', 'documentProcessing.maxPages',
  'documentProcessing.pageTimeoutMs', 'documentProcessing.concurrency', 'documentProcessing.ocrTimeoutMs',
  'documentProcessing.describeTimeoutMs',
  // Face recognition — the block the request was originally about.
  //
  // `enabled`, `modelPath` and `reprocessSyncedImages` are deliberately NOT here even though the loader reports
  // them in `lockedByInfra`: the admin API does not accept them at all, so there is no write for a pin to refuse
  // and the field is already unreachable. Listing them would let an operator believe a pin had done something.
  // The rule that keeps this list honest is exactly that — you can only pin what could otherwise be written.
  'faceRecognition.externalModel', 'faceRecognition.confidenceThreshold',
  'faceRecognition.minFaceSizeFraction', 'faceRecognition.personEntityTypes',
];

const PINNABLE = new Set(PINNABLE_FIELD_PATHS);

export interface PinnedFields {
  /** Recognised paths, to be added to `lockedByInfra`. */
  paths: string[];
  /** Entries that name nothing — surfaced so a typo cannot look like a pin. */
  unknown: string[];
}

/**
 * Parse and validate the variable. Never throws.
 *
 * Splits on commas, trims, drops empties — so trailing commas and line-wrapped values in a Helm manifest behave.
 * Case-sensitive, because the field paths are, and a case-insensitive match would accept `rerank.APIKEY` and then
 * report a pin on a path no other code recognises.
 */
export function parsePinnedFields(raw: string | undefined): PinnedFields {
  if (!raw || raw.trim() === '') return { paths: [], unknown: [] };
  const paths: string[] = [];
  const unknown: string[] = [];
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (PINNABLE.has(entry)) {
      // Deduplicated: a repeated entry is harmless but would show twice in `lockedByInfra`, and that list is read
      // by the UI to decide what to grey out.
      if (!paths.includes(entry)) paths.push(entry);
    } else if (!unknown.includes(entry)) {
      unknown.push(entry);
    }
  }
  return { paths, unknown };
}

/**
 * Read the environment, warn about anything unrecognised, and return both halves.
 *
 * The variable is named in a LITERAL `process.env['…']` in the default parameter, not reached through an `env`
 * object passed in. `env-var-docs-coverage` scans for that literal form to check every documented variable is
 * actually read — an indirect read is invisible to it, and it reported this one as documented-but-dead. Taking the
 * raw string as the parameter keeps it injectable for tests and keeps the name findable by grep, which is what a
 * human debugging a pin will reach for too.
 */
export function pinnedFieldsFromEnv(raw: string | undefined = process.env['YTHRIL_PINNED_FIELDS']): PinnedFields {
  const result = parsePinnedFields(raw);
  if (result.unknown.length > 0) {
    // "not pinnable" rather than "does not exist", because some of them DO exist: a field the admin API never
    // accepts (`faceRecognition.enabled`) is real, is already unreachable, and has no write for a pin to refuse.
    // Telling an operator it does not exist would send them looking for a typo they did not make.
    log.warn(
      `YTHRIL_PINNED_FIELDS names ${result.unknown.length} entr(y/ies) that are not pinnable: `
      + `${result.unknown.join(', ')}. Those are NOT pinned. A path must be a field the admin API can write — `
      + 'check the spelling, and note that fields the API never accepts are already fixed and need no pin. '
      + `Pinned and applied: ${result.paths.length > 0 ? result.paths.join(', ') : 'none'}.`,
    );
  }
  return result;
}
