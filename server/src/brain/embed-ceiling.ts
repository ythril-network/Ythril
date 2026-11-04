/**
 * How many UTF-8 bytes one embedder request may carry (`embedding.maxInputBytes`), as the one answer every reader shares.
 *
 * ## What it prevents
 *
 * The setting is read by the chunkers' bounding pass, the builder of what is embedded and `embed()`'s last guard. A reader that took
 * the stored value as it found it would, on a hand-edited `config.json` (which is NOT validated at load: only the admin PATCH is),
 * turn `0`, a string or `NaN` into "no limit" (`bytes > NaN` is false), and send an oversized input to the embedder after all. So
 * the validation sits inside the accessor and cannot be dropped: a value that is not a whole number in the range
 * (`DUAL_DOOR_BOUNDS['embedding.maxInputBytes']`, the numbers the PATCH schema reads too) is answered as the default, never as the
 * edge of the range and never as unbounded, and said once.
 *
 * Why 6,000 bytes: the chunks that were refused measured 4.07 to 4.25 characters per token, so 6,000 bytes is about 1,500 tokens, and
 * stays under an 8,192-token context even at one token per byte (the worst a byte-level tokenizer can do).
 */
import { getEmbeddingConfig } from '../config/loader.js';
import { DUAL_DOOR_BOUNDS } from '../config/setting-bounds.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { embedInputCutTotal } from '../metrics/registry.js';

/** The ceiling when none is configured or the configured one is not valid. */
export const DEFAULT_EMBED_INPUT_BYTES = 6_000;

const invalidSaid = warnOnce<string>({ max: 4, every: 10 * 60_000 });

/** The embedding block as it is stored, or an empty one before the instance has a config (a unit that chunks a string, a first run). */
export function storedEmbeddingConfig(): ReturnType<typeof getEmbeddingConfig> | Record<string, never> {
  try { return getEmbeddingConfig(); } catch { return {}; }
}

/** The most UTF-8 bytes one embedder request may carry, the task prefix included. `cfg` is the embedding block when the caller already holds it. */
export function embedInputCeiling(cfg: { maxInputBytes?: unknown } = storedEmbeddingConfig()): number {
  const stored = cfg.maxInputBytes;
  if (stored === undefined || stored === null) return DEFAULT_EMBED_INPUT_BYTES;
  const { min, max } = DUAL_DOOR_BOUNDS['embedding.maxInputBytes'];
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= min && stored <= max) return stored;
  invalidSaid('maxInputBytes', () => log.warn(
    `embedding.maxInputBytes is ${peerText(stored)}, which is not a whole number of bytes from ${min} to ${max}; `
    + `the default of ${DEFAULT_EMBED_INPUT_BYTES} is used. Set it through PATCH /api/admin/media-config or correct config.json.`));
  return DEFAULT_EMBED_INPUT_BYTES;
}

const cutSaid = warnOnce<string>({ max: 8, every: 10 * 60_000 });

/**
 * Which producer's text was cut: a whole-document vector (the `embed` level), a media transcript, caption or combined text, or an input the
 * HTTP embedder was sent cut by `embed()`'s last guard.
 */
export type CutProducer = 'whole-document' | 'media' | 'http';

/**
 * Count and say one cut of an embedder input, for every producer that cuts: `embedTextForProducer` (`embed-text.ts`), a rebuild that embeds
 * a cut text (`embedStoredRecord`) and `embed()`'s HTTP guard (`embedding.ts`). It is counted (`ythril_embed_input_cut_total{producer}`) and
 * said once per window and producer, so a stream of oversized texts does not fill the log ring. It lives here, with the ceiling it reports
 * on, because `embed-text.ts` imports `embedding.ts`: a count made in either would leave the other to write it again.
 */
export function noteInputCut(producer: CutProducer, textBytes: number, keptBytes: number): void {
  embedInputCutTotal.labels({ producer }).inc();
  cutSaid(producer, () => log.warn(producer === 'http'
    ? `Embedding input is ${textBytes} bytes, over the embedder's ceiling of ${embedInputCeiling()} (embedding.maxInputBytes); `
      + `the HTTP embedder is sent the first ${keptBytes}. A vector of a cut text describes its beginning only.`
    : `A ${producer} text of ${textBytes} bytes is over the embedder's ceiling (embedding.maxInputBytes); it is embedded as its first `
      + `${keptBytes} bytes, so its vector describes its beginning only. The stored text is whole and is still found by its words.`));
}
