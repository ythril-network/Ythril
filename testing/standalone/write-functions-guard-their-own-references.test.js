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

/**
 * The writers that can be handed a link set, and the kind each one writes from.
 *
 * Three, not one. The check was per FIELD while `updateFileMeta` was the only writer that had it; it is
 * one call now — class and existence together — and a writer that skips it is the same defect wherever it
 * happens.
 */
const GUARDED = [
  { file: 'server/src/brain/fact.ts', fn: 'saveFact' },
  { file: 'server/src/brain/fact.ts', fn: 'updateFact' },
  { file: 'server/src/brain/chrono.ts', fn: 'createChrono' },
  { file: 'server/src/brain/chrono.ts', fn: 'updateChrono' },
  { file: 'server/src/files/file-meta.ts', fn: 'updateFileMeta' },
];

describe('write functions guard their own references', () => {
  for (const target of GUARDED) {
    const src = () => stripComments(readFileSync(target.file, 'utf8'));

    it(`${target.fn} asserts its links itself`, () => {
      /*
       * At the WRITER, not at the door. The existence check sat at each door for the 4.x arrays and
       * NOWHERE for `linkEntities`, so on a strict space one spelling was refused and the other stored —
       * and `files/media/face-embedder.ts` reaches a writer directly, past every door there is.
       */
      const body = bodyOf(src(), target.fn);
      assert.match(body, /assertDesiredLinks\(/,
        `${target.fn} writes a link set without asserting it. The check used to live only at the API `
        + 'doors, so the strict-linkage guarantee held only for callers who remembered it.');
    });

    it(`${target.fn} asserts BEFORE it writes`, () => {
      /*
       * The half that makes it worth having. `reconcileLinks` asserts too and runs AFTER the record is
       * stored, so a refusal there leaves the record written without the links it asked for: a `400` and
       * a row the caller did not want, which is the silent unlinked write made noisy rather than fixed.
       */
      const body = bodyOf(src(), target.fn);
      const checkAt = body.indexOf('assertDesiredLinks(');
      const writeAt = body.search(/\.(updateOne|replaceOne|insertOne|findOneAndUpdate)\(/);
      assert.notEqual(writeAt, -1, `no write found in ${target.fn} — re-point this gate`);
      assert.ok(checkAt !== -1 && checkAt < writeAt,
        'asserting after the write leaves a record stored without the links the same call was refused for');
    });
  }

  it('and the shared assertion keeps EXISTENCE behind strictLinkage, while the class check is absolute', () => {
    /*
     * `strictLinkage: false` is a deliberate per-space choice to accept dangling references — a staged
     * import whose targets resolve in a later pass — so moving the check must not quietly withdraw it.
     * The CLASS check is not that: a fact cannot link to a chrono entry whatever the space says, because
     * there is no such class and the id would be derived from a label nothing reads.
     */
    const body = bodyOf(stripComments(readFileSync('server/src/brain/links.ts', 'utf8')), 'assertDesiredLinks');
    const strictAt = body.indexOf('isStrictLinkage(');
    const classAt = body.indexOf('linkClassRefusal(');
    assert.notEqual(strictAt, -1, 'the reference check must stay opt-out-able');
    assert.notEqual(classAt, -1, 'the class check is missing, so a seventh class could be written');
    assert.ok(classAt < strictAt,
      'the class check sits behind the linkage setting, so a lax space can store a link class that does '
      + 'not exist — which no reader will ever follow');
  });
});
