/**
 * A file conflict is an edit on BOTH sides since the two last agreed, decided the same way for pull and push (Q-66).
 *
 * Pull raised a conflict for every differing hash, and push overwrote the peer whenever our file was newer: the same
 * question answered by two rules, one of them by clock. Both now read the hash the two ends last both held.
 *
 * Run: node --test testing/standalone/a-file-conflict-is-an-edit-on-both-sides.test.js   (after `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let F;
before(async () => { F = await import('../../server/dist/sync/file-conflict.js'); });
const e = (sha256, modifiedAt = '2026-01-01T00:00:00Z') => ({ path: 'a.md', sha256, modifiedAt });

describe('pull', () => {
  it('new here: write; same: skip', () => {
    assert.equal(F.decideFilePull(undefined, e('x')), 'write');
    assert.equal(F.decideFilePull(e('x'), e('x'), 'o'), 'skip');
  });
  it('only the peer changed it (ours is the base): replace', () => {
    assert.equal(F.decideFilePull(e('base'), e('theirs'), 'base'), 'replace');
  });
  it('only WE changed it (the peer still holds the base): skip, and our push carries it', () => {
    assert.equal(F.decideFilePull(e('ours'), e('base'), 'base'), 'skip');
  });
  it('we changed it too, or nothing is agreed yet: conflict copy', () => {
    assert.equal(F.decideFilePull(e('ours'), e('theirs'), 'base'), 'conflict-copy');
    assert.equal(F.decideFilePull(e('ours'), e('theirs')), 'conflict-copy');
  });
});

describe('push', () => {
  it('the peer lacks it: push; same: skip', () => {
    assert.equal(F.decideFilePush(e('x'), undefined, 'o'), 'push');
    assert.equal(F.decideFilePush(e('x'), e('x'), 'o'), 'skip');
  });
  it('only we changed it (the peer holds the base): push, whatever the clocks say', () => {
    assert.equal(F.decideFilePush(e('ours', '2026-01-01T00:00:00Z'), e('base', '2026-06-01T00:00:00Z'), 'base'), 'push');
  });
  it('the peer changed it too: skip, however much newer ours is — the peer\'s pull raises the conflict', () => {
    assert.equal(F.decideFilePush(e('ours', '2026-06-01T00:00:00Z'), e('theirs', '2026-01-01T00:00:00Z'), 'base'), 'skip');
  });
  it('nothing agreed yet: the newer file wins, as before', () => {
    assert.equal(F.decideFilePush(e('ours', '2026-06-01T00:00:00Z'), e('theirs', '2026-01-01T00:00:00Z')), 'push');
    assert.equal(F.decideFilePush(e('ours', '2026-01-01T00:00:00Z'), e('theirs', '2026-06-01T00:00:00Z')), 'skip');
  });
});

describe('what an instance derives for itself', () => {
  it('a conflict copy, as conflictCopyPath names it, is instance-local', () => {
    const p = F.conflictCopyPath('docs/guide.md', 'ythril-dev', new Date('2026-09-26T20:16:20.631Z'));
    assert.equal(F.isInstanceLocalFile(p), true, p);
    assert.equal(F.isInstanceLocalFile('docs/guide.md'), false);
  });
  it('a schema snapshot is instance-local; an ordinary file under schemas/ is not', () => {
    assert.equal(F.isInstanceLocalFile('schemas/y-flows_entity_Phase.json'), true);
    assert.equal(F.isInstanceLocalFile('schemas/y-tickets_chrono_Work-Log.json'), true);
    assert.equal(F.isInstanceLocalFile('schemas/my-notes.json'), false);
  });
});
