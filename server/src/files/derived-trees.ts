/**
 * Which on-disk trees are pipeline OUTPUT rather than content, and how a listing hides them.
 *
 * ## Why it is here rather than in `api/files.ts`
 *
 * It was in the route file, and adding `_tmp/` to it pushed that file one line past the god-file freeze. The
 * ratchet's own instruction is *"put the new behaviour beside it rather than inside it"*, and this is behaviour
 * with nothing route-specific about it: a predicate over directory names plus one query-parameter escape hatch.
 * Moving it makes the route file smaller than it was.
 *
 * ## The trees
 *
 * `_converted/<id>.md` is the converted Markdown for a binary document; `_extracted/<id>/` holds the images
 * pulled out of one. Both are keyed by internal record id, and neither is a thing a person put there.
 *
 * `_tmp/` (`SPILL_DIR`) is the same kind of thing one step further out: a read result too large to return
 * inline, written so the caller can download the whole of it and removed a day later by the TTL sweep. Output,
 * not content — which is also why `enqueueEmbedJob` declines to embed it.
 */
import type { Request } from 'express';
import type { FileEntry } from './files.js';
import { SPILL_DIR, spillIdFromPath } from '../brain/spill-path.js';

export const DERIVED_TREES = new Set(['_converted', '_extracted', SPILL_DIR]);

/**
 * Hide the derived trees from a directory listing, unless explicitly asked for.
 *
 * The integration guide already said these were "hidden from the file manager UI and listing endpoints by
 * default (same as chunks and `_converted/` files)" — and that was only ever half true. The file-meta listing
 * does hide derived RECORDS (`parentFileId` exists ⇒ excluded), but the file store's directory listing had no
 * such filter, so the folders sat in the tree. A customer reported exactly that mismatch.
 *
 * The doc described the intent; the code matches it. `?includeDerived=true` restores the old view for anyone
 * using it to inspect conversions — the same escape hatch `?includeChunks=true` provides on the metadata side,
 * rather than removing the ability outright.
 *
 * Only at the root, because that is where the pipeline writes them; a user directory that happens to be called
 * `_converted` deeper in the tree is theirs and is left alone.
 */
export function hideDerivedTrees(dirPath: string, entries: FileEntry[], req: Request): FileEntry[] {
  if (req.query['includeDerived'] === 'true') return entries;
  const atRoot = dirPath === '' || dirPath === '/' || dirPath === '.';
  if (!atRoot) return entries;
  return entries.filter(e => !(e.type === 'dir' && isDerivedTreeName(e.name)));
}

/** Whether a ROOT directory name is a derived tree: the one test the listing and {@link isHiddenFilePath} share. */
export const isDerivedTreeName = (name: string): boolean => DERIVED_TREES.has(name);

/**
 * Whether a file row at `id` (a path from the space root) is hidden from a client the way the listing hides it: under a derived tree at the root, or a
 * legacy read spill in any spelling (`spillIdFromPath`, the backup's rule too). The change feed asks it of every row, so a sidecar and an old spill never
 * page to a client, and the rule is the listing's, not a second spelling of it.
 */
export function isHiddenFilePath(id: string): boolean {
  const first = id.replace(/^[\\/]+/, '').split(/[\\/]/, 1)[0] ?? '';
  return isDerivedTreeName(first) || spillIdFromPath(id) !== null;
}
