/**
 * Every write that records what THIS instance did with a file's bytes goes through ONE function,
 * `setFileProcessingState` in `server/src/files/processing-state.ts` (`Q-240`, bundle-48 D7).
 *
 * ## The rule
 *
 * A top-level file row carries two kinds of field. The AUTHORED ones (`description`, `tags`, `properties`, `author`,
 * `seq`, `updatedAt`...) are what `brain/merkle.ts` hashes (`FILE_HASH_PROJECTION`) and what replicates. The
 * PROCESSING ones (`embeddingStatus`, `mediaJobError`, `mediaType`, `chunkCount`, `convertedFileId`,
 * `conversionError`) record the local pipeline's progress: derived from this instance's copy of the bytes, never
 * hashed, never sent. A write to the second kind must not stamp the first, and the stamp that matters is `updatedAt`.
 *
 * Nine writers said `{ $set: { embeddingStatus: ..., updatedAt: now } }` in their own place, so two instances that agreed
 * about everything anybody wrote reported `MERKLE_DIVERGENCE` over a status mark each had made on its own copy. The
 * one-line `updatedAt` was the part nothing stopped a writer adding, so the module owns the write and does not let
 * a caller name a hashed field: typed, no `updatedAt`, no `seq`, no free `$set`.
 *
 * ## What is derived, and why not a list of the nine
 *
 * - **The writes**: every update the call graph attributes to a space's FILES collection (`_record-writes.mjs`:
 *   aliases, helper-returned collections and `fileCollection(spaceId)`-style helpers resolved), each paired with the
 *   mutator call it came from and its `$set` / `$unset` keys read (`_processing-state-writes.mjs`). A list of the nine
 *   would be the corrected list the next writer is missing from; the tree is the list.
 * - **The fields**: FileMetaDoc's own, minus `FILE_HASH_PROJECTION`'s (an inclusion list in `merkle.ts`), restricted to
 *   the processing set `processing-state.ts` types. The rule is therefore stated over "a field the hash does not see AND
 *   a pipeline writes", and a field promoted into the hash fails the derivation rather than falling out of the rule.
 * - **Not "all-local-only"**: the old nine each ALSO set `updatedAt`, which is hashed, so a rule "no write whose keys are
 *   all local-only" would have excused every one of them. The rule is "no write TOUCHES a processing field outside the
 *   module", which says nothing about what else the write carries.
 *
 * ## Scope, stated rather than implied
 *
 * UPDATES of a top-level row (`updateOne`, `updateMany`, `findOneAndUpdate`, and the `$set`/`$unset` of a `bulkWrite`).
 * Insert and replace write whole documents: the chunk and sidecar rows a conversion or an embedder stores are
 * `parentFileId` rows, which replicate nowhere and are not hashed, so a processing field on one of THEM is its own
 * state, not a parent's mark. An update whose filter names `parentFileId` is exempt on that ground, derived.
 *
 * A write whose keys cannot be read (a spread, an update built elsewhere) is NOT read as clean: it counts as touching a
 * processing field when its function names one, which is the safe direction for a gate.
 *
 * ## Seen red
 *
 * On 2693450b `processing-state.ts` does not exist and ten updates outside it touch a processing field:
 * `job-queue.ts` enqueueTextJob / completeJob / failJob / retryJob / retryFailedJobs, `worker.ts` processJob (three:
 * the "processing" mark, the conversion pointer and count, the permanent-failure mark) and `dispatch.ts`
 * dispatchFileProcessing (two). The plan counted nine and lists `worker.ts:444` and `:662`; the third, the
 * `chunkCount` / `convertedFileId` write at `:555`, is the same state through a variable and is held to the rule too.
 *
 * Run: node --test testing/standalone/a-file-row-processing-write-goes-through-one-function.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { moduleIndex } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';
import { REPO_ROOT } from './_sources.mjs';
import {
  fileRowWrites, processingTouched, processingFields, hashedFileFields, localOnlyFileFields, fileMetaDocFields, updateKeys,
  NOT_A_PROCESSING_MARK,
} from './_processing-state-writes.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');

const MODULE = 'server/src/files/processing-state.ts';

/**
 * Writes that touch a processing field and are NOT a processing mark, with the reason: `_processing-state-writes.mjs`,
 * which the -db test that drives every writer reads too. An entry that no longer matches a write that touches a
 * processing field FAILS below, so it cannot outlive what it excuses.
 */
const EXEMPT = NOT_A_PROCESSING_MARK;

const INDEX = moduleIndex('server/src');
const RECORDS = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });
const WRITES = fileRowWrites(INDEX, RECORDS);

/** An update whose FILTER names `parentFileId` addresses chunk and sidecar rows, which are not a parent's own state. */
const isChildRow = (w) => /\bparentFileId\b/.test(w.filter);
const touching = WRITES.map(w => ({ w, t: processingTouched(w) })).filter(({ t }) => t.fields.length > 0);
const inModule = ({ w }) => w.file === MODULE;

describe('the derivation reads what a write sets', () => {
  it('reads an inline $set, a quoted key, a shorthand and an $unset', () => {
    const r = updateKeys("{ _id: id }, { $set: { embeddingStatus: 'x', 'mediaJobError': e, updatedAt: now, chunkCount }, $unset: { convertedFileId: '' } }", '');
    assert.deepEqual([...r.keys].sort(), ['chunkCount', 'convertedFileId', 'embeddingStatus', 'mediaJobError', 'updatedAt']);
    assert.deepEqual(r.unresolved, []);
  });

  it('reads a NAMED update: its literal and every later assignment to it', () => {
    const body = "const meta: Record<string, unknown> = { chunkCount };\n if (x) meta['convertedFileId'] = y;\n meta.conversionError = z;";
    const r = updateKeys('{ _id: id }, { $set: meta }', body);
    assert.deepEqual([...r.keys].sort(), ['chunkCount', 'conversionError', 'convertedFileId']);
    assert.deepEqual(r.unresolved, []);
  });

  it('does NOT read an update it cannot see as clean', () => {
    assert.ok(updateKeys('{ _id: id }, { $set: { ...extra, a: 1 } }', '').unresolved.length > 0, 'a spread hides keys');
    assert.ok(updateKeys('{ _id: id }, { $set: built }', 'const other = {};').unresolved.length > 0, 'an undeclared name hides keys');
    const hidden = { keys: new Set(), unresolved: ['x'], bodyMentions: ['embeddingStatus'] };
    assert.deepEqual(processingTouched(hidden), { fields: ['embeddingStatus'], readable: false },
      'an unreadable write whose function names a processing field is a write that touches one');
  });
});

describe('the derivation finds the writes at all, so the rule cannot pass by finding none', () => {
  it('found the files-collection writes, and read keys from them', () => {
    assert.ok(WRITES.length >= 30, `only ${WRITES.length} file-collection write(s) found`);
    const readable = WRITES.filter(w => w.keys.size > 0);
    // The floor is read from the write sites' own text, not a number: a write whose arguments spell an inline operator
    // block with a first key (`$set: { a: …`, `$unset: { 'b': …`) is one the reader MUST have read keys from. It was
    // `readable.length >= 12`, a count of the tree as it stood before the processing writes moved into
    // `setFileProcessingState`, whose own write builds its update from a typed argument and has no key to read; moving
    // the writes took it to 10 and the count said "broken" about a reader that was fine. A count written here is a copy
    // of a fact the tree holds, and this says what the tree holds.
    const spelled = WRITES.filter(w => /\$(?:set|unset|setOnInsert)\s*:\s*\{\s*(?:\w|'|")/.test(w.args));
    assert.ok(spelled.length >= 1, 'no write spells an inline $set / $unset block — the derivation is not looking at update documents');
    assert.deepEqual(spelled.filter(w => w.keys.size === 0).map(w => w.name), [],
      'these spell an inline operator block and the reader found no keys in it — the key reader is broken');
    // The reader must see a HASHED key being written, or "no hashed key" below passes by reading nothing.
    const hashed = new Set(hashedFileFields());
    assert.ok(readable.length >= 1 && readable.some(w => [...w.keys].some(k => hashed.has(k))),
      'no write was read setting a hashed field (updatedAt, seq, description...) — the key reader is blind to them');
  });

  it('the processing fields are real FileMetaDoc fields the hash does not see', () => {
    const fields = processingFields();
    assert.ok(fields.length >= 6, `only ${fields.length} processing field(s): ${fields.join(', ')}`);
    assert.ok(localOnlyFileFields().length >= 10 && fileMetaDocFields().length >= 25, 'the field derivation is thin');
    assert.ok(fields.includes('embeddingStatus'), 'embeddingStatus is the anchor of the rule and is not in the set');
  });

  it('some write anywhere touches a processing field (otherwise the rule below is vacuous)', () => {
    assert.ok(touching.length >= 1, 'no write in the tree touches a file\'s processing state — the derivation is broken');
  });
});

describe('a file row\'s processing state is written by one function', () => {
  it('every write that touches a processing field is in files/processing-state.ts, or a named exemption', () => {
    const outside = touching
      .filter(x => !inModule(x))
      .filter(({ w }) => !(w.name in EXEMPT))
      .filter(({ w }) => !isChildRow(w))
      .map(({ w, t }) => `${w.name} — touches ${t.fields.join(', ')}${t.readable ? '' : ' (its keys are not readable; its function names them)'}`
        + `${w.keys.has('updatedAt') ? ' and STAMPS updatedAt' : ''}`);
    assert.deepEqual(outside, [],
      `these write a file's local processing state outside ${MODULE}${existsSync(join(REPO_ROOT, MODULE)) ? '' : ' (which does not exist yet)'}. `
      + 'Each is a place that can add `updatedAt` or `seq` to a status mark, which makes two instances that agree about everything '
      + 'anybody wrote report a divergence over what each did on its own. Route the write through setFileProcessingState');
  });

  it('every exemption still excuses a write that touches a processing field', () => {
    const live = new Set(touching.map(({ w }) => w.name));
    for (const name of Object.keys(EXEMPT)) {
      assert.ok(live.has(name), `the exemption '${name}' matches no write that touches a processing field any more — remove it`);
    }
  });
});

describe('the one function exists and cannot stamp what it must not', () => {
  it('files/processing-state.ts exists and is a writer of the files collection', () => {
    assert.ok(existsSync(join(REPO_ROOT, MODULE)), `${MODULE} does not exist — every processing mark is still written where it is made`);
    // An update, by location: the module builds its `$set` from a typed argument, so its keys need not be spelled in it.
    assert.ok(WRITES.some(w => w.file === MODULE && ['updateOne', 'updateMany', 'findOneAndUpdate'].includes(w.op)),
      `${MODULE} updates no file row — it is not the writer`);
  });

  it('no write inside it sets a field the hash sees, or bumps a seq', () => {
    const inside = WRITES.filter(w => w.file === MODULE);
    // Not a vacuous pass while the module is missing: with nothing inside, "no write inside sets X" says nothing.
    assert.ok(inside.length >= 1, `${MODULE} holds no write to the files collection, so nothing here could be checked`);
    const hashed = new Set(hashedFileFields());
    const offenders = [];
    for (const w of inside) {
      for (const k of w.keys) if (hashed.has(k)) offenders.push(`${w.name} sets '${k}'`);
      if (/\bupdatedAt\b|\bnextSeq\b|\bbumpSeq\b|\bseq\b/.test(w.args)) offenders.push(`${w.name} names updatedAt or seq in its arguments`);
    }
    assert.deepEqual(offenders, [], 'a processing mark must not set a hashed field: that is the defect this module exists to remove');
  });
});
