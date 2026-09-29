/**
 * How to recognise a spilled read result's PATH — the shape versions before Q-92 wrote into a space's `_tmp/`, and
 * the deprecated `path` field an answer still carries.
 *
 * Its own module because many sides need the one answer and several cannot import each other: the files doors
 * resolve it, sync and the space hash leave it out, the embed queue declines it, and the sweep removes it. The
 * spills themselves live in `read-spill-store.ts`, outside every space.
 */

/**
 * The store root that HELD spilled read results before Q-92 (5.6.0); spills now live in `read-spill-store.ts`,
 * outside every space. Still hidden from browsing (`DERIVED_TREES`) and still declined by the embed queue,
 * because older peers keep writing spills here until they upgrade and the TTL sweep removes them every cycle.
 * END CONDITION: at the next major, delete that hiding, the embed-queue decline, the deprecated `path` and its
 * resolution (`spillPathFor`, `readSpillByPath`), and the sweep, together.
 */
export const SPILL_DIR = '_tmp';

/**
 * Is this path a spilled read result?
 *
 * Only at the ROOT, matching how `hideDerivedTrees` treats `_converted/` and `_extracted/`: a user directory
 * called `_tmp` deeper in the tree is theirs, and their files in it are content like any other.
 */
export function isSpillPath(filePath: string): boolean {
  const normalised = filePath.replace(/^\/+/, '');
  return normalised === SPILL_DIR || normalised.startsWith(`${SPILL_DIR}/`);
}

/**
 * The `path` a spill answer carries: `_tmp/graph-<id>.json` or `_tmp/results-<id>.json`.
 *
 * Since Q-92 no such FILE exists — the spill is in the instance store (`read-spill-store.ts`). The shape is
 * kept, additively, because before that an MCP agent's only road to a spill was `path` + `read_file`, and the
 * files doors resolve it against the store for the issuer. Deprecated: removed at the next major, together
 * with that resolution.
 */
export function spillPathFor(kind: 'graph' | 'results', id: string): string {
  return `${SPILL_DIR}/${kind}-${id}.json`;
}

/**
 * A spill's path, capturing its id. Exported for the one caller that must ask MongoDB rather than a string —
 * the sweep's query over `<space>_files` — so the shape is written once. Everything else calls
 * `spillIdFromPath`, which also normalises separators.
 */
export const SPILL_PATH_RE = /^_tmp\/(?:graph|results)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

/**
 * The spill id a path names, when it is exactly a spill's path at the root of a space; `null` otherwise.
 *
 * THE one test for "is this a spill file" on every path that must treat one specially: the files doors
 * resolve it against the store, sync neither offers nor accepts it, the space hash leaves it out, and the
 * sweep removes the copies written before Q-92. One pattern, so no two of those can disagree about which
 * paths are spills. A user's `notes/_tmp/graph-x.json` is theirs and never matches.
 */
export function spillIdFromPath(filePath: string): string | null {
  const m = SPILL_PATH_RE.exec(filePath.replace(/\\/g, '/').replace(/^\/+/, ''));
  return m ? m[1]!.toLowerCase() : null;
}
