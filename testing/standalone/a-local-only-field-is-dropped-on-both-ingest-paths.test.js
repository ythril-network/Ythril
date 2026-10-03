/**
 * A LOCAL-ONLY FIELD IS DROPPED ON BOTH INGEST PATHS, not just the one anybody pictures.
 *
 * ## The defect this was written for
 *
 * Five fields are local by design and must never be taken from a peer — `merkle.ts` names them in
 * `DERIVED_FIELDS` and excludes them from the space hash for exactly that reason:
 *
 *  - `embedding` and `embeddingModel` — computed by THIS instance's model. A vector from a peer running a
 *    different model does not fail; it ranks, plausibly, in the wrong order.
 *  - `matchedText` — the snippet a query matched. An artefact of a search, not content.
 *  - `_expireAt` and `_contentExpireAt` — computed from THIS instance's retention policy, and
 *    `brain/ttl-sweep.ts` deletes every record whose `_expireAt` has passed, across every space, through the
 *    normal delete path. **A stamp taken from a peer therefore lets one instance decide when another
 *    deletes its data** — which is the sentence `CLAUDE.md` already uses to explain the hash exclusion.
 *
 * **There are TWO ingest paths and only one of them dropped these.** Push arrives at
 * `api/sync/_shared.ts` and is validated by an `Incoming*` schema that declares none of the five, so zod
 * strips them. Pull lands in `sync/engine.ts`, which fetches `full=true`, pushes each item straight into a
 * `bulkWrite` of `replaceOne`s, and validated nothing — so **a pulled record carried the sender's vector and
 * the sender's retention stamp, and both were stored.**
 *
 * One rule, two implementations, the weaker winning silently — the shape `CLAUDE.md` names as this
 * codebase's most expensive. It is invisible from both ends: nothing errors, nothing is logged, and the
 * deletion that eventually follows looks like the local retention policy working.
 *
 * ## Why the gate that already existed did not catch it
 *
 * `a-receiver-embeds-by-its-own-rules.test.js` asserts the receiver does not trust an arriving vector, and
 * its reasoning says *"no ingest schema can deliver one"* — true, and true only of the path that runs a
 * schema. Its subject is *the ingest router*, so the second ingest site was outside the thing it looked at.
 * A gate scoped to one mechanism concludes about all of them.
 *
 * Run: node --test testing/standalone/a-local-only-field-is-dropped-on-both-ingest-paths.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const FIELDS = 'server/src/sync/local-only-fields.ts';
const ENGINE = 'server/src/sync/engine.ts';
const SHARED = 'server/src/api/sync/_shared.ts';
const ARRIVALS = 'server/src/sync/arrivals.ts';
const src = (f) => stripComments(readFileSync(f, 'utf8'));

/**
 * The five, READ OUT OF `merkle.ts` rather than written here.
 *
 * `CLAUDE.md` states the equivalence this depends on as a rule: a field that is hashed must replicate. So
 * the fields excluded from the hash are exactly the fields that must not be taken from a peer, and a second
 * list here would be the thing this gate exists to prevent.
 */
function derivedFields() {
  const s = src(FIELDS);
  const at = s.indexOf('LOCAL_ONLY_FIELDS');
  if (at < 0) return [];
  const body = s.slice(at, s.indexOf(']', at));
  return [...body.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]);
}

describe('the two ingest paths agree about local-only fields', () => {
  const fields = derivedFields();

  it('the derived-field list is readable, so this gate cannot pass on an empty set', () => {
    assert.ok(fields.length >= 5,
      `only ${fields.length} derived field(s) found in merkle.ts — the list moved and this gate is `
      + 'measuring nothing');
    assert.ok(fields.includes('embedding') && fields.includes('_expireAt'),
      `the derived list is missing a field this gate is about: ${fields.join(', ')}`);
  });

  it('PUSH drops them: no Incoming schema declares one', () => {
    const s = src(SHARED);
    const declared = fields.filter(f => new RegExp(`^\s*${f}:`, 'm').test(s));
    assert.deepEqual(declared, [],
      `an ingest schema declares a local-only field, so a peer can set it: ${declared.join(', ')}`);
  });

  it('and PULL drops them too, which is the half that did not — in the one arrival writer', () => {
    /*
     * The pull path validates nothing, so the drop has to be explicit and has to name the shared list. Since
     * `Q-107` part 1 it is not the engine's: every door stores through `writeArrivals` (`sync/arrivals.ts`), which
     * drops what arrived of the local-only set — the derived half always, the record-tier half unless the write
     * is a RESTORE — by the module's own sets, never by a list spelled here. The engine hands the page over whole.
     */
    // Re-anchored for bundle-30 `Q-204`: the engine hands the page to the page accept the push uses, which validates
    // it and writes it through `writeArrivals`.
    assert.match(src(ENGINE), /await acceptArrivingPage\(/,
      'the pull path no longer stores its page through the page accept, so nothing drops what never crosses');
    assert.match(src('server/src/sync/accept-page.ts'), /await writeArrivals\(/,
      'the page accept no longer stores through the arrival writer, so nothing drops what never crosses');
    const prep = bodyOf(src(ARRIVALS), 'prepared');
    assert.match(prep, /for \(const f of DERIVED_LOCAL_FIELDS\) delete doc\[f\];/,
      'the writer no longer drops the derived local-only fields (vector, model, matchedText) from what arrived');
    assert.match(prep, /for \(const f of RESTORED_LOCAL_FIELDS\) \{\s*if \(!restore\) \{ delete doc\[f\]; continue; \}/,
      'the writer keeps a peer\'s retention stamps or sync base — a peer would decide when this instance deletes '
      + 'its data, which is what `ttl-sweep.ts` acts on');
    const fields = src(FIELDS);
    assert.match(fields, /DERIVED_LOCAL_FIELDS[^=]*=\s*new Set\(\[\.\.\.LOCAL_ONLY_FIELDS\]\.filter\(/,
      'the derived half is no longer derived from LOCAL_ONLY_FIELDS, so a new local-only field can fall in neither');
  });

  it('the drop happens BEFORE the write, not after it', () => {
    const body = bodyOf(src(ARRIVALS), 'writeArrivals');
    const strip = body.search(/prepared\(doc, family, restore\)/);
    const write = body.indexOf('.bulkWrite(');
    assert.ok(strip > 0 && write > 0, 'cannot locate the drop and the write in the arrival writer');
    assert.ok(strip < write,
      'the local-only fields are dropped after the document is written, which stores them first');
  });

  it('and the list is not written out a second time in the engine', () => {
    const s = src(ENGINE);
    const spelled = fields.filter(f => new RegExp(`'${f}'`).test(s));
    assert.deepEqual(spelled, [],
      `the engine spells out ${spelled.join(', ')} instead of reading the shared list — that is the second `
      + 'copy this gate exists to prevent');
  });
});
