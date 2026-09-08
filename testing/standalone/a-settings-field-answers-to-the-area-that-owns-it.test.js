/**
 * `PATCH /api/spaces/:id` is one door onto twenty-two unrelated settings, and each answers to its own area.
 *
 * ## What was wrong
 *
 * Every field on this route demanded Space-admin — `admin` on all four areas at once. So on the busiest
 * space-configuration door the four areas bought nothing: a `files` administrator could not set a media
 * level, a `dataQuality` writer could not tune a duplicate rule, and both had to be handed the whole space
 * instead. That is the opposite of what the matrix is for.
 *
 * Owner, 2026-09-08: *"if it makes sense decompose the PATCH and give it to the correct areas/rungs"*.
 *
 * ## Why the authorisation is decomposed and the ROUTE is not
 *
 * Splitting `PATCH /:id` into several endpoints breaks every integrator, and this route is the documented
 * way to update a space. The fields can be governed correctly without moving them.
 *
 * ## Why a TABLE here is safe, when the rule it replaced was not
 *
 * A generalised rule was proposed first — *"the row names the highest rung any field in the body can
 * demand"* — and the owner refused it: *"sounds complicated and prone to errors"*. It over-required by
 * construction and it failed OPEN on the widest body in the API.
 *
 * An explicit field → requirement table is the opposite shape, and two things hold it up:
 *
 *  - the body is `.strict()`, so a field nobody declared is already a `400` and cannot arrive ungoverned;
 *  - **the first case below asserts the table is TOTAL over the zod schemas**, derived from
 *    `UpdateSpaceBody.shape` and `SpaceMetaBody.shape` rather than from a list here. A field added without
 *    a requirement fails the build instead of defaulting to something.
 *
 * That second point is the whole safety argument. Without it this route fails open: the guard is now the
 * rung guard, so anyone who can reach the space arrives at the handler, and an ungoverned field would be
 * a field anybody could set.
 *
 * ## The expected values ARE the contract
 *
 * The second case names each field's requirement literally, and that is deliberate: deriving the expected
 * value from the code under test would assert only that the code equals itself. The owner agreed this
 * table field by field, and a change to any row should have to be made here too.
 *
 * Run: node --test testing/standalone/a-settings-field-answers-to-the-area-that-owns-it.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
const { UpdateSpaceBody, SpaceMetaBody } = await import('../../server/dist/spaces/body-schemas.js');

/** Every field the route accepts, `meta.` prefixed for the nested ones — read from the schemas, not listed. */
function acceptedFields() {
  const top = Object.keys(UpdateSpaceBody._def?.schema?.shape ?? UpdateSpaceBody.shape ?? {});
  const meta = Object.keys(SpaceMetaBody.shape ?? {});
  assert.ok(top.length > 10, `only ${top.length} top-level fields found — the reader is wrong, not the code`);
  assert.ok(meta.length > 4, `only ${meta.length} meta fields found — the reader is wrong, not the code`);
  // `meta` is the CONTAINER. It carries no requirement of its own; its children carry theirs.
  return [...top.filter(k => k !== 'meta'), ...meta.map(k => `meta.${k}`)];
}

/** What the owner agreed, 2026-09-08, field by field. */
const AGREED = {
  label:                  'spaceAdmin',
  maxGiB:                 'instanceAdmin',
  faceDescriptorDims:     'files:admin',
  typeSchemasMode:        'schema:write',
  dupeRules:              'dataQuality:write',
  dupeMergeSurvivor:      'dataQuality:write',
  dupeRulesOnInsert:      'dataQuality:admin',
  recordTtlDays:          'knowledge:admin',
  documentExtraction:     'files:write',
  imageAnalysis:          'files:write',
  audioAnalysis:          'files:write',
  videoAnalysis:          'files:write',
  textAnalysis:           'files:write',
  completeLinkage:        'knowledge:admin',
  'meta.purpose':         'spaceAdmin',
  'meta.usageNotes':      'spaceAdmin',
  'meta.typeSchemas':     'schema:write',
  'meta.whenDuePasses':   'schema:write',
  'meta.validationMode':  'schema:admin',
  'meta.strictLinkage':   'schema:admin',
  'meta.suppressEmbeddings': 'knowledge:admin',
};

const spell = (r) => (typeof r === 'string' ? r : `${r.area}:${r.needs}`);

describe('every settings field answers to the area that owns it', () => {
  it('the table is TOTAL over what the route accepts', () => {
    // The safety argument for the whole change. The guard admits anyone who can reach the space, so a field
    // with no requirement is a field anybody can set — and it would arrive with no error anywhere.
    const missing = acceptedFields().filter(f => !(f in SPACE_FIELD_RIGHTS));
    assert.deepEqual(missing, [],
      `these settings fields have no requirement, so nothing governs them: ${missing.join(', ')}`);
  });

  it('and names nothing the route does not accept', () => {
    // The other direction. A stale row is a rule nobody can trigger, and it hides that the field it named
    // has been renamed rather than removed.
    const accepted = new Set(acceptedFields());
    const stale = Object.keys(SPACE_FIELD_RIGHTS).filter(f => !accepted.has(f));
    assert.deepEqual(stale, [], `these requirements name fields the route does not accept: ${stale.join(', ')}`);
  });

  it('each field requires what the owner agreed', () => {
    const actual = {};
    for (const f of Object.keys(AGREED)) actual[f] = spell(SPACE_FIELD_RIGHTS[f]);
    assert.deepEqual(actual, AGREED);
  });

  it('the quota is the one field that TIGHTENED, and it is instance-level', () => {
    // A space administrator could raise their own share of the host's disk. It is the only row that takes
    // something away, and it is worth stating on its own so a later sweep does not "simplify" it.
    assert.equal(SPACE_FIELD_RIGHTS['maxGiB'], 'instanceAdmin');
  });

  it('the route consults the table instead of keeping a second copy of the rule', () => {
    const SRC = stripComments(readFileSync('server/src/api/spaces.ts', 'utf8'));
    const GUARD = stripComments(readFileSync('server/src/auth/require-settings-fields.ts', 'utf8'));
    // The check is a GUARD, so the route names it in its chain and the guard is what reads the table.
    // Authorisation in the chain rather than in the handler: a reviewer counts guards, and a block inside
    // a handler can be reordered behind a validation without anyone noticing it moved.
    assert.match(SRC, /requireSettingsFields\('id'\)/,
      'the settings route must carry the per-field guard');
    assert.match(GUARD, /refusalsForSpaceUpdate\(/,
      'the per-field check must be the shared one — a second copy is the defect this repo produces most');
    /*
     * The old single-field check for `maxGiB` must be GONE, not left beside the table answering first —
     * two implementations of one rule, and the weaker one wins silently.
     *
     * Asserted on the REFUSAL rather than on a window around the field name. A window would have to guess
     * how far apart `maxGiB` and `isInstanceAdmin` sit, and `no-magic-windows` refuses that correctly: a
     * check rewritten a few lines longer would read as clean. The refusal text is what the caller saw and
     * it exists nowhere else.
     */
    assert.ok(!/Ask an instance administrator to change the quota/.test(SRC),
      'the hand-written maxGiB refusal is still in the route, beside the table that now owns the rule');
    assert.match(GUARD, /if \(!refused\.length\) \{ next\(\); return; \}/,
      'the guard must pass the request on only when NOTHING was refused');
  });
});
