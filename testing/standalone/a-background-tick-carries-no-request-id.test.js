/**
 * A background tick never runs inside the request that happened to arm it (bundle-53 G32, finding A of the end-to-end verification).
 *
 * ## The defect
 *
 * Node timers inherit the `AsyncLocalStorage` context they were created in. The logger stamps every line with the request id it reads from
 * one (`util/log.ts`, `runWithRequestId`). A job armed while a request was being handled therefore ran EVERY tick inside that request's
 * context: on a first-run instance the TTL sweep is started from `/setup`, and its failure line carried the setup request's id for as long as
 * the process lived. The guide says a sweep's lines carry no id, and a line stamped with somebody else's request id is worse than one with
 * none: an operator searching the log for that request finds a line from a sweep that has nothing to do with it.
 *
 * Cron ticks leak the same way, and more often: `rearmCronSchedulers` runs inside the `POST /api/admin/reload-config` request, so the
 * dupe scanner, the contradiction scanner and the backup scheduler were armed there and ran under its id.
 *
 * ## What this holds
 *
 *  1. an `intervalJob` started inside a request: its tick, and the failure line the tick says, carry no request id, on the real timer
 *     AND when the timer's callback is fired from inside another request's context (a seam's `arm`, which is the case a guard that only
 *     cleared the context at arm time would miss);
 *  2. `outsideRequest` (the guard `intervalJob` uses) returns what it was given, shows no id to what it runs and to its continuations,
 *     and leaves the caller's own context alone;
 *  3. EVERY cron registration the tree makes (`_scheduled-jobs.mjs`, derived) runs its tick through `outsideRequest` — the registration
 *     is a library call and cannot have the guard put inside it, so the gate is what holds the four sites to it. `runExclusive` is NOT
 *     the place: a manual scan started from a route is a request's own work and keeps the request's id.
 *
 * Mutations seen red (restored by hand): `outsideRequest` removed from the interval tick (1); `exit` replaced by a plain call (2); the
 * dupe scanner's registration put back to a bare callback (3).
 *
 * Run: node --test testing/standalone/a-background-tick-carries-no-request-id.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex } from './_call-graph.mjs';
import { scheduledJobs, JOB_FLOORS } from './_scheduled-jobs.mjs';

let log, intervalJob, unsubscribe;
const lines = [];

before(async () => {
  log = await import('../../server/dist/util/log.js');
  ({ intervalJob } = await import('../../server/dist/util/interval-job.js'));
  unsubscribe = log.subscribeLogLines(l => lines.push(l));
});
after(() => { unsubscribe?.(); });

const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};

describe('a job armed inside a request does not run inside it', () => {
  it('control: the logger really stamps a line written inside a request', () => {
    lines.length = 0;
    log.runWithRequestId('req-control', () => { log.log.warn('a line inside a request'); });
    assert.ok(lines.some(l => l.includes('req-control') && l.includes('a line inside a request')),
      `the logger does not stamp request lines, so nothing below proves anything:\n${lines.join('\n')}`);
  });

  it('the real timer: ticks of a job started inside a request see no request id, and its failure line carries none', async () => {
    lines.length = 0;
    const seen = [];
    let job;
    log.runWithRequestId('req-real-timer', () => {
      job = intervalJob('g32 real timer job', 20, async () => {
        seen.push(log.currentRequestId());
        throw new Error('the tick failed');
      });
      job.start();
    });
    try {
      await until(() => seen.length >= 2 && lines.some(l => l.includes('g32 real timer job failed')));
    } finally { job.stop(); }

    assert.deepEqual(seen.filter(id => id !== undefined), [], `a tick ran inside the request that armed it: ${JSON.stringify(seen)}`);
    const failure = lines.find(l => l.includes('g32 real timer job failed'));
    assert.ok(!failure.includes('req-real-timer'), `the job's failure line carries the id of the request that started it: ${failure}`);
  });

  it('a timer callback fired from inside ANOTHER request\'s context still ticks outside every request', async () => {
    lines.length = 0;
    let fire;
    const seen = [];
    const job = intervalJob('g32 seam job', 60_000, async () => {
      seen.push(log.currentRequestId());
      throw new Error('the seam tick failed');
    }, { arm: (fn) => { fire = fn; return { unref() {} }; }, disarm: () => {} });
    log.runWithRequestId('req-armed-here', () => { job.start(); });
    log.runWithRequestId('req-fired-here', () => { fire(); });
    await until(() => seen.length === 1 && lines.some(l => l.includes('g32 seam job failed')));
    job.stop();

    assert.deepEqual(seen, [undefined], `the tick saw a request id: ${JSON.stringify(seen)}`);
    const failure = lines.find(l => l.includes('g32 seam job failed'));
    assert.ok(!/req-(armed|fired)-here/.test(failure), `the failure line carries a request id: ${failure}`);
  });
});

describe('outsideRequest', () => {
  it('is exported by the logger, which owns the context', () => {
    assert.equal(typeof log.outsideRequest, 'function', 'util/log.ts exports no outsideRequest: there is no guard to run a background tick through');
  });

  it('returns the value, hides the id from what it runs and from its continuations, and leaves the caller\'s context alone', async () => {
    assert.equal(typeof log.outsideRequest, 'function', 'util/log.ts exports no outsideRequest');
    await log.runWithRequestId('req-outer', async () => {
      const inside = [];
      const value = await log.outsideRequest(async () => {
        inside.push(log.currentRequestId());
        await new Promise(r => setTimeout(r, 5));
        inside.push(log.currentRequestId());
        return 42;
      });
      assert.equal(value, 42, 'the value the function returned is lost');
      assert.deepEqual(inside, [undefined, undefined], `the function or its continuation saw the request id: ${JSON.stringify(inside)}`);
      assert.equal(log.currentRequestId(), 'req-outer', 'the caller\'s own request id was taken away');
    });
  });
});

describe('every cron registration runs its tick outside the request that armed it', () => {
  const index = moduleIndex('server/src');
  const { jobs } = scheduledJobs(index);
  const crons = jobs.filter(j => j.kind === 'cron');

  it('control: the derivation finds the cron registrations (its own floor)', () => {
    assert.ok(crons.length >= JOB_FLOORS.cron, `${crons.length} cron registrations found, floor ${JOB_FLOORS.cron}`);
  });

  it('each one\'s callback goes through outsideRequest', () => {
    const bare = crons.filter(j => !/\boutsideRequest\s*\(/.test(j.run)).map(j => `${j.file}@${j.at}`);
    assert.deepEqual(bare, [],
      `these cron registrations run their tick in the context of whoever armed them (a reload request arms three of them): ${bare.join(', ')}`);
  });
});
