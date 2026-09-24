/**
 * The width of a face descriptor, and the guard that says when it stops being that.
 *
 * ## Why this is not just a constant
 *
 * The docs said, in five places, that FaceRes produces a 128-dimensional descriptor. **The model does not.**
 * `faceres.json`'s own signature declares its descriptor output `global_pooling/Mean` as `[1, 1024]`;
 * `@vladmandic/human` reduces that to 128 in library code.
 *
 * Reported by an operator standing up a centralised face service, and confirmed here. It matters more to us
 * than to them: **the width the whole face gallery is built on is a property of a dependency's internal
 * post-processing, not of the weights we ship.** A `@vladmandic/human` upgrade that changes or removes that
 * reduction changes the vector space of every future in-process embedding.
 *
 * ## The failure it would have had
 *
 * Both embedding paths compared `embedding.length !== 128` and `continue`d — no error, no log, no counter.
 * So a changed reduction would have skipped every face silently, and the symptom would read as "this image
 * has no faces" or "the provider is broken", never as "the library changed". That is the shape this codebase
 * keeps finding: a state the system knew about and did not report.
 *
 * ## What this does instead
 *
 * The skip still happens — one odd descriptor must not fail a whole media job — but the first one to arrive
 * says so, loudly, naming the width it actually got. Once per process, because a changed library means EVERY
 * face is wrong and a per-face log would bury the message it exists to deliver.
 */
import { log } from '../../util/log.js';

/**
 * The dimension the face gallery's Atlas vector index is built with (`{spaceId}_files_faceEmbedding`).
 *
 * One constant rather than the literal `128` that was written in both embedding paths and five doc lines.
 * If this ever becomes configurable — an operator asked for it, so it may — this is the single place the
 * question is asked, rather than a number to go hunting for.
 */
export const FACE_DESCRIPTOR_DIMS = 128;

let warned = false;

/**
 * Check a descriptor's width, and report the first disagreement.
 *
 * Returns whether the descriptor is usable. A `false` means the caller should skip this face — which is what
 * both callers already did; the difference is that it is no longer silent.
 *
 * `source` names which path produced it, because the two have different causes and different fixes: the
 * in-process path changing width means the library's reduction moved, and an external provider changing
 * width means someone pointed the hook at a different model.
 */
export function isUsableDescriptor(
  embedding: unknown,
  source: 'in-process' | 'external',
  /**
   * The width THIS SPACE's gallery was built at, from `faceDescriptorDimsFor()`.
   *
   * Defaults to the built-in only so a caller that genuinely has no space in hand still gets the old
   * behaviour rather than silently accepting anything. Every real caller passes the resolved value: the
   * number that has to agree is the one on the space's own index, not this instance's preference.
   */
  expectedDims: number = FACE_DESCRIPTOR_DIMS,
): boolean {
  if (!Array.isArray(embedding)) return false;
  if (embedding.length === expectedDims) return true;

  if (!warned) {
    warned = true;
    log.warn(
      `Face descriptor width is ${embedding.length}, expected ${expectedDims} (${source}). `
      + 'Every face is being skipped, and this will read as "no faces detected" everywhere. '
      + (source === 'in-process'
        ? 'The in-process width is produced by @vladmandic/human reducing FaceRes\'s own 1024-wide output — '
          + 'if that library was upgraded, its reduction may have changed and the gallery\'s vector space with it.'
        : 'The external provider is returning a different width than the gallery was built for; its vectors '
          + 'cannot be compared with the ones already stored.'),
    );
  }
  return false;
}

