/**
 * Every replicated family ships under a schema, in ONE table that every door reads (Q-361 item 19, the part of Q-225 a
 * 5.6.x patch carries).
 *
 * ## The defect shape
 *
 * The push parsed each document against its family's `Incoming*` schema, spelled out at every site that named one (each
 * single route and each row of the batch loop), and the pull parsed nothing. A family added later would be one a door never
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
 * - a miss's reason is a list of `path: code` and never carries the outside value that failed, whichever field held it
 *   and whatever shape it had (the value is put into every field of every family's document in turn);
 * - no push door spells an `Incoming*` schema of its own: they are read through the table. The schemas are read out of
 *   `api/sync/_shared.ts` (`testing/_shared/incoming-sync-schemas.mjs`), and the doors are every file under
 *   `server/src/api/sync` that registers a POST route.
 *
 * Seen red by hand, restored by hand: a row removed from the table fails the totality case at load; a reason built from
 * the zod message (which quotes the value) fails the reason case; one `Incoming…Doc` written back into a push door of
 * `api/sync` fails the last case.
 *
 * Run: node --test testing/standalone/every-replicated-family-has-an-incoming-schema.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from './_strip-comments.mjs';
import { readTrackedSources } from './_sources.mjs';
import { buildOf } from './_push-door.mjs';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';

let REPLICATED_FAMILIES, INCOMING_SCHEMA_OF, parseIncoming, schemaMisses, shared;
before(async () => {
  ({ REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js'));
  ({ INCOMING_SCHEMA_OF, parseIncoming, schemaMisses } = await import('../../server/dist/sync/arrival-shape.js'));
  shared = await import('../../server/dist/api/sync/_shared.js');
});

/** The outside value of the reason case: recognisable at the front of any cut, and long enough to need one. */
const OUTSIDE = `OUTSIDE-VALUE-${'x'.repeat(4_000)}`;
/** The shapes it takes: as a scalar, inside a list, inside an object. */
const SHAPES = [(v) => v, (v) => [v], (v) => ({ k: v })];
/** A reason is `path: code` entries joined by `; `, then an optional `…(+K more)` — nothing a peer wrote. */
const REASON = /^[^;\s]+: [a-z_]+(?:; [^;\s]+: [a-z_]+)*(?: …\(\+\d+ more\))?$/;

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

  it('schemaMisses names what fails its schema and nothing that passes', () => {
    const odd = { ...FACT, _id: 'odd', author: 'not an author block' };
    const huge = { ...FACT, _id: 'huge', tags: ['x'.repeat(50_000)].concat(Array(200).fill('t')) };
    assert.deepEqual(schemaMisses('facts', [FACT, odd, huge]).map(m => m._id), ['odd', 'huge']);
  });

  it('a reason lists the path and code of each failure and never the outside value, in every field of every family', () => {
    const missedFamilies = new Set();
    for (const { payloadKey: key } of REPLICATED_FAMILIES) {
      const valid = buildOf(key)('s', key === 'filemeta' ? 'docs/a.md' : 'd1', 3);
      assert.deepEqual(schemaMisses(key, [valid]), [], `${key}: the fixture is not a valid document of its family`);
      for (const field of Object.keys(valid).filter(f => f !== '_id')) {   // a document with no usable id is the writer's, not a miss
        for (const shape of SHAPES) {
          const miss = schemaMisses(key, [{ ...valid, [field]: shape(OUTSIDE) }])[0];
          if (!miss) continue;   // the schema accepts this value in this field
          missedFamilies.add(key);
          assert.ok(!miss.reason.includes('OUTSIDE-VALUE'), `${key}.${field}: the reason carries the outside value: ${miss.reason.slice(0, 200)}`);
          assert.match(miss.reason, REASON, `${key}.${field}: the reason is not a list of path: code`);
        }
      }
    }
    assert.deepEqual(REPLICATED_FAMILIES.map(f => f.payloadKey).filter(k => !missedFamilies.has(k)), [],
      'these families never produced a miss, so nothing was asserted about their reasons');
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
    const names = incomingSchemas(shared).map(([name]) => name);
    // A push door is a file of the sync API that registers a POST route; the schemas' own home registers none.
    const doors = readTrackedSources('server/src/api/sync', { floor: 5, untracked: true })
      .map(({ file, text }) => ({ file, code: stripComments(text) }))
      .filter(({ code }) => /\bsync\w*Router\.post\(/.test(code));
    assert.ok(doors.length >= 2, `only ${doors.length} push door file(s) found under api/sync — the derivation is broken`);
    assert.ok(doors.some(({ code }) => /\bparseIncoming\(/.test(code)), 'no push door reads a schema through parseIncoming — the scan is looking at the wrong files');
    // A code position, not the warning's text, which names the schema a document failed inside a string.
    const spelled = doors.flatMap(({ file, code }) => [...code.matchAll(new RegExp(`\\b(?:${names.join('|')})\\b(?!['"\`])`, 'g'))].map(m => `${file}: ${m[0]}`));
    assert.deepEqual(spelled, [], 'a push door names an Incoming schema — read it through parseIncoming / INCOMING_SCHEMA_OF');
  });
});
