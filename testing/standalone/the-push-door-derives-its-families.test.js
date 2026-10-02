/**
 * The push door derives its families from the replication registry, and holds ONE hand table of them
 * (`Q-107` part 1, duplicated-rule pass).
 *
 * ## The rule
 *
 * `api/sync/docs.ts` wrote the six families out six times: a body-key type, a planned-family list, a tombstone-type
 * map, a writer switch naming each record type, a schema-kind map and the literal that read the body. A seventh
 * family — or a renamed one — would have been seven edits, and the one forgotten is a family a peer pushes and this
 * instance drops with a 200 (the `filemeta` story, once already). Now they come from `REPLICATED_FAMILIES`,
 * `RECORD_TYPE_OF` and `TOMBSTONE_TYPE_OF`. Two family-keyed tables stay, each because it is a fact the registry
 * cannot hold: the zod schema per family (`BATCH_SCHEMAS`, checked at load against the registry) and the response
 * literal (the wire contract — each family's counters differ).
 *
 * ## What is asserted
 *
 * - The writer is called with the family's own `RECORD_TYPE_OF` row, never a literal per family, and no `switch`
 *   dispatches on the family.
 * - The body is read by the registry's keys, never `body?.facts`-style one key at a time.
 * - No more than the two named family-keyed tables: a run of lines each opening with a family key is a table, and
 *   the count of such runs is held at two.
 * - The schema table is checked against the registry at load.
 *
 * Seen red by mutation, restored by hand: the tombstone-type map written back as a literal table.
 *
 * Run: node --test testing/standalone/the-push-door-derives-its-families.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
const DOCS = stripComments(readFileSync('server/src/api/sync/docs.ts', 'utf8'));
const KEYS = REPLICATED_FAMILIES.map(f => f.payloadKey);
const KEY_LINE = new RegExp(`^\\s*(?:${KEYS.join('|')})\\s*:`);

/** Consecutive runs of at least three lines that each open with a family key — a family-keyed table. */
function familyTables(src) {
  const runs = [];
  let run = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (KEY_LINE.test(line)) { run.push(i + 1); return; }
    if (line.trim() === '') return;
    if (run.length >= 3) runs.push(run);
    run = [];
  });
  if (run.length >= 3) runs.push(run);
  return runs;
}

describe('the push door derives its families', () => {
  it('the registry and the door are what this gate thinks they are (floor)', () => {
    assert.ok(KEYS.length >= 6, `only ${KEYS.length} replicated families — the registry moved`);
    assert.match(DOCS, /syncDocsRouter\.post\('\/batch-upsert'/, 'the push door moved — re-anchor this gate');
  });

  it('the writer is handed the family\'s own record type, with no per-family dispatch', () => {
    const calls = [...DOCS.matchAll(/writeArrivals\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(calls.length >= 1, 'the push door no longer calls the arrival writer');
    for (const c of calls) {
      assert.match(c, /^spaceId, (\w+), RECORD_TYPE_OF\[\1\], /, `a writeArrivals call names its record type itself: ${c}`);
    }
    assert.doesNotMatch(DOCS, /switch \((?:key|family|kind)\)/, 'a switch over the families is back');
  });

  it('the body is read by the registry\'s keys', () => {
    assert.doesNotMatch(DOCS, /body\?\.[a-z]+\b/, 'a body key is read one family at a time again');
    assert.match(DOCS, /REPLICATED_FAMILIES\.map\(\(\{ payloadKey: k \}\) =>\s*\[k, Array\.isArray\(body\?\.\[k\]\)/,
      'the body is not read through REPLICATED_FAMILIES');
  });

  it('at most the two named family-keyed tables, and the schema table is checked against the registry', () => {
    const tables = familyTables(DOCS);
    assert.equal(tables.length, 2,
      `the push door holds ${tables.length} family-keyed table(s) (lines ${tables.map(r => r[0]).join(', ')}); the `
      + 'schema table and the response literal are the two the registry cannot hold. Derive any other from '
      + 'REPLICATED_FAMILIES, RECORD_TYPE_OF or TOMBSTONE_TYPE_OF');
    assert.match(DOCS, /const missing = keys\.filter\(k => !\(k in BATCH_SCHEMAS\)\);/,
      'the schema table is no longer checked against the registry at load');
  });
});
