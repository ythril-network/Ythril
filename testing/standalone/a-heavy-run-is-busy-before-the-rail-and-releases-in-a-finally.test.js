/**
 * `heavyRunner` (`server/src/rate-limit/heavy-run.ts`) is the guard every door that starts a heavy run over a space's stored data goes
 * through — the stored-data schema check and the file stamp report — and what it guarantees is an ORDER and a `finally`, which a
 * hand-written copy drops one of:
 *
 * 1. **Busy is answered `409` BEFORE the rail is charged.** A call that finds the space already running this job costs the caller no
 *    slot: a client retrying against a busy space must not burn its five a minute on refusals.
 * 2. **Over the rail is `429`**, with the job's own sentence, and the work never starts — so the space is not claimed either.
 * 3. **The claim is released in a `finally`.** A run that throws leaves the space claimable; released only on success, the space is
 *    "already running" for ever after the first run that fails.
 * 4. Each job keeps its own flight: a runner per job, so one job's run does not make another's space busy.
 *
 * Pure: the rail is the module's own, keyed by caller, so every case takes a caller key no other case uses.
 *
 * Run: node --test testing/standalone/a-heavy-run-is-busy-before-the-rail-and-releases-in-a-finally.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { heavyRunner } = await import('../../server/dist/rate-limit/heavy-run.js');
const { HEAVY_CALLS_PER_WINDOW } = await import('../../server/dist/rate-limit/heavy-tool.js');

const REFUSALS = { busy: 'busy: this job is already running for the space', limited: 'limited: over the rail' };
let serial = 0;
const caller = () => `heavy-run-test-${process.pid}-${++serial}`;
/** A job whose work waits until `release()` — to hold a space claimed while another call arrives. */
function held() {
  let release;
  const gate = new Promise(r => { release = r; });
  let started;
  const running = new Promise(r => { started = r; });
  return { work: async () => { started(); await gate; return 'done'; }, release, running };
}

describe('heavyRunner: busy before the rail, over the rail refused, the claim released in a finally', () => {
  it('a space that is busy answers 409 and costs the caller no slot on the rail', async () => {
    const runner = heavyRunner();
    const holder = held();
    const first = runner.run('space-a', caller(), REFUSALS, holder.work);
    await holder.running;

    const retrying = caller();
    const refused = await runner.run('space-a', retrying, REFUSALS, async () => assert.fail('work ran against a busy space'));
    assert.deepEqual(refused, { ok: false, status: 409, error: REFUSALS.busy });

    // The retrying caller still holds every slot: had the 409 charged one, the last of these would be a 429.
    for (let i = 0; i < HEAVY_CALLS_PER_WINDOW; i++) {
      const ran = await runner.run(`space-free-${i}`, retrying, REFUSALS, async () => i);
      assert.deepEqual(ran, { ok: true, value: i }, `run ${i + 1} of ${HEAVY_CALLS_PER_WINDOW} after a busy refusal: the refusal charged the rail`);
    }
    holder.release();
    assert.deepEqual(await first, { ok: true, value: 'done' });
  });

  it('a caller over the rail answers 429 with the job\'s sentence, the work never starts and the space is not claimed', async () => {
    const runner = heavyRunner();
    const spender = caller();
    for (let i = 0; i < HEAVY_CALLS_PER_WINDOW; i++) {
      assert.equal((await runner.run(`space-spent-${i}`, spender, REFUSALS, async () => i)).ok, true);
    }
    let started = false;
    const refused = await runner.run('space-b', spender, REFUSALS, async () => { started = true; });
    assert.deepEqual(refused, { ok: false, status: 429, error: REFUSALS.limited });
    assert.equal(started, false, 'the work ran for a caller over the rail');
    // Not claimed: another caller runs the same space at once, and is not told it is busy.
    const other = await runner.run('space-b', caller(), REFUSALS, async () => 'ran');
    assert.deepEqual(other, { ok: true, value: 'ran' }, 'a refused call left the space claimed');
  });

  it('a run that throws releases the space: the error reaches the caller and the next run is not 409', async () => {
    const runner = heavyRunner();
    await assert.rejects(() => runner.run('space-c', caller(), REFUSALS, async () => { throw new Error('the walk failed'); }), /the walk failed/);
    const next = await runner.run('space-c', caller(), REFUSALS, async () => 'again');
    assert.deepEqual(next, { ok: true, value: 'again' }, 'a run that threw left the space "already running"');
  });

  it('a run that finishes releases the space, and a different space is never busy because of it', async () => {
    const runner = heavyRunner();
    const holder = held();
    const first = runner.run('space-d', caller(), REFUSALS, holder.work);
    await holder.running;
    const elsewhere = await runner.run('space-e', caller(), REFUSALS, async () => 'ran');
    assert.deepEqual(elsewhere, { ok: true, value: 'ran' }, 'one space\'s run made another space busy');
    holder.release();
    await first;
    assert.deepEqual(await runner.run('space-d', caller(), REFUSALS, async () => 'again'), { ok: true, value: 'again' });
  });

  it('each job keeps its own flight: a runner per job, so a run of one does not make the same space busy for another', async () => {
    const check = heavyRunner();
    const report = heavyRunner();
    const holder = held();
    const first = check.run('space-f', caller(), REFUSALS, holder.work);
    await holder.running;
    assert.deepEqual(await report.run('space-f', caller(), REFUSALS, async () => 'report'), { ok: true, value: 'report' });
    holder.release();
    await first;
  });
});
