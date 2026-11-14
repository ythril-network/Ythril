/**
 * Every per-space index declared after the base fixture is NOT built at boot, unless it is listed here with the reason it may be
 * (Q-744, bundle-268 design r3 §6 and §11 T11, r4 §8 and §10 T11).
 *
 * ## The rule this holds, and why
 *
 * `initSpace` runs for every space at every boot before the server listens; an index built there over a large existing collection is
 * a boot that does not finish (every-pre-existing-space-index-says-whether-it-is-boot-safe.test.js, premise R5). That suite pins the
 * indexes that existed at df2e7534 and the changes it declares. It does not stop a NEW index from being declared through `plain`, which
 * is `policy: 'throw'` and boot-safe: the edge label index Q-744 adds (`{ label: 1 }`, `EDGE_LABEL_ENTRY`, `bootSafe: false`) would
 * be built at every boot over every edges collection if it were written `plain('edges', { label: 1 })`. So:
 *
 * - every declared index whose id is in neither list of that suite's base fixture, nor its declared changes, must say `bootSafe: false`;
 * - unless its id is a key of {@link BOOT_SAFE_BY_REASON} with a sentence saying why a boot may build it.
 *
 * {@link BOOT_SAFE_BY_REASON} is literal and filled when an entry is added: whatever post-base boot-safe entry existed at 327b105e is
 * listed with its reason, so the map is the record of every exception.
 *
 * ## Proven on a plant
 *
 * The check runs on the real declaration and on a planted one holding `plain('edges', { label: 1 })`'s shape, which it must flag. Seen
 * red at 327b105e with that entry planted in the built declaration (log b268-tests/t11-plant.log).
 *
 * Run: node --test testing/standalone/a-space-index-added-after-the-base-is-not-built-at-boot.test.js (a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireSpaceIndexDeclaration } from './_space-index-declaration.mjs';
import { stripComments } from './_strip-comments.mjs';

/** Post-base indexes a boot may build, each with the reason. At 327b105e one post-base entry was boot-safe, and it is listed. */
const BOOT_SAFE_BY_REASON = Object.freeze({
  'link_violations:docId_1': 'Declared boot-safe by e5bc79bb (bundle-45 review #10) before this gate existed; link_violations holds only the linkage check\'s open violations, so it is kept as the one recorded exception rather than changing its build here.',
});

/**
 * The ids the base suite already pins (both lists of its fixture and its declared changes), read from its source with the comments
 * stripped, so this gate never restates that fixture and never counts an id named only in a comment.
 */
function pinnedByBaseSuite() {
  const src = stripComments(readFileSync(new URL('./every-pre-existing-space-index-says-whether-it-is-boot-safe.test.js', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const m of src.matchAll(/'([a-z_]+:[A-Za-z0-9_.-]+)'/g)) ids.add(m[1]);
  return ids;
}

/** The findings of the rule over `declared` (entries as the declaration helper reads them: `{ id, bootSafe }`). */
function lateBootSafe(declared, pinned) {
  return declared
    .filter(e => !pinned.has(e.id) && e.bootSafe !== false && !Object.hasOwn(BOOT_SAFE_BY_REASON, e.id))
    .map(e => `${e.id} was added after the base and is ${e.bootSafe === true ? 'boot-safe' : `left to the default (${JSON.stringify(e.bootSafe)})`}, with no reason in BOOT_SAFE_BY_REASON`);
}

describe('a space index added after the base is not built at boot', () => {
  it('the base suite\'s pinned ids were read: a floor, so a moved fixture is a red, never an empty set', () => {
    const pinned = pinnedByBaseSuite();
    assert.ok(pinned.size >= 50, `only ${pinned.size} pinned ids were read from the base suite`);
    assert.ok(pinned.has('edges:type_1') && pinned.has('edges:edge_identity'), 'the base suite\'s fixture was not read');
  });

  it('every reason in the map is a sentence, and names a declared index', async () => {
    const declared = new Set((await requireSpaceIndexDeclaration(assert)).map(e => e.id));
    for (const [id, reason] of Object.entries(BOOT_SAFE_BY_REASON)) {
      assert.ok(declared.has(id), `${id} is listed with a reason but not declared`);
      assert.ok(typeof reason === 'string' && reason.length > 20 && /\.$/.test(reason), `${id}: the reason is not a sentence`);
    }
  });

  it('every declared index not pinned by the base suite says bootSafe: false, or is listed with its reason', async () => {
    const declared = await requireSpaceIndexDeclaration(assert);
    const findings = lateBootSafe(declared, pinnedByBaseSuite());
    assert.deepEqual(findings, [], findings.join('; '));
  });

  it('the check flags a planted plain(\'edges\', { label: 1 }) (boot-safe, throw) and passes the same entry declared bootSafe: false', async () => {
    const declared = await requireSpaceIndexDeclaration(assert);
    const pinned = pinnedByBaseSuite();
    const planted = [...declared, { id: 'edges:label_1', policy: 'throw', bootSafe: true }];
    assert.equal(lateBootSafe(planted, pinned).filter(f => f.startsWith('edges:label_1 ')).length, 1, 'the planted boot-safe label index was not flagged');
    const defaulted = [...declared, { id: 'edges:label_1', policy: 'report' }];
    assert.equal(lateBootSafe(defaulted, pinned).filter(f => f.startsWith('edges:label_1 ')).length, 1, 'a label index left to the default was not flagged');
    const fixed = [...declared, { id: 'edges:label_1', policy: 'report', bootSafe: false }];
    assert.deepEqual(lateBootSafe(fixed, pinned).filter(f => f.startsWith('edges:label_1 ')), [], 'the label index declared bootSafe: false was flagged');
  });
});
