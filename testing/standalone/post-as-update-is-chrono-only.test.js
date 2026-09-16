/**
 * `POST /:id` as an update exists for NO record type. It used to exist for chrono alone.
 *
 * ## What this gate used to say, and why it changed
 *
 * The asymmetry was reported as a bug ("POST to a memory id returns 200 and changes nothing"). The 200 did
 * not reproduce — both path shapes answer **404** — but the asymmetry underneath it was real and documented
 * nowhere. It read as a bug from either direction depending on which type you met first.
 *
 * The resolution was NOT to add `POST /facts/:id` for symmetry: that spreads a deprecated shape to a
 * second type to make it look tidy. So the gate pinned "chrono has it, the other three do not" and the
 * chrono route was documented as legacy and listed for removal at the next major.
 *
 * **3.0 is that major, and the route is gone.** Every type now updates by `PATCH` only, and a client-supplied
 * UUID v4 in the COLLECTION post is the supported way to make a create idempotent — for all four, which is
 * what made the legacy form a duplicate rather than a feature.
 *
 * ## Why this file was kept rather than deleted
 *
 * Its own note said *"if chrono's route has finally been removed, delete this gate and its deprecation entry
 * together"*. The deprecation entry is gone. This file is not, deliberately: the reason it existed was to
 * stop the shape SPREADING, and that risk did not end with the removal — it inverted. "None of the four has
 * it" is a strictly stronger claim than "only chrono has it", costs the same to run, and is the thing that
 * would catch it being reintroduced on any type by someone who never read the history above.
 *
 * Run: node --test testing/standalone/post-as-update-is-chrono-only.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Comments stripped, so the gate cannot pass on the prose that documents it. */
const code = (p) => readFileSync(join(ROOT, p), 'utf8')
  .split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** A `POST /…/<collection>/:id` route — the update-by-id shape, as opposed to the collection POST. */
const postById = (src, router, collection) =>
  new RegExp(`${router}\\.post\\('/spaces/:spaceId/${collection}/:id'`).test(src);

describe('POST-as-update exists on no record type', () => {
  it('none of the four carries it, chrono included', () => {
    const found = {
      fact: postById(code('server/src/api/brain/facts.ts'), 'memoriesRouter', 'facts'),
      entity: postById(code('server/src/api/brain/entities.ts'), 'entitiesRouter', 'entities'),
      edge: postById(code('server/src/api/brain/edges.ts'), 'edgesRouter', 'edges'),
      chrono: postById(code('server/src/api/brain/chrono.ts'), 'chronoRouter', 'chrono'),
    };
    assert.deepEqual(found, { fact: false, entity: false, edge: false, chrono: false },
      'POST-as-update was removed in 3.0. Re-adding it anywhere brings back a shape that duplicated the '
      + 'retry-safety design (a client-supplied UUID v4 in the collection POST) while skipping property '
      + 'validation and writing no audit snapshot. Update by PATCH.');
  });

  it('the detector can actually see a route of that shape', () => {
    // Mutation-check the matcher before trusting a negative — and this matters MORE now than it did when
    // the expectation was mixed. Every value above is `false`, so a regex that matches nothing would report
    // the codebase clean no matter what was in it. Three gates in this repo have passed on planted bugs.
    assert.equal(postById("chronoRouter.post('/spaces/:spaceId/chrono/:id', handler)", 'chronoRouter', 'chrono'), true,
      'the detector must still recognise the shape it is looking for');
    assert.equal(postById("memoriesRouter.post('/spaces/:spaceId/facts', handler)", 'memoriesRouter', 'facts'), false,
      'a COLLECTION post must not be mistaken for an update-by-id route');
  });

  it('PATCH is present on all four, so the check above is not passing on empty files', () => {
    // The other half of the same trap: "no POST-as-update anywhere" is also true of four files that failed
    // to load. Asserting the routes that SHOULD be there proves the detector read real source.
    const patchById = (src, router, collection) =>
      new RegExp(`${router}\\.patch\\('/spaces/:spaceId/${collection}/:id'`).test(src);
    assert.equal(patchById(code('server/src/api/brain/facts.ts'), 'memoriesRouter', 'facts'), true);
    assert.equal(patchById(code('server/src/api/brain/entities.ts'), 'entitiesRouter', 'entities'), true);
    assert.equal(patchById(code('server/src/api/brain/edges.ts'), 'edgesRouter', 'edges'), true);
    assert.equal(patchById(code('server/src/api/brain/chrono.ts'), 'chronoRouter', 'chrono'), true);
  });

  it('the guide no longer offers the legacy form', () => {
    // `04f-write-semantics.md` since A-5: the write-and-read rules moved off the memory page, because
    // they apply to every record type. Read from where the section IS — a gate left pointing at the old
    // page fails several assertions at once and reads as missing sentences rather than a moved file.
    const guide = readFileSync(join(ROOT, 'docs/integration-guide/04f-write-semantics.md'), 'utf8');
    assert.match(guide, /Updating by id: use PATCH/, 'the section exists');
    assert.ok(!/POST\s+`?\/api\/brain\/spaces\/:spaceId\/chrono\/:id/.test(guide),
      'the guide must not still document a route that answers 404');
  });
});
