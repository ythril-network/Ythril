/**
 * The chunks and extracted images of one file, paged — read the same way by every door that offers them (Q-647).
 *
 * ## Why this exists
 *
 * `GET /api/brain/spaces/:spaceId/files/extract` parsed `limit`, `skip`, `imagesLimit` and `imagesSkip` inline, and the MCP tool
 * for that capability, `read_file`, took none of them: an agent could read a long document's text and could not reach its
 * 101st chunk or the images a conversion pulled out of it. Giving the tool the four meant a second copy of the parse, the clamp,
 * the refusal and the two queries — "the same defaults, caps and refusals" written twice, and the stricter reading of `images*`
 * (a bad value REFUSED, not floored) is exactly the half a hand-written copy drops. So the route's listing is moved here and both
 * doors call it.
 *
 * ## What it fixes on the way
 *
 * The refusal for a bad `imagesLimit` was built by rewriting the shared list rule's `limit` into `` `images$1` `` and so read
 * `` `imageslimit` ``, a parameter name that exists nowhere. It names the real ones now.
 *
 * ## What a caller gets, and what it does not
 *
 * A listing (`chunks`, `chunkTotal`, `limit`, `skip`, `images`, `imagesTotal`, `imagesTruncated`, `imagesNextSkip`) and the
 * `derived` records it read the images from, so the route can find the converted Markdown among them without a second query. The
 * Markdown window is NOT here: it is `resolveTextWindow`'s, read by both doors through `readFileWindow`.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { parseLimit, parseSkip } from '../util/pagination.js';
import { pageList, resolveListPaging } from '../brain/list-page.js';
import { applyBudget, resolveBudget } from '../brain/result-budget.js';
import { NEVER_RETURNED_PROJECTION } from '../brain/read-projection.js';
import { parentOfSidecar } from './moved-paths.js';
import type { FileMetaDoc } from '../config/types.js';

/** The four parameters, as every door spells them. */
export const EXTRACT_LISTING_PARAMS = ['limit', 'skip', 'imagesLimit', 'imagesSkip'] as const;

export interface ExtractListingRequest {
  limit?: unknown;
  skip?: unknown;
  imagesLimit?: unknown;
  imagesSkip?: unknown;
}

/** Chunks per page when the caller states none, and the most one page holds. */
const CHUNKS_DEFAULT_LIMIT = 100;
const CHUNKS_MAX_LIMIT = 500;
/** Images per page when the caller states none, and the most one page holds (the pipeline writes at most 50 a file). */
const IMAGES_DEFAULT_LIMIT = 200;
const IMAGES_MAX_LIMIT = 200;

/** Whether the caller stated any of the four: a door that offers the listing only on request asks this. */
export function extractListingAsked(req: ExtractListingRequest): boolean {
  return EXTRACT_LISTING_PARAMS.some(k => req[k] !== undefined);
}

/** The shared list rule's refusal, naming the PARAMETER the caller sent (`images` + `Limit`), not the rule's own. */
function imagesRefusal(error: string): string {
  return error.replace(/`(limit|skip)`/, (_m, k: string) => `\`images${k === 'limit' ? 'Limit' : 'Skip'}\``);
}

/**
 * The refusal for a bad `imagesLimit` / `imagesSkip`, or `null`. Asked BEFORE anything is read, so a door can refuse without
 * having done the work. (`limit` and `skip` are never refused: a garbage value falls back to the default, as the route always did.)
 */
export function extractListingRefusal(req: ExtractListingRequest, budgetChars: number): string | null {
  const r = resolveListPaging({ limit: req.imagesLimit, skip: req.imagesSkip }, { defaultLimit: IMAGES_DEFAULT_LIMIT, maxLimit: IMAGES_MAX_LIMIT, budgetChars });
  return r.ok ? null : imagesRefusal(r.error);
}

export type ExtractListing =
  | { ok: false; error: string }
  | { ok: true; fields: Record<string, unknown>; derived: FileMetaDoc[] };

/**
 * Read one parent's chunk page and image page from the member space it was found in.
 *
 * @param member       the member space the parent's record lives in — on a proxy space the derived records are in the same
 *                     member collection as their parent, and another member's would answer empty with no error
 * @param budgetChars  the door's character default (`defaultBudgetChars(transport)`), which holds the chunk page and the image
 *                     page alike: a page of 500 converted-PDF chunks is most of a megabyte, and MCP carries it twice
 * @param carriages    how many times the door carries the listing (`carriagesFor(transport)`), so each copy keeps to its share
 */
export async function readExtractListing(
  member: string, parentId: string, req: ExtractListingRequest, budgetChars: number, carriages = 1,
): Promise<ExtractListing> {
  const refusal = extractListingRefusal(req, budgetChars);
  if (refusal) return { ok: false, error: refusal };
  const limit = parseLimit(req.limit, CHUNKS_DEFAULT_LIMIT, CHUNKS_MAX_LIMIT);
  const skip = parseSkip(req.skip);
  const files = col<FileMetaDoc>(spaceCollection(member, 'files'));

  // Chunks: everything carrying a chunkIndex, in document order. `chunkIndex` is the discriminator
  // rather than the path shape, because a chunk's id is `<parent>#chunk<n>` for text and
  // `#media-chunk<n>` for audio — two spellings of one thing.
  const chunkFilter = { parentFileId: parentId, chunkIndex: { $exists: true } };
  const [chunkDocs, chunkTotal] = await Promise.all([
    files.find(asFilter<FileMetaDoc>(chunkFilter), { projection: NEVER_RETURNED_PROJECTION }).sort({ chunkIndex: 1 }).skip(skip).limit(limit).toArray(),
    files.countDocuments(asFilter<FileMetaDoc>(chunkFilter)),
  ]);

  // Everything else derived from this parent: the `_converted/` record and the `_extracted/` images. Read whole —
  // the pipeline writes at most 50 images per file — and the images then page through the shared list rule, so a
  // file with more says so rather than stopping at a number (Q-128). Metadata only; the image bytes stay in the store.
  const derived = await files
    .find(asFilter<FileMetaDoc>({ parentFileId: parentId, chunkIndex: { $exists: false } }), { projection: NEVER_RETURNED_PROJECTION })
    .toArray() as FileMetaDoc[];

  const allImages = derived
    .filter(d => parentOfSidecar(d.path)?.role === 'extracted')
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map(d => ({
      path: d.path,
      description: d.description ?? null,
      // Says whether a caption was written by a model or is the operator's own text — the same
      // provenance the file detail pane shows, because "generated" is a claim.
      descriptionSource: d.descriptionSource ?? null,
      sizeBytes: d.sizeBytes,
      embeddingStatus: d.embeddingStatus ?? null,
    }));
  const imagePage = pageList(allImages, { limit: req.imagesLimit, skip: req.imagesSkip },
    { defaultLimit: IMAGES_DEFAULT_LIMIT, maxLimit: IMAGES_MAX_LIMIT, budgetChars });
  if (!imagePage.ok) return { ok: false, error: imagesRefusal(imagePage.error) };

  const chunkRows = chunkDocs.map(c => ({
        id: c._id,
        index: c.chunkIndex ?? null,
        headingText: c.headingText ?? null,
        content: c.content ?? '',
        // Audio/video chunks carry their position in the recording; documents carry heading provenance.
        // Both spellings are returned as they are, so the client formats rather than guesses.
        chunkOffsetMs: (c as { chunkOffsetMs?: number }).chunkOffsetMs ?? null,
        chunkDurationMs: (c as { chunkDurationMs?: number }).chunkDurationMs ?? null,
        embeddingStatus: c.embeddingStatus ?? null,
      }));
  // Whole chunks only, held to the door's budget; the first chunk is always admitted, so a page never stalls. The cut is
  // said by `chunksTruncated` and `chunksNextSkip` (absolute), never by the page just coming back shorter than `limit`.
  const chunkBudget = resolveBudget({}, budgetChars, carriages);
  if (!chunkBudget.ok) return { ok: false, error: chunkBudget.error };
  const chunkPage = applyBudget(chunkRows, chunkBudget).returned;
  const chunksCut = chunkPage.length < chunkRows.length;

  return {
    ok: true,
    derived,
    fields: {
      chunks: chunkPage,
      chunkTotal,
      chunksTruncated: chunksCut,
      ...(chunksCut ? { chunksNextSkip: skip + chunkPage.length } : {}),
      limit,
      skip,
      images: imagePage.rows,
      // The image list's own page, prefixed because `limit`/`skip` above are the chunks' (Q-128).
      imagesTotal: imagePage.fields['total'],
      imagesTruncated: imagePage.fields['truncated'],
      ...(imagePage.fields['nextSkip'] !== undefined ? { imagesNextSkip: imagePage.fields['nextSkip'] } : {}),
    },
  };
}
