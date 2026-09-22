/**
 * The refusal that blocks an entity delete says what it actually checked, and says it once for both doors.
 *
 * ## The report
 *
 * The fleet integrator, 2026-08-30T2137Z §2: their queue rows carry only OUTBOUND edges — `instance-of` and
 * `executes`, both pointing FROM the row — and `DELETE` refused them with *"entity has inbound references"*.
 * They filtered on `to`, found nothing, and kept 409ing until they asked for both directions.
 *
 * The guard is right and is not changing: an edge left pointing FROM a deleted entity dangles exactly as much
 * as one pointing at it, and `findEntityReferences` queries both ends. What was wrong was every sentence
 * describing it — the error message, the function's name, its docblock, and the integration guide all said
 * inbound. A reader who checked our source to resolve the message's ambiguity was told the same wrong thing a
 * second time.
 *
 * ## And the two doors did not agree either
 *
 * REST answered `409 {error: 'Cannot delete: entity has inbound references', backlinks: [{type, _id}]}`. MCP
 * threw `Cannot delete entity '<id>': still referenced by edge <id>, memory <id>` — a different sentence, no
 * structured rows at all, and the ids reachable only by parsing prose. One rule, two implementations, and each
 * caller's experience depending on which client they picked. Both doors also carried their own copy of the
 * face-row filter.
 *
 * So the blocking set, its wording and the face exemption are computed in ONE place and both doors report what
 * it returns.
 *
 * ## What the rows have to carry
 *
 * The direction, per row, because that is what the reporter actually needed: it tells them which query clears
 * it. Only an EDGE has ends — a memory, chrono entry or file is a holder of a reference, not an endpoint — so
 * `end` is absent on those rather than guessed at, and a self-loop reports `both`.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-delete-refusal-names-the-end-it-checked-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-delete-refusal-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const SUBJECT = 'aaaaaaaa-0000-4000-8000-00000000da7a';
const OTHER = 'aaaaaaaa-0000-4000-8000-00000000b0b0';

let mongo, guardMod, loader, linksMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

const entity = (id, name) => ({ _id: id, spaceId: SPACE, name, type: 'task', tags: [], seq: 1 });

describe('the delete refusal names the end it checked', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('deleterefusal');
    loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'delete-refusal-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true, meta: { strictLinkage: true } }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    guardMod = await import('../../server/dist/brain/entity-delete-guard.js');
    linksMod = await import('../../server/dist/brain/links.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'files', 'links']) await coll(c).deleteMany({});
    await coll('entities').insertMany([entity(SUBJECT, 'Subject'), entity(OTHER, 'Other')]);
  });

  const edge = (id, from, to) => coll('edges').insertOne({
    _id: id, spaceId: SPACE, from, to, label: 'executes', tags: [], seq: 1,
  });

  it('the guard is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof guardMod.entityDeleteBlockers, 'function');
  });

  it('nothing points at it — no block at all', async () => {
    assert.equal(await guardMod.entityDeleteBlockers(SPACE, SUBJECT), null);
  });

  it('an OUTBOUND-only edge blocks, and the row says so', async () => {
    // The reporter's case exactly: nothing points AT the row, and the delete is still refused. Correctly —
    // the edge would dangle either way — but they had to be told which end matched.
    await edge('e-out', SUBJECT, OTHER);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.ok(block, 'an outbound edge did not block, so the guard checks one direction');
    assert.deepEqual(block.backlinks, [{ type: 'edge', _id: 'e-out', end: 'from' }]);
  });

  it('an INBOUND-only edge blocks, and the row says the other end', async () => {
    await edge('e-in', OTHER, SUBJECT);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.deepEqual(block.backlinks, [{ type: 'edge', _id: 'e-in', end: 'to' }]);
  });

  it('a self-loop reports BOTH, rather than picking one', async () => {
    // One document, two matching ends. Reporting `from` alone would send a caller looking for an edge whose
    // other end is the same record.
    await edge('e-self', SUBJECT, SUBJECT);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.deepEqual(block.backlinks, [{ type: 'edge', _id: 'e-self', end: 'both' }]);
  });

  it('a memory that holds the reference carries NO end, because it is not an endpoint', async () => {
    // The distinction is the point. An edge has ends; a memory has a list. Labelling the memory `to` would be
    // inventing a direction, and a caller would look for an edge that does not exist.
    await coll('facts').insertOne({
      _id: 'm-1', spaceId: SPACE, fact: 'about the subject', tags: [], seq: 1,
    });
    // Through the writer, not by hand: a link's id is derived from the pair and the class, and a row with
    // an invented id is one nothing else in the system could find.
    await linksMod.reconcileLinks(SPACE, 'm-1', 'fact', { entity: [SUBJECT] },
      { instanceId: 'delete-refusal-test', instanceLabel: 'test' });
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.deepEqual(block.backlinks, [{ type: 'fact', _id: 'm-1' }]);
  });

  it('the message does not claim a direction', async () => {
    /*
     * The sentence the whole report was about. It said "inbound references" while the query checked both ends,
     * and three other statements agreed with it — so nothing a reader could consult would have corrected them.
     */
    await edge('e-out', SUBJECT, OTHER);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.doesNotMatch(block.message, /inbound|outbound/i,
      'the refusal names a direction again, and the query still checks both ends');
    assert.match(block.message, /reference/i, 'and it still has to say what the problem is');
  });

  it('and says a cascade is not available, because four probes were spent discovering that', async () => {
    // `?cascade=true`, `?force=true`, `?deleteEdges=true`, `?withEdges=true` — all four were ignored rather
    // than refused, so an unknown parameter and a typo behaved identically.
    await edge('e-out', SUBJECT, OTHER);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.match(block.message, /cascade/i,
      'the refusal does not say a cascade is unavailable, so the next caller probes for one');
  });

  it('a face label is reported but does NOT block', async () => {
    /*
     * The exemption both doors had their own copy of, and it is deliberate: `deleteEntity` unlabels faces in
     * the same operation, so they cannot dangle — and blocking on them would make "delete this person" the one
     * thing an operator cannot do for the subject whose data is biometric.
     */
    await coll('files').insertOne({ _id: 'f.jpg#face-chunk0', spaceId: SPACE, faceEntityId: SUBJECT, seq: 1 });
    assert.equal(await guardMod.entityDeleteBlockers(SPACE, SUBJECT), null,
      'a face label blocked the delete, which makes an entity with recognised photos undeletable');
  });

  it('a face label alongside a real blocker does not disappear from the report', async () => {
    // Reported, never blocking — so a UI can warn "this will unlabel N faces". Filtering it out of the ROWS
    // as well as out of the verdict would lose that.
    await coll('files').insertOne({ _id: 'f.jpg#face-chunk0', spaceId: SPACE, faceEntityId: SUBJECT, seq: 1 });
    await edge('e-out', SUBJECT, OTHER);
    const block = await guardMod.entityDeleteBlockers(SPACE, SUBJECT);
    assert.ok(block.backlinks.some(b => b.type === 'face'), 'the face row was filtered out of the report too');
    assert.ok(block.blocking.every(b => b.type !== 'face'), 'a face row is in the BLOCKING set');
  });

  it('a space that opted out of strict linkage is not blocked at all', async () => {
    // The escape hatch, and the guard has to consult it rather than leaving that to each door — which is how
    // one door ends up enforcing a setting the other ignores.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'delete-refusal-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true, meta: { strictLinkage: false } }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    try {
      await edge('e-out', SUBJECT, OTHER);
      assert.equal(await guardMod.entityDeleteBlockers(SPACE, SUBJECT), null,
        'strictLinkage: false still blocked, so the opt-out depends on the door');
    } finally {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        instanceId: 'delete-refusal-test', instanceLabel: 'test', tokens: [], networks: [],
        spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true, meta: { strictLinkage: true } }],
      }, null, 2), { mode: 0o600 });
      loader.loadConfig();
    }
  });
});
