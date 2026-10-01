/**
 * A write planner decides; it never touches a collection (Q-99 part 3, Design v3 items 2-3).
 *
 * ## The rule
 *
 * The create/converge writers are split into planners (`brain/write-plan/plan-*.ts`) and one commit. A planner
 * takes an item and a READ SET (`read-set.ts`) and returns a plan: the refusal, the defaults, the merged record,
 * the links, the embed decision. It reads the store only through the read set and writes nothing; the commit
 * writes. That is what lets a batch of 500 cost one read per kind instead of five round trips per item, and
 * what lets a single write and a bulk write share every rule.
 *
 * **A planner that opens a collection undoes both.** One direct `findOne` is a per-item round trip the read set
 * was built to remove, and it reads the store WITHOUT the batch's earlier plans, so a repeated triplet or a
 * functional count stops seeing the items before it. One direct write is a record landing outside the commit's
 * seq allocation and ordering.
 *
 * ## Why this replaces the positional gates
 *
 * `write-functions-guard-their-own-references`, `write-functions-validate-not-their-callers` and
 * `every-writer-validates-internally` asserted "the check comes before the write" by text position in one
 * function body. After the split the check and the write are in different files, so position means nothing;
 * what holds the same guarantee is that the function deciding cannot write at all.
 *
 * ## What is derived, and what counts as touching
 *
 *  - **The planners** are every tracked or new file in the directory whose name is `plan-*.ts`
 *    (`plan-and-commit.ts` included: it re-plans against a fresh read set, never against a collection). A
 *    floor of four — one per kind — so an empty or missing directory cannot pass.
 *  - **Touching** is opening a collection (`col(`, `getDb(`, `.collection(`, `spaceCollection(`, a value import
 *    of `mongodb` or `db/mongo`), or calling any method `db/record-write-observer.ts` classifies on a driver
 *    `Collection` — derived from its table, less the names an array, map, set, string or promise also has
 *    (`find`), which the opener check already covers.
 *
 * ## Seen red
 *
 * Red on 1d88828e: the directory does not exist. Mutation: four scratch planners written by hand, one holding a
 * `col(...).findOne(` (red, naming it), then deleted by hand.
 *
 * Run: node --test testing/standalone/a-write-planner-touches-no-collection.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');

const DIR = 'server/src/brain/write-plan';

/** Untracked too: a planner written in the same change is the one this gate most needs to see. */
const FILES = readTrackedSources(DIR, { floor: 0, untracked: true });
const PLANNERS = FILES.filter(f => /\/plan-[^/]+\.ts$/.test(f.file));

/** Collection methods that cannot be mistaken for a method of an ordinary value. */
const AMBIENT = [Array.prototype, Map.prototype, Set.prototype, String.prototype, Promise.prototype, Object.prototype];
const COLLECTION_METHODS = Object.keys(COLLECTION_METHOD_EFFECT).filter(m => !AMBIENT.some(p => m in p));

const OPENERS = [
  { what: 'opens a collection with col(…)', re: /(^|[^\w$.])col\s*(<[^>(]*>)?\s*\(/ },
  { what: 'opens the database with getDb()', re: /\bgetDb\s*\(/ },
  { what: 'opens a collection with .collection(…)', re: /\.\s*collection\s*(<[^>(]*>)?\s*\(/ },
  { what: 'names a collection with spaceCollection(…)', re: /\bspaceCollection\s*\(/ },
  { what: 'imports a value from mongodb', re: /import\s+(?!type\b)[^;]*from\s+['"]mongodb['"]/ },
  { what: 'imports from db/mongo', re: /import\s+(?!type\b)[^;]*from\s+['"][./]*db\/mongo(\.js)?['"]/ },
];

describe('the planners exist', () => {
  it('found at least one planner per record kind (floor)', () => {
    assert.ok(PLANNERS.length >= 4,
      `found ${PLANNERS.length} plan-*.ts module(s) under ${DIR} — the create/converge writers are not split into `
      + 'planners yet, or the directory moved. Every case below passes over an empty set.');
  });

  it('the read set the planners read through exists', () => {
    assert.ok(FILES.some(f => f.file === `${DIR}/read-set.ts`), `${DIR}/read-set.ts does not exist`);
  });

  it('the derived collection method list is not empty (floor)', () => {
    assert.ok(COLLECTION_METHODS.length >= 25 && COLLECTION_METHODS.includes('findOne') && COLLECTION_METHODS.includes('insertOne'),
      `only ${COLLECTION_METHODS.length} collection methods derived`);
  });
});

describe('no planner touches a collection', () => {
  it('every planner reads through the read set and writes nothing', () => {
    const offenders = [];
    for (const { file, text } of PLANNERS) {
      const src = stripComments(text);
      for (const { what, re } of OPENERS) if (re.test(src)) offenders.push(`${file}: ${what}`);
      for (const m of COLLECTION_METHODS) {
        if (new RegExp(`\\.\\s*${m}\\s*(<[^>(]*>)?\\s*\\(`).test(src)) offenders.push(`${file}: calls .${m}(`);
      }
    }
    assert.deepEqual(offenders, [],
      'a planner touches the store directly. Reads go through the read set (one query per kind for the batch, '
      + 'with the earlier plans overlaid); writes belong to the commit');
  });
});
