/**
 * A value a peer sent cannot forge a line in this instance's log (`Q-107` part 1, pre-ship security pass).
 *
 * ## The rule
 *
 * The arrival path names what it did not store — document ids, the reason each was refused (built from the
 * document), the peer — so an operator can find them. Interpolated raw, an `_id` of `x\r\nFORGED [ERROR] ...`
 * ends the warning and prints a second line that reads exactly like this server's own: log injection, through the
 * one channel an operator trusts to say what happened. Every such value goes through `logSafe` (`util/log.ts`),
 * which writes control characters as their escapes.
 *
 * Asserted over the log lines the server actually emits (the in-process ring), for the refusal paths a peer can
 * steer: a document refused by the arrival writer's shape check, and one refused by the wire schema.
 *
 * Seen red by mutation, restored by hand: `logSafe` bypassed in `warnArrivalsNotStored`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-peer-value-cannot-forge-a-log-line-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const S = 'pushforge';
const FORGED = 'FORGED [ERROR] this line was written by a peer';
let door, logMod;

/** Every line the server logged while `fn` ran, split the way a log reader splits them (`_log-lines.mjs`). */
const linesDuring = async (fn) => (await logLinesDuring(fn)).lines;

describe('a peer value cannot forge a log line', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushforge', spaces: [{ id: S, label: 'Forge', folders: [], meta: {} }] });
    logMod = await import('../../server/dist/util/log.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('logSafe escapes every line-breaking character and leaves ordinary text alone', () => {
    const { logSafe } = logMod;
    assert.equal(logSafe('plain id-1'), 'plain id-1');
    assert.equal(logSafe('a\r\nb'), 'a\\r\\nb');
    assert.doesNotMatch(logSafe('x\u2028y\u001bz\u0085w'), /[\u2028\u001b\u0085]/);
  });

  for (const [label, page] of [
    ['a document the arrival writer refuses (an implausible seq)', async () => {
      const { MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js');
      return { facts: [build.fact(S, `poison\r\n${FORGED}`, MAX_INGEST_SEQ + 1)] };
    }],
    ['a document the wire schema refuses (no fact text)', async () => {
      const bad = build.fact(S, `misfit\r\n${FORGED}`, 5);
      delete bad.fact;
      return { facts: [bad] };
    }],
  ]) {
    it(`${label}: its id is named, escaped, and starts no line of its own`, async () => {
      const body = await page();
      const lines = await linesDuring(async () => {
        const r = await door.push('/batch-upsert', body, { spaceId: S });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(r.body.facts.rejected, 1, 'fixture check: the document was not refused, so nothing was logged');
      });
      assert.ok(lines.some(l => l.includes('FORGED')), 'fixture check: the refusal was not logged at all');
      const forged = lines.filter(l => l.startsWith('FORGED'));
      assert.deepEqual(forged, [], 'a peer-supplied id started a log line of its own — log injection');
      assert.ok(lines.some(l => l.includes('\\r\\nFORGED')), 'the id was not shown escaped, so an operator cannot see what was sent');
    });
  }
});
