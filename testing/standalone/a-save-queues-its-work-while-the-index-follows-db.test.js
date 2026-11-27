/**
 * A record save does the work owed after its write (link rows, the embedding job) while the triple index follows the write, and still
 * answers only after both (bundle-378, Q-976 S3, contract rows 2, 3 and 4).
 *
 * ## The rule
 *
 * At BSBM 1 000 a fact save took about 130 ms: `version` 15, `write` 12, `index` 84 (the triple index's follower, run after the write's
 * landing hold settles) and `after` 11 (the embedding job), one after the other. The follower and the work after the write both need only
 * the landed write, not each other, so the commit (`commitPlans`, every record door's and kind's one write path) now starts the work after
 * the write while the follower runs, and waits for both before it returns.
 *
 * The cost assertion: the save's embedding job is sent to the store before the follower's last command (its lease release on `rdf_state`).
 * Before the cut the job is sent only after the follower has ended.
 *
 * ## The guarantee the cut must keep
 *
 * A save answers only after its write is confirmed and the index has it: when the door answers, the record is stored, its embedding job was
 * sent before the answer, the follower's last command was sent before the answer, and the index's applied position is at or above the
 * record's position with the index ready. On REST and on MCP.
 *
 * ## Seen red
 *
 * On 17dce733e the embedding job is written after the follower released its lease.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-save-queues-its-work-while-the-index-follows-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { followUntilReady, landAll, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';
import { mcpCallResult } from './_server-timing.mjs';

const skip = await mongoSkipReason();
const S = 'q976-save-beside';
const JSON_TYPE = { 'Content-Type': 'application/json' };

let d, writer;

/** The position of command `pred` in `commands`, first or last. */
const firstAt = (commands, pred) => commands.findIndex(pred);
const lastAt = (commands, pred) => { const i = [...commands].reverse().findIndex(pred); return i < 0 ? -1 : commands.length - 1 - i; };
/** The embedding job's write (an upsert on the space's job collection). */
const onEmbedJobs = c => /^(update|insert) /.test(c) && c.split(' ')[1] === `${S}_embed_jobs`;
/** The follower's writes of its state row and lease (its last is the lease release); a read of the row (this file's own) is not one. */
const onIndexState = c => c.split(' ')[1] === `${S}_rdf_state` && !/^(find|getMore|aggregate) /.test(c);
/** The read this file sends the moment the door has answered: every command before it was sent before the answer. */
const MARKER = `${S}_answered`;
const onMarker = c => c === `find ${MARKER}`;

/** Mark the answer in the command log, then read what the store holds for the record: its position, and the index's state. */
async function heldAfterAnswer(collection, id) {
  await d.col(MARKER).findOne({});
  const rec = await d.col(`${S}_${collection}`).findOne({ _id: id });
  const state = await d.col(`${S}_rdf_state`).findOne({ _id: 'state' });
  return { rec, state };
}

function assertHeld({ rec, state }, what) {
  assert.ok(rec, `${what}: the record is stored when the door answers`);
  assert.equal(state?.status, 'ready', `${what}: the index is ready when the door answers: ${JSON.stringify(state)}`);
  assert.ok(typeof rec.pos === 'number' && state.appliedPos >= rec.pos,
    `${what}: the index has the write when the door answers (appliedPos ${state?.appliedPos}, record pos ${rec.pos})`);
}

/** The order the save's commands were sent in: its embedding job before the follower's end (the cut) and before the answer (the guarantee). */
function assertOrder(commands, what) {
  const job = firstAt(commands, onEmbedJobs);
  const followerEnd = lastAt(commands, onIndexState);
  const answered = firstAt(commands, onMarker);
  assert.ok(job >= 0 && followerEnd >= 0 && answered >= 0, `${what}: the save wrote an embed job and ran the follower: ${commands.join('; ')}`);
  assert.ok(job < answered, `${what}: the embedding job (command ${job}) was queued after the door answered (command ${answered})`);
  assert.ok(followerEnd < answered, `${what}: the follower (last command ${followerEnd}) ran on after the door answered (command ${answered})`);
  assert.ok(job < followerEnd,
    `${what}: the embedding job (command ${job}) waited for the follower to end (its last command ${followerEnd}): ${commands.join('; ')}`);
}

describe('a save queues its work while the index follows', { skip }, () => {
  before(async () => {
    // Embeddings on (the RDF doors suppress them by default): a save then owes an embedding job, the work after the write this file times.
    d = await openSparqlDoors({ suite: 'q976-save-beside', spaces: [{ id: S, meta: rdfMeta(S, { suppressEmbeddings: false }) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    writer = await d.mint('q976-save-beside-writer', { [S]: d.row({ knowledge: 'write', files: 'read' }) });
    await landAll(d, S, [['entities', entityDoc(S, 'seed0', 'Seed zero', 'thing')]]);
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('a REST fact save sends its embedding job before the follower ends, and answers after both', async () => {
    let r;
    const commands = await d.door.commandsDuring(async () => {
      r = await d.sparqlRest(writer.key, 'POST', `/api/brain/spaces/${S}/facts`, { body: JSON.stringify({ fact: 'beside the follower', tags: [] }), headers: JSON_TYPE });
      assert.equal(r.status, 201, r.text.slice(0, 300));
      assertHeld(await heldAfterAnswer('facts', r.body._id), 'REST save_fact');
    });
    assertOrder(commands, 'REST save_fact');
  });

  it('an MCP fact save sends its embedding job before the follower ends, and answers after both', async () => {
    let result;
    const commands = await d.door.commandsDuring(async () => {
      result = await mcpCallResult(d.server.url, writer.key, 'save_fact', { space: S, fact: 'beside the follower over mcp', checkDuplicates: false });
      assert.ok(result && !result.isError && !result.error, `save_fact failed: ${JSON.stringify(result).slice(0, 300)}`);
      const id = result.structuredContent?._id ?? JSON.parse(result.content?.[0]?.text ?? '{}')._id;
      assert.ok(id, `the answer names the record: ${JSON.stringify(result).slice(0, 300)}`);
      assertHeld(await heldAfterAnswer('facts', id), 'MCP save_fact');
    });
    assertOrder(commands, 'MCP save_fact');
  });
});
