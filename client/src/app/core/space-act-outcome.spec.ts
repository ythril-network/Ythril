/**
 * `spaceActOutcome(httpStatus, body)` — the ONE reading of what a space delete or wipe answered (Q-535, plan rev 2 "Contract" and
 * design 1).
 *
 * ## What it prevents
 *
 * The client read a delete or wipe answer as `{ pending: status === 202 }`. That folded four different 202s into one (a vote is open; the
 * vote passed and the act still runs; the act is owed with a retry time; a local act queued), dropped every 200 body (a networked delete
 * that left the space HERE because another network holds it was read as "gone" and the space vanished from the list; a subscriber's wipe
 * that refills from the publisher was read as "empty for good"), and threw every 500/503 body away, so a failed act the server retries
 * read the same as one nothing will retry.
 *
 * The order is part of the contract: HTTP status first; within a 202, `queued` before `status` (a voted queued answer carries
 * `status: 'passed'` too); a 404 on a delete is "already gone", which is done.
 *
 * Every body below is a REAL server shape (`testing/space-act-bodies.ts` says where each comes from).
 */
import { describe, it, expect } from 'vitest';
import { spaceActOutcome } from './space-act-outcome';
import { DELETE_ANSWERS as D, WIPE_ANSWERS as W, RETRY_AHEAD, RETRY_PAST, type WireAnswer } from '../testing/space-act-bodies';

const read = (a: WireAnswer) => spaceActOutcome(a.status, a.body);

describe('spaceActOutcome — a delete answer', () => {
  it('204: a local delete completed — done', () => {
    expect(read(D.localDone)).toMatchObject({ kind: 'done' });
  });

  it('200 deleted, removedHere true: done, and the space is gone here', () => {
    const o = read(D.votedDone);
    expect(o).toMatchObject({ kind: 'done' });
    expect((o as { removedHere?: boolean }).removedHere).not.toBe(false);
  });

  it('200 deleted, removedHere false: done on the network, but THIS instance keeps the space (another network holds it)', () => {
    expect(read(D.votedDoneKeptHere)).toMatchObject({ kind: 'done', removedHere: false });
  });

  it('200 repeated: the door joined the standing act, which completed — done, repeated', () => {
    expect(read(D.repeatedDone)).toMatchObject({ kind: 'done', repeated: true });
    expect(read(D.localRepeatedDone)).toMatchObject({ kind: 'done', repeated: true });
  });

  it('202 vote_pending: a vote is open — vote-pending, with its rounds', () => {
    const o = read(D.votePending);
    expect(o).toMatchObject({ kind: 'vote-pending' });
    expect((o as { rounds?: unknown[] }).rounds).toHaveLength(1);
    expect(read(D.votePendingRepeated)).toMatchObject({ kind: 'vote-pending' });
  });

  it('202 queued after a vote: queued BEFORE status — voted, with the retry time', () => {
    expect(read(D.votedQueued)).toMatchObject({ kind: 'queued', voted: true, retryAt: RETRY_AHEAD });
  });

  it('202 queued with no retry time (still running past the door\'s budget): queued, no retryAt', () => {
    const o = read(D.votedQueuedRunning);
    expect(o).toMatchObject({ kind: 'queued', voted: true });
    expect((o as { retryAt?: string }).retryAt).toBeUndefined();
  });

  it('202 queued with no vote (a local act): queued, not voted', () => {
    expect(read(D.localQueued)).toMatchObject({ kind: 'queued', voted: false, retryAt: RETRY_AHEAD });
    expect(read(D.localQueuedOverdue)).toMatchObject({ kind: 'queued', voted: false, retryAt: RETRY_PAST });
    expect(read(D.localQueuedRunning)).toMatchObject({ kind: 'queued', voted: false });
  });

  it('500 space_act_failed after a vote: failed, and retried by the server', () => {
    expect(read(D.votedFailed)).toMatchObject({ kind: 'failed', retried: true });
  });

  it('500 space_act_failed on a local act: failed, and retried by the server', () => {
    expect(read(D.localFailed)).toMatchObject({ kind: 'failed', retried: true });
  });

  it('500 with no code (the route\'s caught-failure fallback): failed, and NOT retried', () => {
    expect(read(D.caughtFailure)).toMatchObject({ kind: 'failed', retried: false });
  });

  it('503 from the store (voted or local) and 503 shutting down: failed, retried', () => {
    expect(read(D.votedStoreDown)).toMatchObject({ kind: 'failed', retried: true });
    expect(read(D.localStoreDown)).toMatchObject({ kind: 'failed', retried: true });
    expect(read(D.shuttingDown)).toMatchObject({ kind: 'failed', retried: true });
  });

  it('a failed outcome carries a message string', () => {
    for (const a of [D.votedFailed, D.localFailed, D.caughtFailure, D.votedStoreDown, D.shuttingDown]) {
      const o = read(a) as { message?: unknown };
      expect(typeof o.message, JSON.stringify(a.body)).toBe('string');
    }
  });

  it('404 on a delete: the space is already gone — done', () => {
    expect(read(D.alreadyGone)).toMatchObject({ kind: 'done' });
  });
});

describe('spaceActOutcome — a wipe answer', () => {
  it('200 wiped: done, with the counts', () => {
    expect(read(W.localDone)).toMatchObject({ kind: 'done', deleted: { facts: 3, entities: 2 } });
    expect(read(W.votedDone)).toMatchObject({ kind: 'done', deleted: { facts: 3 } });
  });

  it('200 wiped, refills: a subscriber\'s copy refills from the publisher at the next sync', () => {
    expect(read(W.subscriberRefills)).toMatchObject({ kind: 'done', refills: true });
  });

  it('200 wiped, repeated: done, repeated', () => {
    expect(read(W.repeatedDone)).toMatchObject({ kind: 'done', repeated: true });
  });

  it('202 vote_pending / queued (voted and local): as on a delete', () => {
    expect(read(W.votePending)).toMatchObject({ kind: 'vote-pending' });
    expect(read(W.votedQueued)).toMatchObject({ kind: 'queued', voted: true, retryAt: RETRY_AHEAD });
    expect(read(W.localQueued)).toMatchObject({ kind: 'queued', voted: false, retryAt: RETRY_AHEAD });
  });

  it('500/503: failed, retried unless the body is the caught-failure fallback', () => {
    expect(read(W.votedFailed)).toMatchObject({ kind: 'failed', retried: true });
    expect(read(W.localFailed)).toMatchObject({ kind: 'failed', retried: true });
    expect(read(W.caughtFailure)).toMatchObject({ kind: 'failed', retried: false });
    expect(read(W.votedStoreDown)).toMatchObject({ kind: 'failed', retried: true });
    expect(read(W.shuttingDown)).toMatchObject({ kind: 'failed', retried: true });
  });
});
