/**
 * The file-row field sets that say what travels and what does not are one fact spelled from several sides, and they agree
 * (bundle-48).
 *
 * ## What it holds
 *
 * Three questions about a file row's keys are each answered by a list written where its subject lives, and a field added to
 * one list and not the next is wrong silently on one side of the wire:
 *
 * 1. **What never travels.** `localFileFields()` (`files/processing-state.ts`) derives it from the HASH side: every
 *    `FileMetaDoc` key the divergence hash does not see, less identity. `FILE_META_SENDER_KEYS` (`api/sync/_shared.ts`)
 *    spells it from the WIRE side: every `FileMetaDoc` key the strict incoming schema does not declare. They are the same
 *    set. A key in the first and not the second is a local field a sender would serve (a vector, a status mark, on a
 *    document a peer then refuses or strips); a key in the second and not the first is a field the wire drops that the hash
 *    still counts, a permanent false `MERKLE_DIVERGENCE`.
 * 2. **What a removal reaches.** A field a person may delete (`DELETABLE_FILE_META_FIELDS`, `files/file-meta.ts`) is either
 *    AUTHORED (`FILE_META_AUTHORED_KEYS`, the wire's own set) — then its removal must replicate, and a deletable field missing
 *    from the authored set removes here and comes back from every peer on the next pull — or LOCAL (a derived field such as
 *    `excerpt`), whose removal is this instance's alone. A deletable field that is neither has no rule at all.
 * 3. **What a receiver rewrites.** `spaceId` is not local although the hash does not see it: it is the receiver's retag
 *    (`RETAGGED_FIELDS`, `sync/retagged-fields.ts`). `localFileFields()` must not contain any retagged field, however the
 *    retag list grows.
 *
 * Each set is DERIVED from its module, never listed here, and a floor says the derivation found something.
 *
 * Run: node --test testing/standalone/the-file-field-sets-agree.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { localFileFields, isLocalFileField } = await import('../../server/dist/files/processing-state.js');
const { FILE_META_SENDER_KEYS, FILE_META_AUTHORED_KEYS } = await import('../../server/dist/api/sync/_shared.js');
const { DELETABLE_FILE_META_FIELDS } = await import('../../server/dist/files/file-meta.js');
const { RETAGGED_FIELDS } = await import('../../server/dist/sync/retagged-fields.js');

const sorted = (xs) => [...xs].sort();

describe('the file-row field sets agree', () => {
  it('finds each set, so an empty derivation cannot pass the checks below', () => {
    assert.ok(localFileFields().size >= 10, 'localFileFields() found almost nothing: the derivation is broken, not the code');
    assert.ok(Object.keys(FILE_META_SENDER_KEYS).length >= 10, 'FILE_META_SENDER_KEYS is nearly empty');
    assert.ok(FILE_META_AUTHORED_KEYS.size >= 4, 'FILE_META_AUTHORED_KEYS is nearly empty');
    assert.ok(DELETABLE_FILE_META_FIELDS.length >= 1, 'no deletable file field was found');
    assert.ok(RETAGGED_FIELDS.size >= 1, 'no retagged field was found');
  });

  it('the keys that never travel are one set: local by the hash, and not declared by the wire', () => {
    const byHash = sorted(localFileFields());
    const byWire = sorted(Object.keys(FILE_META_SENDER_KEYS));
    assert.deepEqual(byHash, byWire,
      'the hash side (`localFileFields`, files/processing-state.ts) and the wire side (`FILE_META_SENDER_KEYS`, api/sync/_shared.ts) '
      + 'disagree about which file-row keys stay on this instance: a field added to one list and not the other is served, or hashed, wrongly');
  });

  it('no retagged field is a local field', () => {
    for (const field of RETAGGED_FIELDS) {
      assert.equal(isLocalFileField(field), false,
        `'${field}' is retagged on arrival (sync/retagged-fields.ts) and is not local state: it crosses the wire and the receiver replaces it`);
    }
  });

  it('a deletable field is authored (its removal replicates) or local (its removal is this instance\'s alone)', () => {
    const neither = DELETABLE_FILE_META_FIELDS.filter(f => !FILE_META_AUTHORED_KEYS.has(f) && !isLocalFileField(f));
    assert.deepEqual(neither, [],
      'a field a person may delete that the wire does not declare as authored and that is not local: removing it here would '
      + 'come back from a peer on the next pull, or has no rule at all');
    // The authored half is the one that matters most: every authored deletable field is on the wire's own list.
    const authored = DELETABLE_FILE_META_FIELDS.filter(f => !isLocalFileField(f));
    assert.ok(authored.length >= 1, 'no deletable field is authored: the removal-crosses-the-wire half of this check looked at nothing');
    for (const f of authored) assert.ok(FILE_META_AUTHORED_KEYS.has(f), `${f} is deletable but its removal does not replicate`);
  });
});
