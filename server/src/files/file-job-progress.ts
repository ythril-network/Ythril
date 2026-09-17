/**
 * A file row's embedding-job STEP PROGRESS, joined per member.
 *
 * Lifted out of `api/brain/file-meta.ts` so `brain/` can reach it: `filter` with `collection: 'files'`
 * returned rows without it, which is a capability the Files tab had and an agent did not — and the route
 * holding the only copy is what step 3 of `B-9` deletes. A `brain/` module must not import from `api/`,
 * so the shared thing lives here rather than being reached back up the tree.
 */
import { fetchJobProgress } from './media/job-queue.js';

/** Statuses worth a progress lookup. Anything else is finished and has nothing left to draw. */
const IN_FLIGHT = new Set(['pending', 'processing']);

/**
 * Decorate a page of file records with their job's step progress.
 *
 * The rule worth pinning is that a page with nothing in flight issues **no query at all**, so the
 * common case — a listing of finished files, which is most listings — does not pay for the rare one.
 * `lookup` is injectable purely so a test can observe that: asserting on the returned records cannot
 * distinguish "did not query" from "queried and got nothing", which is exactly the regression this
 * guards against.
 */
export async function attachJobProgress(
  memberId: string,
  files: Array<Record<string, unknown>>,
  lookup: typeof fetchJobProgress = fetchJobProgress,
): Promise<Array<Record<string, unknown>>> {
  const inFlight = files.filter(f => IN_FLIGHT.has(String(f['embeddingStatus'] ?? '')));
  if (inFlight.length === 0) return files;
  const byId = await lookup(memberId, inFlight.map(f => String(f['_id'])));
  if (byId.size === 0) return files;
  return files.map(f => {
    const view = byId.get(String(f['_id']));
    // A job row with no `progress` yet (claimed, first step not reported) adds nothing — leaving the
    // field absent keeps "we do not know yet" distinct from "the route has no steps".
    return view?.progress ? { ...f, progress: view.progress, progressAt: view.progressAt } : f;
  });
}
