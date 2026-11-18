/**
 * A test door that initialises its spaces together still fails its setup when one of them fails, and the failure leaves nothing running (bundle-348).
 *
 * ## The defect this refuses
 *
 * `openPushDoor` and `openB81cDoor` initialise their spaces a few at a time (`_init-spaces-together.mjs`). Done carelessly that has three ways to go wrong,
 * each of which leaves every file green until a setup fails for real: the failure is swallowed (the door opens on a space that has no indexes, and the
 * cases fail later for another reason, or pass for none); further spaces keep starting after one has failed (work the failed setup does not need, on a
 * database it is about to close); or the failure is thrown while other initialisations are still running (the teardown closes the client under them, a
 * reconnect leaves a socket open and the test process never exits, as in PR #1475).
 *
 * ## The rule
 *
 * With a planted initialiser that fails for one id among many, `initSpacesTogether` rejects with that failure, as it is; no initialisation is started
 * after the failure beyond the ones already running; and none is still running when it rejects. `problemsOf(init)` says which of these a function breaks, as
 * strings, so the planted wrong functions below prove each is named. Needs no database: the initialiser is the test's own.
 *
 * Run: node --test testing/standalone/a-failed-space-initialisation-fails-the-door-and-starts-no-further-one.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initSpacesTogether, INIT_WIDTH } from './_init-spaces-together.mjs';
import { poolEach } from '../_shared/pool.mjs';

const TOTAL = 40;
const FAILING = 9;
const ids = Array.from({ length: TOTAL }, (_, i) => `space-${i}`);

/** A planted `initSpace`: yields a few times so initialisations overlap, fails for `ids[failAt]` when given one, and records what it saw. */
function planted(failAt) {
  const seen = { started: [], running: 0, peak: 0, atFailure: undefined };
  const error = new Error('planted: this space cannot be initialised');
  async function initSpace(id) {
    seen.started.push(id);
    seen.running++;
    seen.peak = Math.max(seen.peak, seen.running);
    try {
      for (let i = 0; i < 3; i++) await null;
      if (failAt !== undefined && id === ids[failAt]) {
        seen.atFailure = seen.started.length;
        throw error;
      }
    } finally { seen.running--; }
  }
  return { initSpace, seen, error };
}

/** What is wrong with `init(ids, initSpace)` as a way to initialise the spaces of a door, as strings; nothing when it holds. */
async function problemsOf(init) {
  const out = [];
  const { initSpace, seen, error } = planted(FAILING);
  let thrown = null;
  try { await init(ids, initSpace); } catch (e) { thrown = { e }; }
  if (!thrown) out.push('the failure was swallowed: the setup went on');
  else if (thrown.e !== error) out.push(`it threw something other than the initialiser's own failure: ${String(thrown.e)}`);
  if (seen.running > 0) out.push(`${seen.running} initialisation(s) still running when it settled`);
  if (seen.atFailure !== undefined && seen.started.length > seen.atFailure + INIT_WIDTH - 1) {
    out.push(`${seen.started.length - seen.atFailure} space(s) started after the failure, more than the ${INIT_WIDTH - 1} already running beside it`);
  }
  if (seen.started.length >= TOTAL) out.push('every space was started although one had failed');
  return out;
}

describe('a failed space initialisation fails the door and starts no further one', () => {
  it('initialises every space once, together, and never more than INIT_WIDTH at once', async () => {
    const { initSpace, seen } = planted(undefined);
    await initSpacesTogether(ids, initSpace);
    assert.deepEqual([...seen.started].sort(), [...ids].sort(), 'a space was initialised twice or not at all');
    assert.ok(seen.peak > 1, 'the spaces were initialised one after another');
    assert.ok(seen.peak <= INIT_WIDTH, `${seen.peak} initialisations at once, more than INIT_WIDTH`);
  });

  it('a failure among many rejects with that failure, starts no further space and leaves none running', async () => {
    assert.deepEqual(await problemsOf(initSpacesTogether), []);
  });

  it('no spaces to initialise starts nothing and is not an error', async () => {
    const { initSpace, seen } = planted(undefined);
    await initSpacesTogether([], initSpace);
    assert.deepEqual(seen.started, []);
  });

  describe('the check names each way a function can get this wrong', () => {
    const swallowing = (list, initSpace) => poolEach(list, INIT_WIDTH, async (id) => { try { await initSpace(id, {}); } catch { /* swallowed */ } });
    const keepsStarting = async (list, initSpace) => {
      let failed = null;
      await poolEach(list, INIT_WIDTH, async (id) => { try { await initSpace(id, {}); } catch (e) { failed ??= { e }; } });
      if (failed) throw failed.e;
    };
    const abandons = (list, initSpace) => poolEach(list, INIT_WIDTH, id => initSpace(id, {}));

    it('a function that swallows the failure is named', async () => {
      assert.ok((await problemsOf(swallowing)).some(p => /swallowed/.test(p)));
    });

    it('a function that starts every space after a failure is named', async () => {
      const problems = await problemsOf(keepsStarting);
      assert.ok(problems.some(p => /started after the failure/.test(p)), problems.join('; '));
      assert.ok(problems.some(p => /every space was started/.test(p)), problems.join('; '));
    });

    it('a function that rejects while other initialisations still run is named', async () => {
      const problems = await problemsOf(abandons);
      assert.ok(problems.some(p => /still running when it settled/.test(p)), problems.join('; '));
    });
  });
});
