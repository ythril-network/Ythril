/**
 * `rdfMembers` itself skips every space the caller cannot read in the knowledge area, so a door that forgets the guard cannot widen a read
 * (bundle-271, Q-756, S1 review m5; design r2 R1.1, R1.2).
 *
 * ## What it prevents
 *
 * The helper trusted every door to hand it only spaces its guard had accepted: it checked `files: read` per member and nothing of
 * `knowledge: read`. A door (the quad source's, a Linked Data address's, a later one's) that handed it a space the caller reaches only by
 * another area, or not at all, read that space's records and named it in `leftOut`. The helper now asks the one question
 * (`mayReadArea(rights, space, 'knowledge')`, the area a view's members are narrowed by) itself:
 *
 * - a member the caller cannot read in the knowledge area is neither a member nor named in `leftOut` (naming it would tell a caller which
 *   spaces exist and what state their RDF settings are in);
 * - a caller with no rights reads nothing; an instance administrator reads every member;
 * - the quad source, which asks the helper, answers nothing of such a space and names it nowhere.
 *
 * ## Seen red
 *
 * On c647bd24f the helper hands back every space it is given: the token with `knowledge: none` on `B` gets `B` as a member, and the source
 * reads its records. Mutation: the guard dropped from the helper.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/the-rdf-member-helper-reads-only-what-its-caller-may-read-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openQuadSourceFixture, A, B, baseOf, quadText, drain } from './_quad-source-fixture.mjs';

const skip = await mongoSkipReason();

let fx, members, quadSource, readsA, filesOnlyB, noRights, instanceAdmin;

const spacesOf = (caller, spaces = [A, B]) => needModule(members, ['rdfMembers'], 'the member helper').rdfMembers(spaces, caller);

describe('the member helper reads only the spaces its caller may read in the knowledge area', { skip }, () => {
  before(async () => {
    fx = await openQuadSourceFixture('qsrc-members');
    members = await loadDistModule('../../server/dist/rdf/rdf-members.js', import.meta.url);
    quadSource = await loadDistModule('../../server/dist/rdf/quad-source.js', import.meta.url);
    // Knowledge on A only; on B the caller reaches the space by files alone.
    readsA = (await fx.d.mint('qsrc-members-a', { [A]: fx.d.row({ knowledge: 'read' }), [B]: fx.d.row({ knowledge: 'none', files: 'read' }) })).record;
    filesOnlyB = (await fx.d.mint('qsrc-members-files', { [A]: fx.d.row({ knowledge: 'none', files: 'read' }), [B]: fx.d.row({ knowledge: 'none', files: 'read' }) })).record;
    noRights = { id: 'no-rights', rights: null };
    instanceAdmin = { id: 'admin', rights: { instanceAdmin: true, perSpace: {} } };
  });
  after(async () => { await fx?.d.close(); });

  it('control: a caller reading both spaces is given both, in the order named', () => {
    const got = spacesOf(fx.reader);
    assert.deepEqual(got.members.map(m => m.space), [A, B]);
    assert.deepEqual(got.leftOut, []);
  });

  it('a space the caller cannot read in the knowledge area is no member and is named nowhere', () => {
    const got = spacesOf(readsA);
    assert.deepEqual(got.members.map(m => m.space), [A], 'B was given to a caller with no knowledge rung there');
    assert.deepEqual(got.leftOut.map(l => l.space), [], 'B is named in leftOut, which says it exists and how its RDF is settled');
    const none = spacesOf(filesOnlyB);
    assert.deepEqual(none.members, [], 'a caller with files: read alone was given a member');
    assert.deepEqual(none.leftOut, []);
  });

  it('a caller with no rights reads nothing; an instance administrator reads every member', () => {
    assert.deepEqual(spacesOf(noRights).members, []);
    assert.deepEqual(spacesOf(undefined).members, []);
    assert.deepEqual(spacesOf(instanceAdmin).members.map(m => m.space), [A, B]);
  });

  it('the quad source over both spaces answers nothing of the one its caller cannot read, and names it nowhere', async () => {
    const { createQuadSource } = needModule(quadSource, ['createQuadSource'], 'the quad source');
    const source = createQuadSource({ members: [A, B], caller: readsA }, { deadline: Date.now() + 60_000 });
    const got = await drain(source.match(undefined, undefined, undefined, undefined));
    assert.ok(got.length > 0, 'the source answered nothing of the space the caller reads');
    assert.deepEqual([...new Set(got.map(q => q.graph.value))], [baseOf(A)], 'statements of a space the caller cannot read were answered');
    assert.deepEqual(got.map(quadText).filter(t => t.includes(baseOf(B))), []);
    assert.deepEqual(source.leftOut(), [], 'the source names the space it left out');
    assert.deepEqual(source.filesWithheld(), [A], 'only the member it reads is asked about files');
  });
});
