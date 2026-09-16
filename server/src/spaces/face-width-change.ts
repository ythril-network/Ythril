/**
 * May this space's face-descriptor width be changed, and if not, why not?
 *
 * ## The gap this closes
 *
 * `faceDescriptorDims` was create-only in the API. The reason given, in the guide and in the schema, is about
 * stored vectors: *"a populated gallery cannot be re-dimensioned: its stored vectors have not moved, so
 * re-declaring the width would leave every existing descriptor unmatchable."* Every word of that is true of a
 * gallery that HOLDS descriptors.
 *
 * The canary operator, 2026-08-20T1012Z, asked the question nobody had: does it bind when there is nothing
 * stored to strand? They had fourteen spaces, three images between them — two of which are page renders our
 * own pipeline extracted from a scanned invoice — and not one face descriptor at any width. Their words:
 * *"we are asking whether the guard is 'no stored faces may be invalidated' or 'no, categorically'."*
 *
 * **It was the first, and the API was enforcing the second.** `ensureVectorSearchIndex` refuses on
 * `existing && !dimsMatch && refuseWidthChange` — index-existence based, so with no index and no descriptor
 * there is nothing to refuse and nothing to strand. The restriction lived in the API surface, which was
 * broader than the safety mechanism needed it to be.
 *
 * ## Why this matters more than "one field became editable"
 *
 * The default is the trap. A space with no stored `faceDescriptorDims` builds its index at
 * `FACE_DESCRIPTOR_DIMS` — **128**, a compile-time constant that nothing derives from the configured
 * endpoint. So pointing `FACE_RECOGNITION_EXTERNAL_MODEL` at a 512-d recogniser without setting the width
 * gives a 128-wide index that silently skips every descriptor it is handed. The reporters' own words for that
 * outcome: *"photographs that genuinely contain people being stored as containing none, permanently, until
 * they are reprocessed."*
 *
 * Their only remedy was to re-create the space. For fourteen spaces holding real data, that is not a remedy.
 *
 * ## What is checked, and why BOTH
 *
 * Two facts, and the pair is the point:
 *
 *  1. **No face descriptor is stored.** Counted, not inferred from the image count: a face chunk survives its
 *     parent image being deleted long enough to matter, and "no images" is not "no descriptors".
 *  2. **No face index exists at a different width.** Because an index built at 128 with nothing in it is still
 *     an index, and rebuilding it is a different act from creating one. Same width is fine — that is a no-op.
 *
 * Checking only (1) would let a width change land on a space whose index is already built and serving at
 * another width, which is the `refuseWidthChange` path and would be refused later, after a 200. Checking only
 * (2) would allow it on a space whose index was dropped by hand while its descriptors remain — a state that
 * looks empty from the index side and is not.
 *
 * ## The refusal is a 409, not a 400
 *
 * The request is well-formed and the field is real; what is wrong is the space's STATE. A 400 would tell a
 * caller their body was malformed, and they would go looking at the body. Both refusals name the count or the
 * width they found, because "cannot change this" without the number leaves an operator with nothing to check.
 */
import { col, asFilter } from '../db/mongo.js';
import type { FileMetaDoc } from '../config/types.js';
import { FACE_DESCRIPTOR_DIMS } from '../files/media/face-descriptor.js';
import { faceIndexWidth } from './vector-index.js';
import { log } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';

/** Why a width change is refused, or `null` when it may proceed. */
export interface FaceWidthRefusal {
  /** HTTP status the REST door answers with. MCP throws the same `reason` text. */
  status: 409;
  reason: string;
}

/**
 * How many face descriptors this space holds.
 *
 * Exported so the refusal and any future report read one implementation of "is the gallery populated". The
 * filter is the same one `file-meta.ts` uses to decide whether an image has been processed — deliberately, so
 * the two cannot disagree about what a face chunk is.
 */
export async function storedFaceDescriptorCount(spaceId: string): Promise<number> {
  return col<FileMetaDoc>(spaceCollection(spaceId, 'files')).countDocuments(
    asFilter<FileMetaDoc>({ faceEmbedding: { $exists: true } }),
  );
}

/**
 * May `spaceId` move to `requested` bits, and if not, why not?
 *
 * `null` means yes. A refusal names what was found, never just that it was refused.
 *
 * A width EQUAL to the current one is always allowed, whatever the gallery holds: it changes nothing, and
 * refusing a no-op would make a client that re-sends its whole config unable to save an unrelated edit —
 * exactly the round-trip failure `SERVER_OWNED_SPACE_FIELDS` exists to prevent one level up.
 */
export async function refuseFaceWidthChange(
  spaceId: string,
  requested: number,
  currentConfigured: number | undefined,
): Promise<FaceWidthRefusal | null> {
  const effective = currentConfigured ?? FACE_DESCRIPTOR_DIMS;
  if (requested === effective) return null;

  const stored = await storedFaceDescriptorCount(spaceId);
  if (stored > 0) {
    return {
      status: 409,
      reason: `Space '${spaceId}' already holds ${stored} face descriptor(s) at ${effective} dimensions. `
        + 'Nothing re-derives a stored face vector, so re-declaring the width would leave every one of them '
        + 'unmatchable while reporting success. Create a space at the width you want; there is no migration, '
        + 'and this refusal is what stops one being faked.',
    };
  }

  // The index side. An empty index at another width is still an index, and rebuilding one is not the same act
  // as creating one — so this is refused too, with the width it actually found rather than the one configured.
  const built = await faceIndexWidth(spaceId);
  if (built !== null && built !== requested) {
    return {
      status: 409,
      reason: `Space '${spaceId}' has no stored face descriptors, but its face index is already built at `
        + `${built} dimensions. The gallery is empty, so nothing would be stranded — but an existing index is `
        + 'not re-dimensioned in place, and a width recorded here that the index disagrees with is worse than '
        + 'either number alone. Drop the index, or create a space at the width you want.',
    };
  }

  log.info(`Space '${spaceId}': face descriptor width ${effective} -> ${requested} (gallery empty, `
    + `index ${built === null ? 'not built' : `already ${built}`}).`);
  return null;
}
