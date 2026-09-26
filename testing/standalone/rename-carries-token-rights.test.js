/**
 * Renaming a space carries every token's scope with it — the rights MATRIX, not only the legacy allowlist.
 *
 * ## The defect
 *
 * `applySpaceRenameToConfig` re-keyed `tok.spaces` and nothing anywhere touched `rights.perSpace`. So a
 * rename silently stripped every matrix-scoped token's access to the space: the row stayed under the OLD id,
 * which now names nothing.
 *
 * That is **every token minted since 2.9**. The rights editor writes `perSpace`; nothing writes the
 * allowlist — the mint route's own refusal map tells a caller to use `rights.perSpace` instead. So the half
 * that was maintained was the half nobody has.
 *
 * It fails silently at both ends: no error when renaming, and later a 403 that reads as though the rights
 * were never granted. Found while measuring the `spaces` field deletion — and worth fixing first, because
 * deleting the field without this would have removed the only rename handling that existed.
 *
 * ## Exercised, not grepped
 *
 * `applySpaceRenameToConfig` is exported and operates on a plain config object, so these are real calls with
 * real verdicts. A source-reading test could not tell a re-key that runs from one that is unreachable.
 *
 * Run: node --test testing/standalone/rename-carries-token-rights.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let applySpaceRenameToConfig;
before(async () => {
  ({ applySpaceRenameToConfig } = await import('../../server/dist/spaces/rename.js'));
});

const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });

/** A config holding one space and whatever tokens a test needs. */
const cfgWith = (tokens) => ({
  instanceId: 'i', instanceLabel: 'I',
  spaces: [{ id: 'old', label: 'Old' }],
  networks: [],
  tokens,
});

const space = (cfg) => cfg.spaces.find(s => s.id === 'old') ?? cfg.spaces[0];

describe('the matrix row follows the rename', () => {
  it('perSpace is re-keyed from the old id to the new one', () => {
    const cfg = cfgWith([{ id: 't1', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { old: ALL('write') } } }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');

    const perSpace = cfg.tokens[0].rights.perSpace;
    assert.deepEqual(perSpace['new'], ALL('write'), 'the row must move to the new id');
    assert.equal(perSpace['old'], undefined, 'and must not be left behind under a name that no longer exists');
  });

  it('the rung is carried unchanged — a rename is not a re-grant', () => {
    const cfg = cfgWith([{ id: 't1', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { old: { knowledge: 'admin', files: 'read', schema: 'none', dataQuality: 'write' } } } }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    assert.deepEqual(cfg.tokens[0].rights.perSpace['new'],
      { knowledge: 'admin', files: 'read', schema: 'none', dataQuality: 'write' });
  });

  it('a token with a row for a DIFFERENT space is untouched', () => {
    const cfg = cfgWith([{ id: 't1', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { other: ALL('read') } } }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    assert.deepEqual(Object.keys(cfg.tokens[0].rights.perSpace), ['other']);
  });

  it('a token with no matrix at all does not throw', () => {
    // A record with no `rights` must be SKIPPED, not crash the rename. It no longer gets an allowlist
    // re-keyed either — `TokenRecord.spaces` was deleted in the change that followed this one, and its only
    // remaining readers derive a matrix from it at load. A stored config still holding one is pre-migration
    // by definition, and the boot backfill gives it a matrix before any rename can reach it.
    const cfg = cfgWith([{ id: 't1' }, { id: 't2' }]);
    assert.doesNotThrow(() => applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new'));
  });

  it('every token is carried, not just the first', () => {
    // A loop that returned early would pass a single-token fixture and strip everyone else.
    const mk = () => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: { old: ALL('write') } });
    const cfg = cfgWith([{ id: 'a', rights: mk() }, { id: 'b', rights: mk() }, { id: 'c', rights: mk() }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    for (const t of cfg.tokens) {
      assert.deepEqual(t.rights.perSpace['new'], ALL('write'), `${t.id} lost its scope`);
      assert.equal(t.rights.perSpace['old'], undefined, `${t.id} kept a dead key`);
    }
  });
});

describe('it refuses to overwrite an existing row', () => {
  it('a token already holding rights at the NEW id keeps them', () => {
    // `perSpace` is keyed by id, so re-keying is a move within an object rather than an index swap: a row
    // already at `newId` would be silently replaced by one that used to be somewhere else, widening or
    // narrowing that token with nothing to show for it.
    //
    // The rename route refuses a `newId` that already exists, so this is unreachable through the API — but
    // this function is also reached on resume after a crash, and an unreviewable clobber is not worth the
    // two lines it saves.
    const cfg = cfgWith([{
      id: 't1',
      rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { old: ALL('read'), new: ALL('admin') } },
    }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    assert.deepEqual(cfg.tokens[0].rights.perSpace['new'], ALL('admin'),
      'the existing row wins — a rename must not silently re-grant');
  });
});

describe('the legacy half went with the field', () => {
  it('the allowlist is no longer re-keyed, because it no longer exists', () => {
    // These two cases asserted that `tok.spaces` was carried, which was the ONLY thing the rename did until
    // the fix above. `TokenRecord.spaces` was deleted in the change that followed, so re-keying it would be
    // dead code wearing the shape of a safeguard — and the matrix re-key is what carries a token's scope.
    //
    // Inverted rather than deleted, so a reader finding no allowlist handling in `rename.ts` can see it was
    // removed deliberately rather than forgotten.
    // Comments stripped: the doc block above the loop EXPLAINS the old `tok.spaces` re-key, so a raw read
    // fires on the sentence describing the fix. This repo has a rule about that, and this is the third time
    // it has applied.
    const src = stripComments(readFileSync('server/src/spaces/rename.ts', 'utf8'));
    assert.doesNotMatch(src, /tok\.spaces/, 'nothing should re-key a deleted field');
    assert.match(src, /perSpace\[newId\] = perSpace\[oldId\]/, 'the matrix re-key is the whole of it now');
  });
});

describe('every place a token names the space follows the rename (Q-58)', () => {
  // Found renaming `flows` to `y-flows`: `perSpace` moved, `spaceAdmin.spaces` stayed on the old id, and the
  // renamed space silently lost its named administrators. The rule is asserted over the whole rights object,
  // not per field, so a space-keyed field added later is covered without anybody remembering this file.
  const everywhere = () => ({
    instanceAdmin: false, createSpaces: false, floor: null,
    perSpace: { old: ALL('read'), other: ALL('write') },
    spaceAdmin: { floor: false, spaces: ['old', 'other'] },
  });

  it('a space administered by name is still administered under its new id', () => {
    const cfg = cfgWith([{ id: 't1', rights: everywhere() }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    assert.deepEqual(cfg.tokens[0].rights.spaceAdmin, { floor: false, spaces: ['new', 'other'] });
  });

  it('no field of the rights still names the old id, and the other space is untouched', () => {
    const cfg = cfgWith([{ id: 't1', rights: everywhere() }]);
    applySpaceRenameToConfig(cfg, space(cfg), 'old', 'new');
    const json = JSON.stringify(cfg.tokens[0].rights);
    assert.doesNotMatch(json, /"old"/, `a field still names the old space id: ${json}`);
    assert.equal(json.match(/"other"/g)?.length, 2, 'the space that was not renamed must keep both its mentions');
  });
});
