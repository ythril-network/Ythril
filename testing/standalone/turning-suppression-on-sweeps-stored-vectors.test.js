/**
 * Turning suppression on removes the vectors already stored, which is what the product says it does.
 *
 * ## The defect
 *
 * `docs/userguide/02-brain.md` states it in the present tense: *"What it does is remove the record's
 * embedding, not hide the record."* It did not. `spaces/meta-update.ts` merged the flag and nothing swept, so
 * a record kept its vector — and kept competing on meaning — until something happened to write it again. The
 * eleven write paths honour the flag; nothing honoured it for records that already existed.
 *
 * The same page is precise about the other direction — *"Turning suppression off does not go back and embed
 * what was written while it was on. Use the space's Reindex control"* — so only the ON direction is a promise
 * that was not kept, and only the ON direction is in scope here.
 *
 * ## Why the sweep is unconditional rather than a before/after diff
 *
 * The obvious shape is "compute what NEWLY became suppressed". It is wrong, because nothing ever swept: a
 * type whose schema has said `suppressEmbeddings: true` for months still holds vectors for every record
 * written before the flag. A diff would skip exactly those — the population the defect created — and would
 * heal only spaces that happen to be edited again.
 *
 * So the rule is "after a meta write, no record that resolves to suppressed still holds a vector". Idempotent,
 * self-healing, and it converges the historical backlog on the next meta write of any kind, which is the shape
 * this codebase's migration rule asks for.
 *
 * ## Why this is local and needs no seq bump
 *
 * The vector does not replicate. `api/sync/docs.ts` strips `embedding` before sending in all five places, with
 * the reason stated there: it is derived, and a peer may run a different embedding model. So stripping one is
 * a local operation — no tombstone, no seq, nothing for a peer to converge on. Each peer runs its own sweep
 * when the meta reaches it, which is what makes that correct rather than merely convenient.
 *
 * ## The tier rule this depends on
 *
 * `record > schema > space`, and **`false` at the RECORD tier means "not stated"** — it falls through instead
 * of overriding, which `recordSuppression()` encodes by returning `true | undefined` and never `false`. At the
 * SCHEMA tier a `false` does override the space. Getting those two backwards is the whole difficulty of the
 * filter below, and each direction is asserted.
 *
 * Run: node --test testing/standalone/turning-suppression-on-sweeps-stored-vectors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

let SWEEP = null;
try { SWEEP = await import('../../server/dist/brain/suppression-sweep.js'); } catch { /* not built yet */ }
const suppressedWithVectorFilter = SWEEP?.suppressedWithVectorFilter
  ?? (() => { throw new Error('brain/suppression-sweep.ts does not exist yet'); });

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** Does `doc` satisfy the filter? A tiny evaluator — enough for `$or`, `$in`, `$nin`, `$ne`, `$exists`. */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some(sub => matches(doc, sub));
    const actual = doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.entries(v).every(([op, operand]) => {
        if (op === '$exists') return (actual !== undefined) === operand;
        if (op === '$ne') return actual !== operand;
        if (op === '$in') return operand.includes(actual);
        if (op === '$nin') return !operand.includes(actual);
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return actual === v;
  });
}

const withVector = (d) => ({ embedding: [0.1], ...d });
const swept = (meta, kind, doc) => matches(doc, suppressedWithVectorFilter(meta, kind));

describe('a record with no vector is never selected', () => {
  it('there is nothing to strip', () => {
    // The filter is what a bulk `$unset` runs against, so a record with no vector would be a write that
    // changes nothing — and would make the reported count meaningless.
    assert.equal(swept({ suppressEmbeddings: true }, 'fact', { type: 'note' }), false);
  });
});

describe('the space tier', () => {
  it('selects a record whose type says nothing', () => {
    assert.equal(swept({ suppressEmbeddings: true }, 'fact', withVector({ type: 'note' })), true);
  });

  it('selects nothing when the space tier is off', () => {
    assert.equal(swept({ suppressEmbeddings: false }, 'fact', withVector({ type: 'note' })), false);
    assert.equal(swept({}, 'fact', withVector({ type: 'note' })), false);
  });
});

describe('the record tier overrides the space, and only `true` counts as stated', () => {
  it('a record flagged true is selected even with the space tier off', () => {
    assert.equal(swept({}, 'fact', withVector({ type: 'note', suppressEmbeddings: true })), true);
  });

  it('and the retired spelling does NOT count — it is a field like any other now', () => {
    /*
     * This asserted the opposite while `excludeFromVectorSearch` was written beside the current name for
     * mixed-version networks. `D-6` retired it in 4.0, and the peer floor is what made that safe: a 4.x
     * build refuses every pre-3.1.0 peer, so no record arriving on the wire can carry only the old key.
     *
     * Asserted rather than deleted, because the sweep reading a key nothing writes is not harmless — it
     * would strip vectors from records nobody suppressed, on a field left over from an old document.
     */
    assert.equal(swept({}, 'fact', withVector({ type: 'note', excludeFromVectorSearch: true })), false,
      'the sweep still honours the retired spelling, so a stale key strips a vector nobody asked to remove');
  });

  it('a record flagged FALSE still follows the space, because false means "not stated"', () => {
    /*
     * The direction that is easy to get backwards. `recordSuppression()` returns `true | undefined` and never
     * `false` on purpose: a `false` here must fall THROUGH to the schema and space tiers. Treating it as an
     * override would make the space-wide switch do nothing for any record anybody had ever explicitly
     * un-suppressed — which is the failure its own docblock warns about.
     */
    assert.equal(swept({ suppressEmbeddings: true }, 'fact',
      withVector({ type: 'note', suppressEmbeddings: false })), true);
  });
});

describe('the schema tier sits between them', () => {
  const meta = (space, schemas) => ({ suppressEmbeddings: space, typeSchemas: { fact: schemas } });

  it('a type whose schema says true is selected even with the space tier off', () => {
    // The population the defect created: a schema flag set months ago, and every record written before it
    // still carrying a vector. A before/after diff would never reach these.
    assert.equal(swept(meta(false, { note: { suppressEmbeddings: true } }), 'fact',
      withVector({ type: 'note' })), true);
  });

  it('a type whose schema says FALSE is spared, even with the space tier on', () => {
    // At the SCHEMA tier a `false` DOES override the space — the opposite of the record tier. This is the pair
    // of assertions that stops the two rules being conflated.
    assert.equal(swept(meta(true, { note: { suppressEmbeddings: false } }), 'fact',
      withVector({ type: 'note' })), false);
  });

  it('a type the schema does not mention still follows the space', () => {
    assert.equal(swept(meta(true, { other: { suppressEmbeddings: false } }), 'fact',
      withVector({ type: 'note' })), true);
  });

  it('a record flagged true beats a schema that says false', () => {
    assert.equal(swept(meta(false, { note: { suppressEmbeddings: false } }), 'fact',
      withVector({ type: 'note', suppressEmbeddings: true })), true);
  });
});

describe('an edge keys on LABEL, not on type', () => {
  it('a schema flag on an edge label applies', () => {
    /*
     * The trap `suppress-embeddings.ts` names in its own docblock: edges key their schema on `label` while
     * everything else keys on `type`, and `EdgeDoc` carries BOTH. A filter reading `type` for an edge looks up
     * a schema that is never there and quietly sweeps nothing — for the one record kind the owner specifically
     * widened suppression to cover.
     */
    const meta = { typeSchemas: { edge: { mentions: { suppressEmbeddings: true } } } };
    assert.equal(swept(meta, 'edge', withVector({ label: 'mentions', type: 'note' })), true);
  });

  it('and an edge is not matched by its `type` field standing in for a label', () => {
    const meta = { typeSchemas: { edge: { note: { suppressEmbeddings: true } } } };
    assert.equal(swept(meta, 'edge', withVector({ label: 'mentions', type: 'note' })), false);
  });
});

describe('the sweep runs where the flag is written', () => {
  it('meta-update calls it', () => {
    const body = src('server/src/spaces/meta-update.ts');
    assert.match(body, /sweepSuppressedVectors\(/,
      'nothing sweeps after a meta write, so the docs\' present tense is still a promise rather than behaviour');
  });

  it('it does not bump seq, because the vector is not replicated', () => {
    // `api/sync/docs.ts` strips `embedding` before sending — it is derived and the peer may run a different
    // model. Bumping seq for a local, underived change would replicate a no-op to every peer and re-send the
    // whole document for a field they never receive.
    const sweep = src('server/src/brain/suppression-sweep.ts');
    assert.doesNotMatch(bodyOf(sweep, 'sweepSuppressedVectors'), /bumpSeq|nextSeq/,
      'the sweep must be local — stripping a vector is not a replicated change');
  });

  it('it clears BOTH the field and any queued job to recompute it', () => {
    // Leaving a queued embed job behind would have the worker write the vector straight back, which is the
    // whole defect returning by a different route within seconds.
    const sweep = src('server/src/brain/suppression-sweep.ts');
    assert.match(sweep, /embed_jobs|cancelEmbedJobs|dequeue/i,
      'a pending embed job would restore the vector the sweep just removed');
  });
});
