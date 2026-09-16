/**
 * Standalone unit tests for the sticky-dismissal policy — `decideDismissed`.
 *
 * This is the crux of the item-19 fix: a dismissed duplicate pair must NOT resurface when a record is
 * merely re-written (edit that leaves content identical, peer re-sync, re-embed, index rebuild — all
 * of which advance `seq`), but MUST resurface when the pair's CONTENT materially changes. The policy
 * is pure (no DB), so every branch is checked here rather than relying on a live re-embed — which the
 * public API cannot trigger without also changing content.
 *
 * Run: node --test testing/standalone/dupe-dismissed-sticky.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideDismissed, DEFAULT_TYPES } from '../../server/dist/brain/dupe-scanner.js';

describe('duplicate scanner — swept types', () => {
  it('sweeps chrono by default', () => {
    // Logging the same event twice is one of the commonest ways a knowledge base goes redundant, and
    // chrono was in neither scanner's defaults — so nothing was looking for it.
    assert.ok(DEFAULT_TYPES.includes('chrono'));
    assert.ok(DEFAULT_TYPES.includes('fact') && DEFAULT_TYPES.includes('entity'));
  });
});

describe('decideDismissed — sticky-until-content-changes policy', () => {
  it('seqs unchanged → keep (stay dismissed, no work) regardless of hash', () => {
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 5, 9, 'abc'), 'keep');
    // even if the hash somehow differs, identical seqs mean nothing was re-written
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 5, 9, 'zzz'), 'keep');
  });

  it('seq bumped but content hash identical → refresh (a re-embed / re-sync — stays dismissed)', () => {
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 6, 9, 'abc'), 'refresh');
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 6, 10, 'abc'), 'refresh');
  });

  it('seq bumped and content hash differs → reopen (a real edit resurfaces the pair)', () => {
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 6, 9, 'DEF'), 'reopen');
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: 'abc' }, 5, 11, 'DEF'), 'reopen');
  });

  it('legacy dismissal with no baseline hash → refresh (stays dismissed, back-fills; no resurface on upgrade)', () => {
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9, dismissedContentHash: undefined }, 6, 9, 'anything'), 'refresh');
    assert.equal(decideDismissed({ aSeq: 5, bSeq: 9 }, 7, 12, 'anything'), 'refresh');
  });
});
