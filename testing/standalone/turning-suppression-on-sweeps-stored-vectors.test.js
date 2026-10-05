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
 * The vector does not replicate: it is derived, and a peer may run a different embedding model.
 * `sync/local-only-fields.ts` is the list of fields that stay local and `brain/suppression-sweep.ts` names the
 * mechanisms that keep them so. So stripping one is a local operation — no tombstone, no seq, nothing for a peer
 * to converge on. Each peer runs its own sweep when the meta reaches it, which is what makes that correct rather
 * than merely convenient.
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
import { trackedSources } from './_sources.mjs';

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

  // That the retired spelling does NOT count is asserted, for every kind, in
  // `the-legacy-suppression-spelling-is-gone.test.js` (`Q-45.4`).

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
  const SWEEP_MODULE = 'server/src/brain/suppression-sweep.ts';

  /** Every top-level function of the sweep module with its body: the units the rules below are asserted over. */
  const functionsOf = (code) => [...code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
    .map(m => ({ name: m[1], body: bodyOf(code, m[1], SWEEP_MODULE) }));

  /** The module's functions reachable from `from` through calls to one another (itself included). */
  const reachableFrom = (fns, from) => {
    const seen = new Set([from]);
    for (const queue = [from]; queue.length > 0;) {
      const current = queue.pop();
      const { body } = fns.find(f => f.name === current);
      for (const { name } of fns) {
        if (!seen.has(name) && new RegExp(`\\b${name}\\(`).test(body)) { seen.add(name); queue.push(name); }
      }
    }
    return seen;
  };

  // The one function `updateSpace` asks. Named here because a pin that follows "whatever spaces.ts imports" passes for a
  // call to any export of the module (`dropFileVectors(...)` would do); the rest is derived from the module itself.
  const ENTRY = 'sweepAfterMetaWrite';

  it('updateSpace — the one writer of space.meta — calls the sweep entry, and the entry reaches the sweep', () => {
    // Q-361 item 11. The trigger lives in `updateSpace`, so EVERY effective-meta write asks for it: an operator's edit,
    // a schema route's (including a space no network carries), a passed vote's, and every recompute of the effective
    // meta (a network layer arriving). The callers used to ask for themselves — meta-update twice, the recompute not
    // at all — so a vote swept twice and a layer swept not at all.
    const spaces = src('server/src/spaces/spaces.ts');
    const imported = [...spaces.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*suppression-sweep\.js'/g)]
      .flatMap(m => m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    assert.ok(imported.includes(ENTRY), `spaces.ts does not import ${ENTRY} from the sweep module, so updateSpace cannot ask for a sweep`);
    assert.match(bodyOf(spaces, 'updateSpace'), new RegExp(`\\b${ENTRY}\\(`),
      `updateSpace does not CALL ${ENTRY}: nothing sweeps after a meta write, so the docs' present tense is still a promise rather than behaviour`);

    const sweep = src(SWEEP_MODULE);
    assert.match(sweep, new RegExp(`export\\s+function\\s+${ENTRY}\\b`), `${SWEEP_MODULE} no longer exports ${ENTRY}`);
    const reached = reachableFrom(functionsOf(sweep), ENTRY);
    assert.ok(reached.has('sweepSuppressedVectors'),
      `${ENTRY} reaches ${[...reached].join(', ')} — never sweepSuppressedVectors, so asking for a sweep removes no vector`);
  });

  it('nothing else that writes a space\'s meta asks for it: one change is swept once, wherever it lands', () => {
    // Derived, not listed: every file that calls updateSpace with a `meta` (a floor on the set), bar the one writer
    // itself. A caller that sweeps after its own meta write is the double sweep again. The import is matched by the
    // module's file name, wherever it is written from: `./suppression-sweep.js` inside brain/ is the same import as
    // `../brain/suppression-sweep.js` elsewhere.
    const writers = trackedSources('server/src', { floor: 100 })
      .filter(f => f !== 'server/src/spaces/spaces.ts')
      .filter(f => /\bupdateSpace\(\s*[^,()]+,\s*\{[^}]*\bmeta\b/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.ok(writers.length >= 2, `only ${writers.length} meta writer(s) found — the scan is looking in the wrong place: ${writers}`);
    const askers = writers.filter(f => /\bsuppression-sweep\.js/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(askers, [], 'these write meta AND sweep after it; updateSpace already asks for it, so the change is swept twice');
  });

  it('it does not bump seq anywhere, because the vector is not replicated', () => {
    // The vector is derived and a peer may run a different model (`sync/local-only-fields.ts` is the list). Bumping seq
    // for a local, underived change would replicate a no-op to every peer and re-send the whole document for a field they
    // never receive. Asserted over the whole module, so every function that writes — the pager, the file walk and the
    // arrival writer's `dropFileVectors` as much as the entry — is covered, and over what a seq write looks like in any
    // spelling: the module's own import of the seq module, a call to a seq function, or a `seq` field in an update.
    const sweep = src(SWEEP_MODULE);
    const writers = functionsOf(sweep).filter(f => /\$unset\s*:/.test(f.body));
    assert.ok(writers.length >= 2, `only ${writers.length} function(s) of the sweep module write an $unset — the reader is looking at the wrong thing`);
    assert.doesNotMatch(sweep, /util\/seq\.js|\b\w*[sS]eq\w*\s*\(|\bseq\b/,
      'the sweep must be local — stripping a vector is not a replicated change');
  });

  it('every function that removes a vector also cancels the jobs queued to put it back', () => {
    // Leaving a queued embed job behind would have the worker write the vector straight back, which is the
    // whole defect returning by a different route within seconds. A CALL is asserted, not the import: the import is
    // there for the one function that cancels, and says nothing of the other.
    const writers = functionsOf(src(SWEEP_MODULE)).filter(f => /\$unset\s*:\s*UNSET_VECTOR\b/.test(f.body));
    assert.ok(writers.length >= 2, `only ${writers.length} function(s) remove a vector — the reader is looking at the wrong thing`);
    for (const { name, body } of writers) {
      assert.match(body, /\bcancelEmbedJobs\(/,
        `${name} removes vectors and never calls cancelEmbedJobs: a pending embed job would restore the vector it just removed`);
    }
  });
});
