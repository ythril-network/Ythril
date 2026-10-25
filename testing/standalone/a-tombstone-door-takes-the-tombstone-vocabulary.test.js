/**
 * Both tombstone doors speak the same vocabulary — and nothing said so, so they diverged.
 *
 * ## The wedge this removes, which is worse than a rejected record
 *
 * `GET /api/sync/tombstones` derives what it serves from `TOMBSTONE_TYPES` — the knowledge types plus
 * `link`, never `file`. The `POST` door, twenty-eight lines below it in the same file, validated the incoming
 * array with `z.enum(KNOWLEDGE_TYPES)`: four members, no `link`.
 *
 * One rule, two doors, the weaker one winning silently. `CLAUDE.md` names that as the defect this repo
 * produces most, and here is what it costs:
 *
 *   1. `pushTombstones` calls `listTombstones` with NO type filter, so a push page can carry a link
 *      tombstone.
 *   2. `z.array(...).safeParse` fails on ONE bad element and rejects the whole page.
 *   3. The route answers `400`.
 *   4. `sync/tombstone-transfer.ts` reads a non-ok push as truncated and holds the watermark at that cursor.
 *
 * So one undelivered link tombstone stops **every deletion of every kind** propagating from that instance by
 * push — permanently, because the next cycle re-sends the same page and fails identically. The pull
 * direction is unaffected, which is what would make it hard to see: deletions still arrive, they just stop
 * leaving.
 *
 * ## Why it is a gate and not just a fix
 *
 * It was shipped BY the change that introduced `TOMBSTONE_TYPES`, in the same file, while that tuple's own
 * docblock boasted about not widening `KNOWLEDGE_TYPES` for the tombstone door. The two agreed by luck
 * before and nothing checked that they kept agreeing. Latent until a link delete path exists, so no test
 * would have caught it by exercise either — it was found by reading, and reading does not happen on a
 * schedule.
 *
 * ## Where each half lives now
 *
 * Bundle-46 moved the ingest schema out of the route into the one apply both tombstone doors share
 * (`sync/tombstone-apply.ts`), validated per element rather than as one array. The serving half stays in the
 * route. The assertions are the same; each reads the file that holds its half.
 *
 * Run: node --test testing/standalone/a-tombstone-door-takes-the-tombstone-vocabulary.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const SRC = 'server/src/api/sync/tombstones.ts';
const APPLY = 'server/src/sync/tombstone-apply.ts';
const code = stripComments(readFileSync(SRC, 'utf8'));
const apply = stripComments(readFileSync(APPLY, 'utf8'));

describe('the tombstone doors share one vocabulary', () => {
  it('the extractor finds the door at all — the check before the property', () => {
    // A rename that broke this anchor would make the assertions below run over an empty string and pass,
    // which is the failure mode a source-reading gate dies of.
    assert.match(apply, /const TombstoneShape = z\.object\(\{/, 'the ingest element schema was not found — re-anchor');
    assert.match(code, /applyPeerTombstones\(/, 'the POST door no longer hands its page to the shared apply — re-anchor');
    assert.match(code, /listTombstonesAfterPosition\(/, 'the GET door\'s read was not found — re-anchor');
  });

  it('the ingest validates against the TOMBSTONE vocabulary, not the knowledge one', () => {
    assert.match(apply, /type: z\.enum\(TOMBSTONE_TYPES\)/,
      'the ingest door must accept every type the serving door can send — `KNOWLEDGE_TYPES` is four members '
      + 'and omits `link`, so a link tombstone in a push page 400s the whole page and wedges the watermark');
  });

  it('and neither half mentions the knowledge tuple at all any more', () => {
    // The narrower assertion above passes while a second, stale `z.enum(KNOWLEDGE_TYPES)` sits elsewhere in
    // the file. This one is the sweep: the tombstone doors have no business with the schema vocabulary.
    for (const [file, src] of [[SRC, code], [APPLY, apply]]) {
      assert.doesNotMatch(src, /KNOWLEDGE_TYPES/,
        `${file} reads the schema vocabulary again — it is a different question, and mixing them `
        + 'is what put a four-member enum on a door that serves five');
    }
  });

  it('the serving door lists NO type, so the two cannot drift apart by one (bundle-81: a page of the position stream, each item with its own type)', () => {
    // The grouped per-type answer derived its keys from the tuple. The page of the position stream is one read of everything stored, each tombstone
    // carrying its own `type`: there is no list of types in the GET door to leave one out of, and a hand-written one would be the defect returning.
    const get = code.slice(code.indexOf("syncTombstonesRouter.get('/tombstones'"), code.indexOf("syncTombstonesRouter.post('/tombstones'"));
    assert.ok(get.length > 200, 'the GET door was not found — re-anchor');
    assert.doesNotMatch(get, /TOMBSTONE_TYPES|TOMBSTONE_COLLECTION|'fact'|'entity'|'edge'|'chrono'|'link'/,
      'the GET door spells a tombstone type: it serves what the stream holds, and a list here is the one that can omit a kind');
  });
});
