/**
 * The bulk door keeps no reporting copy of the schema validation (Q-99 part 3, Design v3 item 2, A5).
 *
 * ## The rule
 *
 * `brain/bulk.ts` validated every item twice: once itself, through `schemaFails(type, i, validate*(…))`, to
 * report a per-item reason with an index, and once more inside the writer it then called, which enforces the
 * rule. Two copies of one rule, and the weaker one is the one a caller reads — the reporting copy saw the
 * payload where the writer saw the merged record, so an endpoint refusal reached a bulk caller as a flattened
 * message from the catch instead of the reason (see `every-writer-validates-internally`).
 *
 * With the planners returning refusals as DATA, the per-item reason comes from the same classification that
 * refuses the write, and the reporting copy has nothing left to do. So bulk calls no schema validator at all.
 *
 * ## What is derived
 *
 * The validators are every `validate*` function `spaces/schema-validation.ts` exports — read from the module,
 * floored at four (one per record kind) so a rename cannot empty the set. Bulk is then refused a call to any of
 * them, a call to any `validate*` it might wrap them in, and the `schemaFails` adapter. Comments are stripped
 * first: the reason a copy was removed is allowed to be written down.
 *
 * ## Seen red
 *
 * Red on 1d88828e: `bulkWrite` calls `schemaFails` around `validateFact`/`validateEntity`/`validateChrono`/
 * `validateEdge`, and imports the four. Mutation, restored by hand: those calls and the import commented out in
 * bulk.ts (green: a comment naming them does not count), then put back.
 *
 * Run: node --test testing/standalone/bulk-keeps-no-reporting-copy-of-validation.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const BULK = 'server/src/brain/bulk.ts';
const VALIDATION = 'server/src/spaces/schema-validation.ts';
const read = f => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));

const VALIDATORS = [...read(VALIDATION).matchAll(/export\s+(?:async\s+)?function\s+(validate\w*)\s*[(<]/g)].map(m => m[1]);

describe('bulk keeps no reporting copy of the schema validation', () => {
  it('the validators are read from the module (floor)', () => {
    assert.ok(VALIDATORS.length >= 4, `only ${VALIDATORS.length} validate* export(s) in ${VALIDATION}: ${VALIDATORS.join(', ')}`);
  });

  it('bulk calls none of them, wraps none of them, and has no schemaFails', () => {
    const src = read(BULK);
    const calls = [...src.matchAll(/(^|[^\w$.])(validate\w*|schemaFails)\s*(<[^>(]*>)?\s*\(/g)]
      .map(m => m[2]);
    const imported = VALIDATORS.filter(v => new RegExp(`\\bimport\\b[^;]*\\b${v}\\b[^;]*from`).test(src));
    assert.deepEqual({ calls: [...new Set(calls)], imported }, { calls: [], imported: [] },
      'bulk re-validates items the planner already classified. The planner returns the refusal as data, with '
      + 'the same reason the write is refused for — a second, reporting-only copy is the one that drifts');
  });
});
