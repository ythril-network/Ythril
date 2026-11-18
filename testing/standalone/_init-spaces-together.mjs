/**
 * Initialise the spaces of a test door a few at a time, and fail the setup when any one fails (bundle-348).
 *
 * ## Why a module
 *
 * `openPushDoor` (`_push-door.mjs`) and `openB81cDoor` (`_b81c-door.mjs`) each initialised their spaces one after another before the first case ran, which
 * for a door that opens many spaces (a pull case needs a new space each) was most of a file's time. Both now ask this one function. It imports nothing
 * but the pool, so `_b81c-door.mjs`, which must set its config path before any server module loads, can import it, and a test of it needs no database.
 *
 * ## What it prevents
 *
 * A failed initialisation that goes unseen, or leaves work running. The first space to fail stops any further one from starting, the ones already running
 * are awaited to the end (so the door's teardown closes the database client with no initialisation in flight on it, which would keep the process alive),
 * and that first failure is thrown as it is. The pool is given a job that never rejects for the same reason (`pool.mjs`). The product initialises a space
 * on its own when a space is created, and two admins can create two at once, so initialising a few together is a state the product reaches.
 */
import { poolEach } from '../_shared/pool.mjs';

/** How many spaces are initialised at once: each is a run of index builds against the harness database, independent of the others. */
export const INIT_WIDTH = 4;

/**
 * @param {readonly string[]} ids  the space ids to initialise
 * @param {(id: string, options: { waitForVectorReady: boolean }) => Promise<unknown>} initSpace  the server's own `initSpace`
 */
export async function initSpacesTogether(ids, initSpace) {
  let failed = null;
  await poolEach(ids, INIT_WIDTH, async (id) => {
    if (failed) return;
    try { await initSpace(id, { waitForVectorReady: false }); } catch (error) { failed ??= { error }; }
  });
  if (failed) throw failed.error;
}
