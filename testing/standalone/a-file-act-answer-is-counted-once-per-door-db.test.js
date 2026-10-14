/**
 * A refusal a door gives is counted ONCE on every door: `ythril_file_act_answers_total{code}` moves by exactly one for one answer, whether
 * the caller asked REST `PATCH`, `POST /api/<tool>` or MCP (bundle-44, D-29, Q-437, Q-438; ruling 35).
 *
 * ## Why this is a door test
 *
 * `a-file-act-answer-is-counted-by-its-code` calls `fileActAnswer` itself and holds that ONE call counts once. The doors are what a caller
 * reaches, and they are not one function: the REST route answers a failure through `sendCaughtFailure`, the tools router runs the MCP tool
 * the REST route names and answers what it throws, and MCP's dispatcher answers a tool's throw. A door that answered through the module
 * twice (the tools router delegating to a handler that already answered), or around it, would double-count or miss every refusal of that
 * door, and no test that calls the module sees it. So the series is read before and after one real request per door, for the two refusals a
 * caller is most likely to meet: a move onto an occupied destination and a directory delete without `confirm`.
 *
 * What it does not hold is the count of a retried request: a retry is another answer.
 *
 * Run: node --test testing/standalone/a-file-act-answer-is-counted-once-per-door-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { MOVE_DOORS } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'oncecounted';
const COUNTER = 'ythril_file_act_answers_total';

let acts, registry;

/** The counter's value for one `code`, read from a scrape as an operator reads it. */
async function counted(code) {
  const text = await registry.register.getSingleMetricAsString(COUNTER);
  for (const line of text.split('\n')) {
    const m = /^ythril_file_act_answers_total\{(?:[^}]*,)?code="([a-z_]+)"(?:,[^}]*)?\}\s+(\S+)$/.exec(line);
    if (m && m[1] === code) return Number(m[2]);
  }
  throw new Error(`${COUNTER}{code="${code}"} is not on the scrape`);
}

/** The delete of a directory without `confirm`, on a door. */
const deleteDirectory = (via, p) => acts.del(via, p);

describe('a file act\'s refusal is counted once on every door (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'oncecounted', space: S });
    registry = await import('../../server/dist/metrics/registry.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  for (const via of MOVE_DOORS) {
    it(`${via}: a move onto an occupied destination is one destination_exists, counted once, and nothing else is counted`, async () => {
      await acts.seed('a.txt');
      await acts.seed('b.txt');
      const before = { exists: await counted('destination_exists'), others: {} };
      for (const code of ['path_blocked', 'destination_held_after_move', 'move_still_owed', 'act_not_recorded', 'file_system_fault', 'confirm_required']) before.others[code] = await counted(code);

      const answer = await acts.move(via, 'a.txt', 'b.txt');

      assert.equal(acts.answerOf(answer).code, 'destination_exists', `fixture: the ${via} door did not refuse the move as an occupied destination`);
      assert.equal(await counted('destination_exists') - before.exists, 1, `the ${via} door counted the refusal ${await counted('destination_exists') - before.exists} time(s), not once`);
      for (const [code, was] of Object.entries(before.others)) assert.equal(await counted(code), was, `the ${via} door moved the series of ${code}, which it did not answer`);
    });

    it(`${via}: a directory delete without confirm is one confirm_required, counted once`, async () => {
      await acts.seed('dir/x.txt');
      const before = await counted('confirm_required');

      const answer = await deleteDirectory(via, 'dir');

      assert.equal(acts.answerOf(answer).code, 'confirm_required', `fixture: the ${via} door did not refuse the delete: ${JSON.stringify(answer.body ?? answer.text)}`);
      assert.equal(await counted('confirm_required') - before, 1, `the ${via} door counted the refusal ${await counted('confirm_required') - before} time(s), not once`);
    });
  }
});
