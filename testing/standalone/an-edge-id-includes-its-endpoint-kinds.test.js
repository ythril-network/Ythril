/**
 * An edge's derived id distinguishes endpoints of different KINDS — and an entity-to-entity edge still derives
 * exactly the id it always did.
 *
 * ## The defect this closes (M-3)
 *
 * `edgeIdFor(from, to, label)` derives an edge's `_id` so that two peers creating the same relationship arrive
 * at the same identity without talking. Since M-1 an endpoint can be an entity, a memory, a chrono entry or a
 * file — and **a memory and an entity may hold the same id**, because each collection assigns its own UUIDs.
 *
 * So `(from: X, to: Y, label: mentions)` where Y is an ENTITY and the same triplet where Y is a MEMORY are two
 * different relationships that derived one id. Under the unique index on `(from, to, label)` the second is a
 * duplicate key, and on a sync cycle it is a duplicate key on every cycle — the exact defect deriving the id
 * was introduced to remove, arriving back through the widened endpoint.
 *
 * It matters most for M-2. A lazy self-healing migration runs independently on every peer, so two peers
 * converting the same link is the ORDINARY case rather than a race; without the kinds in the key they produce
 * two ids for one link, at one record per mention, which is where the volume is.
 *
 * ## The compatibility rule, which is the whole of the encoding
 *
 * **When both endpoints are entities the key is BYTE-IDENTICAL to the old one.** Not as a courtesy — as a
 * requirement. A peer on an older build derives without kinds, and if the new code appended kinds
 * unconditionally the two would derive different ids for the same ordinary edge and re-open the duplicate-key
 * loop on precisely the networks that are mid-upgrade.
 *
 * `edge-id.ts` already says what is at stake: changing the namespace *"re-derives every future id and silently
 * splits new edges from ones already stored on a peer that has not upgraded."* Appending to the key has the
 * same effect, so the kinds are appended only when at least one of them is NOT `entity` — a combination that
 * could not exist before M-1 and therefore has no older peer to agree with.
 *
 * The golden ids below are hardcoded on purpose. A test that derives its expectation from the same function it
 * is checking cannot notice a re-derivation; a literal can, and that is the failure mode with the widest blast
 * radius in this file's subject.
 *
 * Run: node --test testing/standalone/an-edge-id-includes-its-endpoint-kinds.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
const { storedEdgeKind } = await import('../../server/dist/brain/entity-refs.js');

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Measured from the shipped derivation before the kinds were added. Never recomputed — see the docblock. */
const GOLDEN_ENTITY_EDGE = 'fa7d2d98-7b0e-5240-9102-8fea715712d0';

describe('an ordinary edge derives the id it always did', () => {
  it('with the kinds omitted, the id is byte-for-byte the old one', () => {
    /*
     * The assertion a mixed-version network depends on. A peer on an older build calls this with three
     * arguments; if the new code produced a different id, that peer and this one would store one relationship
     * under two identities and hit the unique index on every sync cycle — which is the defect deriving the id
     * removed in the first place.
     */
    assert.equal(edgeIdFor(A, B, 'depends_on'), GOLDEN_ENTITY_EDGE);
  });

  it('and stating `entity` explicitly derives the SAME id as omitting it', () => {
    // Absent means entity, everywhere. If the two forms derived different ids, an edge written through a door
    // that fills the field in would collide with the identical edge written through one that does not.
    assert.equal(edgeIdFor(A, B, 'depends_on', 'entity', 'entity'), GOLDEN_ENTITY_EDGE);
    assert.equal(edgeIdFor(A, B, 'depends_on', undefined, 'entity'), GOLDEN_ENTITY_EDGE);
    assert.equal(edgeIdFor(A, B, 'depends_on', 'entity', undefined), GOLDEN_ENTITY_EDGE);
  });
});

describe('a different KIND of endpoint is a different relationship', () => {
  it('the same id string as a memory and as an entity derive different edge ids', () => {
    /*
     * The case M-3 exists for. Each collection assigns its own UUIDs, so a memory and an entity CAN hold the
     * same id — and `(X) -[mentions]-> (Y as entity)` and `(X) -[mentions]-> (Y as memory)` are two
     * relationships. Sharing one id makes the second a duplicate key, for ever.
     */
    assert.notEqual(
      edgeIdFor(A, B, 'mentions', 'entity', 'entity'),
      edgeIdFor(A, B, 'mentions', 'entity', 'fact'),
      'a memory endpoint and an entity endpoint with the same id derived one edge id',
    );
  });

  it('and every kind is distinct from every other, on both ends', () => {
    // All sixteen combinations, because a partial encoding — say, one that folded chrono and memory together —
    // would pass a single spot check and collide in production on the pair it folded.
    const kinds = ['entity', 'fact', 'chrono', 'file'];
    const ids = new Map();
    for (const fk of kinds) {
      for (const tk of kinds) {
        const id = edgeIdFor(A, B, 'mentions', fk, tk);
        const clash = ids.get(id);
        assert.equal(clash, undefined, `${fk}->${tk} derives the same id as ${clash}`);
        ids.set(id, `${fk}->${tk}`);
      }
    }
    assert.equal(ids.size, 16);
  });

  it('the from-side kind matters as much as the to-side', () => {
    // Easy to encode only the `to` kind, because that is the side the party-photo case talks about. A file
    // pointing at an entity and an entity pointing at a file are different relationships.
    assert.notEqual(
      edgeIdFor(A, B, 'mentions', 'file', 'entity'),
      edgeIdFor(A, B, 'mentions', 'entity', 'file'),
    );
  });
});

describe('the properties the old encoding had are not lost', () => {
  it('direction still matters', () => {
    // `(a)-[knows]->(b)` and `(b)-[knows]->(a)` are two rows under the unique index, so they must be two ids.
    assert.notEqual(edgeIdFor(A, B, 'knows'), edgeIdFor(B, A, 'knows'));
    assert.notEqual(
      edgeIdFor(A, B, 'knows', 'entity', 'file'),
      edgeIdFor(B, A, 'knows', 'file', 'entity'),
    );
  });

  it('the encoding is still injective when a part contains the separator', () => {
    /*
     * The reason every part is length-prefixed: a label is operator-supplied text and nothing forbids a pipe or
     * a colon in it. Two genuinely different relationships must not encode to one key — they would collide
     * under the unique index while being distinct.
     */
    assert.notEqual(edgeIdFor('a|b', 'c', 'd'), edgeIdFor('a', 'b|c', 'd'));
    assert.notEqual(edgeIdFor('a', 'b', '4:file'), edgeIdFor('a', 'b', '', 'entity', 'file'));
  });

  it('a file endpoint is a path, and a path derives a stable id', () => {
    // Files are the one kind whose id is not a UUID. Nothing about the encoding cares, but the case is here
    // because it is the one a reader doubts.
    const id = edgeIdFor('photos/2019/party.jpg', B, 'taken_at', 'file', 'chrono');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id, edgeIdFor('photos/2019/party.jpg', B, 'taken_at', 'file', 'chrono'), 'and it is stable');
  });
});

describe('there is exactly ONE stored representation of an entity endpoint', () => {
  it('an explicit `entity` is normalised to absent', () => {
    /*
     * The reason this matters is that three things would otherwise disagree about whether an explicit
     * `'entity'` and an absent field are one row: `edgeIdFor` derives ONE id for both (so storing both is a
     * duplicate key on `_id`), the unique index sees `null` and `'entity'` as two keys (so it would hold both),
     * and `findEdgeByTriplet` filters on `null`, which matches a missing field and not the string.
     *
     * Normalising on the way in removes the disagreement at its source instead of teaching three places to
     * tolerate it.
     */
    assert.equal(storedEdgeKind('entity'), undefined);
    assert.equal(storedEdgeKind(undefined), undefined);
    assert.equal(storedEdgeKind('fact'), 'fact');
    assert.equal(storedEdgeKind('file'), 'file');
  });

  it('the write path stores the normalised value, not what the caller sent', () => {
    // Source-read, because the alternative is a database test for a one-line normalisation. What it pins is
    // that the raw option never reaches the document: `fromKind: opts.fromKind` would store `'entity'`.
    const body = bodyOf(src('server/src/brain/edges.ts'), 'upsertEdge');
    assert.match(body, /storedEdgeKind\(/, 'the upsert does not normalise the kind it stores');
    assert.doesNotMatch(body, /\{ fromKind: opts\.fromKind \}/,
      'the upsert stores the caller value verbatim, so an explicit `entity` would be written');
  });

  it('and correcting a kind back to entity UNSETS the field', () => {
    // `$set` with `'entity'` would leave the edge unfindable by its own triplet lookup, which filters on null.
    const body = bodyOf(src('server/src/brain/edges.ts'), 'updateEdgeById');
    assert.match(body, /\$unset\[side\]/,
      'a kind corrected back to entity is stored as a string rather than removed');
  });
});

describe('every derivation site passes the kinds', () => {
  /*
   * The field being in the key is worth nothing if a caller derives without it: that caller would produce the
   * pre-M-3 id and land on a collision for exactly the widened edges this exists for.
   *
   * Scoped from the SHAPE of a call rather than a list of files — a name list is how a sweep of the merge rule
   * once missed its twelfth copy.
   */
  for (const file of ['server/src/brain/edges.ts', 'server/src/brain/edge-rekey.ts', 'server/src/brain/merge.ts']) {
    it(`${file.split('/').pop()} derives with the kinds`, () => {
      const calls = [...src(file).matchAll(/edgeIdFor\(([^)]*)\)/g)].map(m => m[1]);
      assert.ok(calls.length > 0, `no edgeIdFor call found in ${file} — re-anchor this gate`);
      for (const args of calls) {
        assert.match(args, /Kind/,
          `edgeIdFor(${args}) omits the endpoint kinds, so it derives the pre-M-3 id`);
      }
    });
  }
});
