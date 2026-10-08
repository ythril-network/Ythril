/**
 * Every write of a field DERIVED FROM A FILE'S BYTES goes through ONE module, `server/src/files/derived-fields.ts`
 * (bundle-89, Q-418, plan item E2.5 "ONE WRITER FOR A FILE ROW'S DERIVED FIELDS").
 *
 * ## The rule
 *
 * A file row carries fields this instance computed from the bytes: the vector and the model that made it, `matchedText`,
 * `excerpt`, a derived `description` with its `descriptionSource`, the processing state (`embeddingStatus`...), and the
 * content and vector of the chunk, caption and face rows that belong to a file. All of them describe bytes that a delete
 * is about to remove. A writer that lands one AFTER the delete flagged the file revives the very thing the flag exists to
 * remove: a vector on an audit row, a caption nobody can see, a face row recall still finds.
 *
 * The question every such write needs answered is *"is the file this row belongs to still live?"*, and the answer differs
 * by tier: a top-level row asks about itself, a chunk, caption or face row asks about its PARENT (a chunk row never
 * carries `deletedAt`, so a predicate on the chunk asks the wrong row's question). That is the forgettable part, so it
 * lives INSIDE the one module; a caller cannot drop it because a caller does not write the field.
 *
 * Seen as: four guarded writes in `brain/embed-record.ts` built from the one `asRead` filter (two of the four missed by
 * the first draft of the plan, the one that stores the vector among them), the four chunk writes of the media embedders
 * (`image-embedder`, `audio-embedder`, `video-embedder`, `face-embedder`), `setDerivedDescriptionIfUnset` and
 * `setFileProcessingState`: each a hand-placed guard that looks optional in a diff, and a seventh writer next year that
 * nothing stops. It is `writeArrivals`' twin (`an-arrival-is-written-by-one-writer.test.js`) for the files collection.
 *
 * ## What is derived, never listed
 *
 *  - **The fields**: the derived half of the local-only set (`DERIVED_LOCAL_FIELDS`, `sync/local-only-fields.ts`), the
 *    processing state `files/processing-state.ts` types, every other `FileMetaDoc` field the divergence hash does not see
 *    (`FILE_HASH_PROJECTION`) except the identity and byte-fact keys named below, and `descriptionSource`, which is hashed
 *    and replicates but is written ONLY alongside a derived description. A field added to `FileMetaDoc` and not hashed is
 *    in the rule the day it lands.
 *  - **The writes**: every mutator the call graph attributes to a space's files collection, or to a collection whose name
 *    is computed (`${spaceId}_${COLLECTION[recordType]}`, which `embed-record.ts` writes through for the file among other
 *    kinds), with the keys of its update read (`_processing-state-writes.mjs`). An update whose keys cannot be read, and a
 *    whole-document write (`replaceOne`, `insertMany`), counts as touching a field when the function names one: the safe
 *    direction is a finding a person reads. A delete is not a write of a field.
 *
 * ## Scope, stated rather than implied
 *
 * `sizeBytes` and `sha256` are facts about the bytes that the BYTE doors record (`recordArrivedFile`, `upsertFileMeta`);
 * the flag strips them, but their writers are the arrival and upload doors, held by `an-arrival-is-written-by-one-writer`.
 * They are named below as byte facts, not hidden. A removal that happens in the same write as the deletion flag
 * (`markFileMetaDeleted`, `markFileMetaDeletedByPrefix`) is the strip, not a derived write: it removes, it never sets, and
 * it must be ATOMIC with the flag, which `a-flagged-file-keeps-nothing-derived-from-its-bytes-db.test.js` drives.
 *
 * ## Seen red
 *
 * On 429e6d25 the module does not exist and the derived writes sit in nine files. Stated in the failure message.
 *
 * Run: node --test testing/standalone/a-files-derived-fields-are-written-by-one-module.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleIndex } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { fileRowWrites, processingFields, localOnlyFileFields, fileMetaDocFields, hashedFileFields } from './_processing-state-writes.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');
const { DERIVED_LOCAL_FIELDS } = await import('../../server/dist/sync/local-only-fields.js');

/**
 * The one module. A name the plan gives it by role, not by file: if the implementation names it differently, this is the one
 * line to edit, and the rest of the gate does not care where the writer lives so long as it is ONE file.
 */
const OWNER = 'server/src/files/derived-fields.ts';

/**
 * File fields the hash does not see that are NOT derived content: the row's identity, the deletion flag, and the two facts
 * about the bytes the byte doors record. Each is named because the alternative is a silent gap in the derived set.
 */
const NOT_DERIVED = Object.freeze({
  spaceId: 'identity: the retag of an arriving row',
  parentFileId: 'identity: which file a derived row belongs to; set when the row is made',
  deletedAt: 'the deletion flag itself',
  sizeBytes: 'a byte fact the byte doors record (`recordArrivedFile`, `upsertFileMeta`), held by an-arrival-is-written-by-one-writer',
  sha256: 'a byte fact the byte doors record, held by an-arrival-is-written-by-one-writer',
});

const DELETE_OPS = new Set(['deleteOne', 'deleteMany', 'findOneAndDelete']);
const UPDATE_OPS = new Set(['updateOne', 'updateMany', 'findOneAndUpdate']);

/**
 * Writes outside the one module that touch a derived field and are NOT a write of what the bytes produced, with the reason.
 * Keyed `file:function`. An entry whose function no longer writes the files collection fails below, so a row cannot outlive
 * what it excuses.
 */
const EXEMPT = {
  'server/src/files/file-meta.ts:markFileMetaDeleted':
    'the deletion flag. It REMOVES every derived field in the same update that sets `deletedAt` (atomic: a crash between a flag and a '
    + 'separate strip would leave a flagged row holding a vector that nothing re-runs the strip for) and sets none',
  'server/src/files/file-meta.ts:markFileMetaDeletedByPrefix':
    'the deletion flag for a directory subtree, the primitive a directory delete reaches (`retireFileMetaUnder`): the same atomic strip, '
    + 'removes and never sets',
  'server/src/sync/arrivals.ts:writeArrivals':
    'the arrival writer CARRIES this instance\'s own stored vector across the replace of an arriving row (`carriedFields`) and writes none of '
    + 'its own: it computes nothing from bytes, and a vector that arrives is dropped (`an-arrival-is-written-by-one-writer`)',
  'server/src/brain/entities.ts:unlabelFacesWhere':
    'the face-label cascade of a deleted entity: it clears the entity\'s claim on face rows already held and writes no content or '
    + 'vector, so it cannot make a row exist for a file that is gone',
  'server/src/brain/merge.ts:relinkAndAbsorb':
    'an entity merge re-points the face rows of the absorbed entity (`faceEntityId`): a label on rows already held, no content, no vector, '
    + 'never creates a row',
  'server/src/files/media/face-embedder.ts:propagateFaceLabel':
    'a manual entity label copied to the face rows of a file that already hold a face vector (`faceEmbedding: { $exists: true }`): a label '
    + 'on rows already held, never creates a row',
  'server/src/files/move-cascade.ts:relocateDerivedFileMeta':
    'a MOVE re-keys the rows already derived from a file under the new path, content and vectors carried as they were (`rekeyedRow`), and '
    + 'rewrites the `convertedFileId` pointer so the path stays true: it records nothing the pipeline did and computes nothing new',
};

const INDEX = moduleIndex('server/src');
const RECORDS = recordWrites(INDEX, { collections: BRAIN_COLLECTIONS, floors: { space: 150 }, recordFloor: 50 });
const WRITES = fileRowWrites(INDEX, RECORDS, { includeComputed: true });

/** The derived set, read from the modules that define it. */
function derivedFields() {
  const processing = processingFields();
  const set = new Set([
    ...DERIVED_LOCAL_FIELDS,
    ...processing,
    ...localOnlyFileFields().filter(f => !Object.hasOwn(NOT_DERIVED, f)),
    'descriptionSource',
  ]);
  return set;
}
const DERIVED = derivedFields();

/** The source file that declares the typed processing state: its writes take their keys from an argument, not from text. */
function typedStateFile() {
  const hits = [];
  for (const f of trackedSources('server/src')) {
    if (/export (?:interface|type) FileProcessingState\b/.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8')))) hits.push(f);
  }
  assert.equal(hits.length, 1, `the typed processing state is declared in ${hits.length} file(s) (${hits}) — re-anchor`);
  return hits[0];
}
const STATE_FILE = typedStateFile();

/**
 * The derived fields one write touches: the keys it sets or unsets; or, when its keys cannot be read or it writes whole
 * documents, the derived fields its function names; and, for the module that writes a typed processing state, every
 * write in it. A delete touches nothing.
 *
 * Takes the pieces rather than reaching for globals, so the classifier below is exercised on literal shapes.
 */
export function touchedDerived({ op, keys, unresolved, file }, body, derived, stateFile) {
  if (DELETE_OPS.has(op)) return [];
  const direct = [...keys].filter(k => derived.has(k));
  const hidden = unresolved.length > 0 || !UPDATE_OPS.has(op);
  const named = hidden ? [...derived].filter(f => new RegExp(`\\b${f}\\b`).test(body)) : [];
  const typed = file === stateFile ? processingFields() : [];
  return [...new Set([...direct, ...named, ...typed])];
}

const touching = WRITES
  .map(w => ({ w, fields: touchedDerived(w, INDEX.bodies.get(w.key).body, DERIVED, STATE_FILE) }))
  .filter(x => x.fields.length > 0);
const fnKeyOf = (w) => `${w.file}:${w.fn}`;

describe('the derivation reads what a write touches, on the shapes today\'s writers have', () => {
  const D = new Set(['embedding', 'embeddingModel', 'matchedText', 'content', 'descriptionSource', 'embeddingStatus']);
  const w = (op, keys, unresolved = [], file = 'server/src/x.ts') => ({ op, keys: new Set(keys), unresolved, file });

  it('an inline $set of the vector, the model and the text (the embed success write)', () => {
    assert.deepEqual(touchedDerived(w('updateOne', ['embedding', 'embeddingModel', 'matchedText']), '', D, STATE_FILE).sort(), ['embedding', 'embeddingModel', 'matchedText']);
  });
  it('an update whose keys cannot be read (a $unset built elsewhere), by what its function names', () => {
    assert.deepEqual(touchedDerived(w('updateOne', [], ['$unset: UNSET_VECTOR is not declared']), 'const r = { $set: { matchedText: text } }', D, STATE_FILE), ['matchedText']);
  });
  it('a whole-document upsert of a chunk (replaceOne), by what its function names', () => {
    assert.deepEqual(touchedDerived(w('replaceOne', []), 'const chunkDoc = { content: caption, matchedText: caption, ...vectorFields }', D, STATE_FILE).sort(), ['content', 'matchedText']);
  });
  it('a derived description, by the source marker it sets', () => {
    assert.deepEqual(touchedDerived(w('updateOne', ['description', 'updatedAt', 'seq', 'descriptionSource'], ['x']), '', D, STATE_FILE), ['descriptionSource']);
  });
  it('every write in the module that declares the typed processing state', () => {
    assert.ok(touchedDerived(w('updateMany', [], ['x'], STATE_FILE), '', D, STATE_FILE).length >= 1);
  });
  it('NOT the deletion flag by itself, and NOT a delete', () => {
    assert.deepEqual(touchedDerived(w('updateOne', ['deletedAt']), '', D, STATE_FILE), []);
    assert.deepEqual(touchedDerived(w('deleteMany', []), 'matchedText content', D, STATE_FILE), []);
  });
});

describe('the derivation finds the writes at all, so the rule cannot pass by finding none', () => {
  it('the derived set is read from the tree, and is real FileMetaDoc fields', () => {
    const real = new Set(fileMetaDocFields());
    assert.ok(DERIVED.size >= 15, `only ${DERIVED.size} derived field(s) read — the derivation is thin: ${[...DERIVED]}`);
    for (const f of ['embedding', 'embeddingModel', 'matchedText', 'excerpt', 'embeddingStatus', 'faceEmbedding', 'content', 'descriptionSource']) {
      assert.ok(DERIVED.has(f), `${f} is not in the derived set — the rule would not cover it`);
    }
    for (const f of DERIVED) assert.ok(real.has(f), `'${f}' is derived but is not a FileMetaDoc field`);
    // The names that stay out are real fields the hash does not see — never a hashed one.
    const hashed = new Set(hashedFileFields());
    for (const f of Object.keys(NOT_DERIVED)) {
      assert.ok(real.has(f) && !hashed.has(f), `NOT_DERIVED names '${f}', which is not an unhashed FileMetaDoc field — a stale row`);
    }
  });

  it('found the files-collection writes, among them the ones that write through a computed collection name', () => {
    assert.ok(WRITES.length >= 35, `only ${WRITES.length} write(s) to a files collection found`);
    assert.ok(WRITES.some(w => w.file.endsWith('brain/embed-record.ts')),
      'embed-record.ts writes through `col(collName)` and was not found — the computed-name sites are being skipped');
  });

  it('some write anywhere touches a derived field (otherwise the rule below is vacuous), and the writers are not one function', () => {
    assert.ok(touching.length >= 6, `only ${touching.length} write(s) touch a derived field — the classifier is broken`);
    assert.ok(new Set(touching.map(x => fnKeyOf(x.w))).size >= 3, 'the touching writes belong to fewer than three functions — the classifier is broken');
  });
});

describe('a file row\'s derived fields are written by one module', () => {
  it('the module exists and writes the files collection', () => {
    assert.ok(existsSync(join(REPO_ROOT, OWNER)),
      `${OWNER} does not exist — every derived write is still made where its caller is, each with its own guard (or none)`);
    assert.ok(WRITES.some(w => w.file === OWNER), `${OWNER} writes no file row — it is not the writer`);
  });

  it('every write that touches a derived field is in the module, or a named exemption', () => {
    const outside = touching
      .filter(({ w }) => w.file !== OWNER && !(fnKeyOf(w) in EXEMPT))
      .map(({ w, fields }) => `${w.name} — touches ${fields.join(', ')}${w.unresolved.length ? ' (its keys are not all readable; its function names them)' : ''}`);
    assert.deepEqual(outside, [],
      `these write a field derived from a file's bytes outside ${OWNER}${existsSync(join(REPO_ROOT, OWNER)) ? '' : ' (which does not exist yet)'}. `
      + 'Each is a place that can land a vector, a caption, a chunk, an excerpt or a status mark on a file that was deleted while the job '
      + 'ran, and each answers "is the file still live?" its own way or not at all — a chunk row never carries `deletedAt`, so a predicate '
      + 'on the chunk asks the wrong row. Route the write through the module, or add an EXEMPT entry saying why it computes nothing new');
  });

  it('no write in a source file is left unowned by any function (a site no walk can see)', () => {
    const orphans = RECORDS.orphans
      .filter(o => o.kind === 'space' && (o.collection === 'files' || o.collection == null))
      .map(o => `${o.file}:${o.line} ${o.op}`);
    assert.deepEqual(orphans, [], 'writes that no function owns, so the rule above never saw them');
  });

  it('every exemption still names a function that writes the files collection', () => {
    const live = new Set(WRITES.map(fnKeyOf));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions that no longer write the files collection — delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
  });
});
