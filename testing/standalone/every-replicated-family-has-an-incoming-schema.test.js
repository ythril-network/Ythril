/**
 * Every replicated family ships under a schema, in ONE table that every door reads (Q-361 item 19, the part of Q-225 a
 * 5.6.x patch carries).
 *
 * ## The defect shape
 *
 * The push parsed each document against its family's `Incoming*` schema, spelled out at nine sites (the four single
 * routes and the batch loop's six), and the pull parsed nothing. A family added later would be one a door never
 * validates, and nothing would say so. `INCOMING_SCHEMA_OF` (`sync/arrival-shape.ts`) is the table, TOTAL over
 * `REPLICATED_FAMILIES` — read out of the family list, never listed here — and the module throws at load when a family
 * has none.
 *
 * ## What is asserted
 *
 * - the table has a row for every replicated family (floor on the family count, so an empty list cannot pass);
 * - `parseIncoming` is the schema's own parse, and a family it does not know is refused, not passed;
 * - `schemaMisses` names a document that fails its schema and nothing that passes, parses a file row AFTER the wire strip
 *   (a real peer's file row carries machinery the strict schema would refuse), and never names a document the writer
 *   refuses for its id;
 * - no push door spells an `Incoming*` schema of its own: they are read through the table.
 *
 * Seen red by hand: a row removed from the table fails the totality case at load; one `IncomingFactDoc.safeParse(` written
 * back into `api/sync/docs.ts` fails the last case; restored by hand.
 *
 * Run: node --test testing/standalone/every-replicated-family-has-an-incoming-schema.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let REPLICATED_FAMILIES, INCOMING_SCHEMA_OF, parseIncoming, schemaMisses;
before(async () => {
  ({ REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js'));
  ({ INCOMING_SCHEMA_OF, parseIncoming, schemaMisses } = await import('../../server/dist/sync/arrival-shape.js'));
});

const AUTHOR = { instanceId: 'peer', instanceLabel: 'Peer' };
const FACT = { _id: 'f', spaceId: 's', fact: 'x', tags: [], author: AUTHOR, createdAt: 't', updatedAt: 't', seq: 3 };
const FILE = { _id: 'docs/a.md', spaceId: 's', path: 'docs/a.md', tags: [], author: AUTHOR, createdAt: 't', updatedAt: 't', seq: 3 };

describe('every replicated family has an incoming schema', () => {
  it('the table is total over the replicated families, which are found', () => {
    assert.ok(REPLICATED_FAMILIES.length >= 6, `only ${REPLICATED_FAMILIES.length} replicated families — the list is broken`);
    const missing = REPLICATED_FAMILIES.map(f => f.payloadKey).filter(k => !INCOMING_SCHEMA_OF.has(k));
    assert.deepEqual(missing, [], 'these families have no row in INCOMING_SCHEMA_OF, so no door validates them');
  });

  it('parseIncoming is the schema\'s own parse, and refuses a family it does not know', () => {
    assert.equal(parseIncoming('facts', FACT).success, true);
    assert.equal(parseIncoming('facts', { ...FACT, tags: 'not a list' }).success, false);
    assert.throws(() => parseIncoming('tombstones', FACT), /not a replicated family/);
  });

  it('schemaMisses names what fails its schema and nothing that passes, with a bounded reason', () => {
    const odd = { ...FACT, _id: 'odd', author: 'not an author block' };
    const huge = { ...FACT, _id: 'huge', tags: ['x'.repeat(50_000)].concat(Array(200).fill('t')) };
    const misses = schemaMisses('facts', [FACT, odd, huge]);
    assert.deepEqual(misses.map(m => m._id), ['odd', 'huge']);
    for (const m of misses) assert.ok(m.reason.length < 1_000, `a ${m.reason.length}-character reason carries the peer's text: ${m.reason.slice(0, 80)}`);
  });

  it('a file row is parsed after the wire strip: a real peer\'s machinery is not a miss, a corrupt parentFileId is', () => {
    const real = { ...FILE, sizeBytes: 9, sha256: 'a'.repeat(64), excerpt: 'x', embedding: [0.1], embeddingModel: 'm', chunkCount: 3 };
    assert.deepEqual(schemaMisses('filemeta', [real]), [], 'a real peer\'s file row was reported as failing its schema');
    assert.deepEqual(schemaMisses('filemeta', [{ ...FILE, _id: 'bad.md', parentFileId: 5 }]).map(m => m._id), ['bad.md']);
  });

  it('a document with no usable id is the writer\'s to refuse, not a schema miss', () => {
    assert.deepEqual(schemaMisses('facts', [{ ...FACT, _id: 12 }, null, 'text', []]), []);
  });

  it('no push door spells an Incoming schema of its own', () => {
    const docs = stripComments(readFileSync('server/src/api/sync/docs.ts', 'utf8'));
    // A code position, not the warning's text, which names the schema a document failed inside a string.
    const spelled = [...docs.matchAll(/\bIncoming(?:Fact|Entity|Edge|Chrono|Link|FileMeta)Doc\b(?!['"`])/g)].map(m => m[0]);
    assert.deepEqual(spelled, [], 'api/sync/docs.ts names an Incoming schema — read it through parseIncoming / INCOMING_SCHEMA_OF');
  });
});
