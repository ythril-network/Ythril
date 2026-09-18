/**
 * `path` on a `files` read: the exact file, found however the caller spells it.
 *
 * ## Why this is an ARGUMENT and not something a caller writes as a predicate
 *
 * `filter: { path: "docs/a.md" }` has always worked, so the lookup was never the gap. The gap is the
 * NORMALISATION. A path is stored under its doc-id spelling — forward slashes, no leading slash — and the
 * caller rarely holds it in that form: a Windows client hands over `docs\a.md`, a URL-shaped one hands over
 * `/docs/a.md`, and a bare equality finds neither. It finds them SILENTLY, because an empty page reads
 * exactly like "no such file".
 *
 * The file-metadata list route ran `toDocId` on its `?path=` for that reason. Deleting the route (`B-9`
 * step 3b) without carrying the transform across would replace a forgiving read with an exact one that
 * still answers 200 — which is the shape step 3a already paid for once: a route does work around the query,
 * and none of it is visible in the path or the response shape.
 *
 * ## What this module is FOR, and what it deliberately is not
 *
 * One question: *given a `path` argument and a collection, what predicate should run?* It answers that for
 * both doors from one place, so the transform and the refusal cannot drift apart.
 *
 * It does NOT own `includeChunks`. That is a DEFAULT the list route applies (`parentFileId` unset) rather
 * than a transform, a caller can write the predicate itself, and adopting it here would change what every
 * existing `filter` caller gets back. A default is a decision about what somebody meant; this module is
 * about what they said.
 */
import { toDocId } from '../util/paths.js';

/** The schema fragment, spread into the tool's `inputSchema` so neither door spells it twice. */
export const FILE_PATH_SCHEMA = {
  path: {
    type: 'string',
    description: 'The exact file, by path — for `files` only. Spelling is forgiving where it can be '
      + 'without becoming a guess: backslashes are read as separators and a leading slash is ignored, so '
      + '`\\notes\\a.md` and `/notes/a.md` both find `notes/a.md`. It is EXACT after that, not a prefix '
      + 'and not a substring — for those use `search`, which spans the path and the description. A path '
      + 'matching nothing returns nothing rather than everything.',
  },
} as const;

/**
 * The `path` argument as a predicate, or the refusal that says why it cannot apply.
 *
 * `null` means the caller did not ask, which is not the same as asking for nothing — a caller who sent
 * `path: ""` gets `null` too, because an empty path names no file and narrowing to `{path: ""}` would
 * return nothing while looking like a successful filter.
 *
 * **Refused on a collection it cannot mean, never ignored.** A dropped `path` hands back the whole
 * collection to a caller who believes they asked for one file, and both doors say it in the same words so
 * that comparing them never turns into working out whether two wordings mean the same thing.
 */
export function filePathPredicate(
  collection: string,
  raw: unknown,
): { predicate: Record<string, unknown> } | { error: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (collection !== 'files') {
    return {
      error: `path applies to files only, not '${collection}'. It names one file by its stored path; for a `
        + 'substring across a record use `search`.',
    };
  }
  return { predicate: { path: toDocId(raw) } };
}
