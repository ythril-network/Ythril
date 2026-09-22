/**
 * A write function that stores references validates them itself, rather than trusting its callers to have done it.
 *
 * ## The shape, now seen three times
 *
 * `strictLinkage` promises that a stored reference resolves. That promise was kept by the API doors calling
 * `assertRefsResolve` before the write — so it held for callers who remembered, and not otherwise:
 *
 *  - `upsertEdge` did not validate its schema; `api/contradictions.ts` and `brain/bulk.ts` went around it.
 *  - `updateFileMeta` did not validate its references; `files/media/face-embedder.ts` goes around it,
 *    attaching an auto-labelled face's entity with no check at all.
 *  - `brain/merge.ts` validated nothing while rewriting the survivor.
 *
 * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate."*
 *
 * ## What this pins
 *
 * That the reference check lives INSIDE the function that stores the reference. Callers may check too — the API
 * doors legitimately do, for better error shapes — so this asserts presence at the write, never absence at the
 * caller.
 *
 * It also pins the `strictLinkage` gate, because moving a check is exactly when an opt-out gets lost by
 * accident: the setting exists for staged imports where targets resolve in a later pass, and a relocation that
 * quietly made the check unconditional would break that without anyone asking for it.
 *
 * Run: node --test testing/standalone/write-functions-guard-their-own-references.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/** Write functions that store references, and the input field each one resolves. */
const GUARDED = [
  {
    file: 'server/src/files/file-meta.ts',
    fn: 'updateFileMeta',
    refs: ['linkEntities', 'linkFacts', 'linkChronos'],
    bypassedBy: 'files/media/face-embedder.ts, which attaches an auto-labelled face\'s entity directly',
  },
];

describe('write functions guard their own references', () => {
  for (const target of GUARDED) {
    const src = stripComments(readFileSync(target.file, 'utf8'));

    it(`${target.fn} validates every reference field it stores`, () => {
      const body = bodyOf(src, target.fn);
      for (const field of target.refs) {
        assert.match(
          body, new RegExp(`assertRefsResolve\\([^)]*'${field}'`),
          `${target.fn} stores '${field}' without checking that it resolves. The check used to live only at the `
          + `API doors, so strictLinkage's guarantee held only for callers who remembered it — and it is `
          + `bypassed today by ${target.bypassedBy}.`,
        );
      }
    });

    it(`${target.fn} keeps the check behind strictLinkage`, () => {
      const body = bodyOf(src, target.fn);
      assert.match(
        body, /isStrictLinkage\(/,
        'the reference check must stay opt-out-able. `strictLinkage: false` exists for staged imports where '
        + 'targets are resolved in a later pass; making the check unconditional withdraws that silently.',
      );
    });

    it(`${target.fn} checks BEFORE it writes`, () => {
      const body = bodyOf(src, target.fn);
      const checkAt = body.indexOf('assertRefsResolve(');
      const writeAt = body.search(/\.(updateOne|replaceOne|insertOne|findOneAndUpdate)\(/);
      assert.notEqual(writeAt, -1, `no write found in ${target.fn} — re-point this gate`);
      assert.ok(
        checkAt !== -1 && checkAt < writeAt,
        'checking after the write would refuse a reference the store already holds',
      );
    });
  }
});
