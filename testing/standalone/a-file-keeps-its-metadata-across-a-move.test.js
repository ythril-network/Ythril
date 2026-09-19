/**
 * A file's authored metadata survives a move, and survives a rewrite that does not mention it.
 *
 * ## Why this is written down as a guarantee rather than left as behaviour
 *
 * A file is the one record type with no id of its own. Entities, facts, edges and chrono entries carry a
 * UUID; a file's `_id` IS its path, chunks extend it as `path#chunkN`, and every file operation addresses
 * by path. So a rename CHANGES a file's identity, and anything an integrator has mapped onto that file has
 * to survive the change or be rebuilt.
 *
 * Both halves already held. Neither was documented, and the cost of that landed on somebody else: an
 * integrator building an external alias onto a file measured the two behaviours from outside, found them
 * correct, and then wrote a re-assert after every single write **because they were undocumented** — paying
 * a round trip per write to insure against a guarantee we were already keeping. Reported 2026-09-18.
 *
 * So the sentences went into `05-files-api.md` and this holds them true. A guarantee nothing checks is a
 * description, and a description is what they could not rely on.
 *
 * ## What each case is really asserting
 *
 * **The move carries the WHOLE document**, which is a stronger claim than "carries the three fields".
 * `renameFileMeta` re-inserts by spread, so a field added next year rides across without anybody
 * remembering — and the day somebody replaces the spread with a field list, that stops being true for
 * whatever they leave out. The assertion is therefore on the SPREAD, not on the field names.
 *
 * **The rewrite writes only what it was given.** `upsertFileMeta` guards each authored key with
 * `!== undefined`, so a body with no `description` leaves the stored one alone. A `$set` that assigned
 * them unconditionally would blank all three on every content-only upload — silently, because an upload
 * answers 201 either way and nothing reads the metadata back.
 *
 * ## Source, not behaviour, and the reason is what a behaviour test could not see
 *
 * The integration suite proves the round trip on a live instance and should. What it cannot show is WHY it
 * held: a rewrite that happened to send the same tags passes against code that blanks them. This reads the
 * two shapes that make the guarantee structural.
 *
 * ## Seen red
 *
 * By mutation: replacing the spread in `renameFileMeta` with a field list, and dropping the `!== undefined`
 * guard on `properties` in `upsertFileMeta`.
 *
 * Run: node --test testing/standalone/a-file-keeps-its-metadata-across-a-move.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const SRC = stripComments(readFileSync(join(REPO_ROOT, 'server/src/files/file-meta.ts'), 'utf8'));

/** The fields an integrator authors, as opposed to the ones the server computes. */
const AUTHORED = ['description', 'tags', 'properties'];

describe('the gate is reading the functions it names', () => {
  it('both are in file-meta.ts', () => {
    for (const name of ['renameFileMeta', 'upsertFileMeta']) {
      const body = bodyOf(SRC, name);
      assert.ok(body.length > 200, `${name} is not where this gate thinks it is — re-anchor before trusting it`);
    }
  });
});

describe('a move carries the record whole', () => {
  it('the re-insert spreads the existing document rather than listing its fields', () => {
    const body = bodyOf(SRC, 'renameFileMeta');
    assert.match(body, /insertOne\([\s\S]*\.\.\.existing/,
      'the renamed record must be built by spreading the one it replaces. A field list carries what '
      + 'somebody remembered on the day, and a file added a field to later arrives at its new path '
      + 'without it — with no error, because an insert of a partial document is a valid insert.');
  });

  it('and it changes only the identity and the timestamp', () => {
    /*
     * The spread is only half the guarantee: an override after it would silently reset a field. Read the
     * keys assigned alongside the spread and hold them to the three that MUST change — the two halves of
     * the new identity, and the stamp that says when.
     */
    const body = bodyOf(SRC, 'renameFileMeta');
    const insert = /insertOne\(asDoc<FileMetaDoc>\(\{([\s\S]*?)\}\)\)/.exec(body);
    assert.ok(insert, 'could not read the re-insert — re-anchor this case');
    const assigned = [...insert[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]);
    assert.deepEqual(assigned.sort(), ['_id', 'path', 'updatedAt'],
      `the re-insert assigns ${assigned.join(', ')} on top of the spread. Anything beyond the new id, the `
      + 'new path and the stamp is a field a move silently rewrites.');
  });
});

describe('a rewrite touches only what it was sent', () => {
  for (const field of AUTHORED) {
    it(`${field} is written only when the caller provided it`, () => {
      const body = bodyOf(SRC, 'upsertFileMeta');
      const guard = new RegExp(`if\\s*\\(\\s*opts\\.${field}\\s*!==\\s*undefined\\s*\\)\\s*\\$set\\[['"\`]${field}['"\`]\\]`);
      assert.match(body, guard,
        `a content-only upload must leave a stored \`${field}\` alone. Without the guard the \`$set\` `
        + `assigns \`undefined\`-or-empty over it on every rewrite — and an upload answers 201 either way, `
        + 'so the loss is only visible to whoever reads the metadata back afterwards.');
    });
  }

  it('none of the three is assigned unconditionally', () => {
    // The mutation that matters is not "the guard is gone" but "a second, unguarded assignment was added
    // beside it". Both would leave the case above green.
    const body = bodyOf(SRC, 'upsertFileMeta');
    for (const field of AUTHORED) {
      const unguarded = new RegExp(`(?:^|[;{}]\\s*)\\$set\\[['"\`]${field}['"\`]\\]\\s*=`, 'm');
      assert.doesNotMatch(body, unguarded,
        `\`${field}\` is assigned without asking whether the caller sent it`);
    }
  });
});
