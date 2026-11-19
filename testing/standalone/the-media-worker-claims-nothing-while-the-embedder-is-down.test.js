/**
 * The media worker claims NOTHING while the embedder is known to be unavailable, and finds out it is back with one short embed call.
 *
 * ## What it prevents
 *
 * A media job whose run found the embedder unavailable for the whole of it is handed back without spending an attempt, and with no cap
 * on how often (`a-media-job-waits-for-an-unavailable-embedder-db.test.js`). Without a gate in front of the claim, every queued file
 * would be claimed in turn during an outage, and each claim pays for its vision, speech-to-text or conversion work before it meets
 * the embedder again. So a hand-back starts a pause of the media worker's OWN; while it runs nothing is claimed and nothing is probed;
 * when it has run out the claim first probes the embedder with one short call. The release mirrors the entry: only a PROVEN outage
 * (`isEmbedderUnavailable`) starts the next, longer pause and claims nothing; every other outcome (a vector, a refusal, an outage by
 * words alone, the request a lost process was holding) ends the pause and the claim goes on.
 *
 * The pause is not the embed worker's: that one's ending is pinned by its own gate, and a media run that never called the embedder
 * must not end it, nor stopping the media worker cancel it. The claim also waits out a restart of the inference process, as the embed
 * worker's claim does.
 *
 * ## The cases
 *
 * Driven through `createMediaClaimGate` with a real pause on a fake clock, a fake probe and a fake claim; and through the worker's own
 * gate (`mediaClaimGate`) for what it is wired to: the inference host's restart wait, its own pause, the worker's stop, and the probe
 * counter `ythril_media_embedder_probes_total{outcome}`.
 *
 * Run: node --test testing/standalone/the-media-worker-claims-nothing-while-the-embedder-is-down.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { metricSeries } from './_metric-series.mjs';
import { elapse } from '../_shared/sleep.mjs';

const gateMod = await import('../../server/dist/files/media/embedder-outage-gate.js').catch(err => ({ loadError: err }));
const pauseMod = await import('../../server/dist/brain/embedder-outage-pause.js');
const errors = await import('../../server/dist/brain/embed-errors.js');
const inference = await import('../../server/dist/brain/local-inference.js');

/** A turn of the event loop and a little more: long enough for a claim that is not held to have called what it calls. */
const settle = () => elapse(30, 'absence window: a claim that is not held would have probed or claimed by now');

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/**
 * A gate on a real pause with a fake clock, a probe that answers as `probeAnswer()` says, a claim that counts, and an inference host
 * whose restart wait resolves at once unless `restart` is held.
 */
function harness({ probeAnswer = () => undefined } = {}) {
  const clock = fakeClock();
  const pause = pauseMod.createEmbedderOutagePause({ now: clock.now });
  const calls = { probes: 0, claims: 0 };
  let releaseRestart = null;
  const restart = { held: false };
  const gate = gateMod.createMediaClaimGate({
    pause,
    probe: async () => { calls.probes++; const answer = probeAnswer(); if (answer instanceof Error || typeof answer === 'string') throw answer; return answer; },
    waitOutRestart: () => restart.held ? new Promise(resolve => { releaseRestart = resolve; }) : Promise.resolve(),
  });
  const claimJob = async () => { calls.claims++; return { _id: `job-${calls.claims}` }; };
  return {
    clock, pause, gate, calls, claimJob, restart,
    releaseRestart: () => { restart.held = false; releaseRestart?.(); },
    /** Move the clock past the pause the gate now owes. */
    runOut: () => clock.advance(pause.remainingMs() + 1),
  };
}

const running = () => true;

describe('the module is there', () => {
  it('embedder-outage-gate.js exports createMediaClaimGate and the worker\'s own gate, mediaClaimGate', () => {
    assert.equal(gateMod.loadError, undefined, `files/media/embedder-outage-gate.js does not load: ${gateMod.loadError?.message}`);
    assert.equal(typeof gateMod.createMediaClaimGate, 'function');
    assert.equal(typeof gateMod.mediaClaimGate?.claim, 'function');
  });
});

describe('the claim, with no outage known', () => {
  it('claims at once and probes nothing', async () => {
    const h = harness();
    const job = await h.gate.claim(h.claimJob, running);
    assert.deepEqual(job, { _id: 'job-1' });
    assert.deepEqual(h.calls, { probes: 0, claims: 1 });
  });
});

describe('after a hand-back', () => {
  it('while the pause runs, nothing is claimed and nothing is probed; a stop then ends the wait and claims nothing', async () => {
    const h = harness();
    const owed = h.gate.noteHandBack();
    assert.ok(owed > 0 && h.pause.remainingMs() === owed, `a hand-back started no pause (owed ${owed}, left ${h.pause.remainingMs()})`);
    let isRunning = true;
    const pending = h.gate.claim(h.claimJob, () => isRunning);
    await settle();
    assert.deepEqual(h.calls, { probes: 0, claims: 0 }, 'the worker claimed or probed while the pause was running');
    isRunning = false;
    h.gate.cancel();
    assert.equal(await pending, null, 'a claim that the stop released handed back a job');
    assert.deepEqual(h.calls, { probes: 0, claims: 0 }, 'a stopped worker probed or claimed');
  });

  it('when the pause has run out, ONE probe is made, and an answer ends the outage and claims; the next claim probes no more', async () => {
    const h = harness({ probeAnswer: () => ({ vector: [0.1], model: 'm', dimensions: 1 }) });
    h.gate.noteHandBack();
    h.runOut();
    assert.deepEqual(await h.gate.claim(h.claimJob, running), { _id: 'job-1' });
    assert.deepEqual(h.calls, { probes: 1, claims: 1 });
    await h.gate.claim(h.claimJob, running);
    assert.deepEqual(h.calls, { probes: 1, claims: 2 }, 'the outage did not end with the answered probe');
    assert.equal(h.gate.outageRemainingMs(), 0);
  });

  it('a probe that fails as an outage claims nothing and starts the next, longer pause; the claim after it probes again', async () => {
    const h = harness({ probeAnswer: () => new errors.EmbedUnreachableError('Could not reach embedding endpoint at http://127.0.0.1:9.') });
    const first = h.gate.noteHandBack();
    h.runOut();
    assert.equal(await h.gate.claim(h.claimJob, running), null, 'a failed probe went on to claim');
    assert.deepEqual(h.calls, { probes: 1, claims: 0 });
    const second = h.pause.remainingMs();
    assert.ok(second > first, `the pause after a failed probe (${second} ms) is not longer than the one before it (${first} ms)`);
    h.runOut();
    assert.equal(await h.gate.claim(h.claimJob, running), null);
    assert.deepEqual(h.calls, { probes: 2, claims: 0 });
    assert.ok(h.pause.remainingMs() > second, 'the pause did not grow again');
  });

  /**
   * Each failure a probe can meet, and whether it ends the pause. The release is the mirror of the entry: only a PROVEN outage
   * (`isEmbedderUnavailable`) keeps the pause, as only a proven outage starts one. An outage by words (a bundled model that cannot load
   * rejects with a plain error saying "fetch failed") or the request a lost process held would otherwise hold every claim for ever.
   */
  const VERDICTS = [
    ['an unreachable endpoint (outage, proven)', () => new errors.EmbedUnreachableError('Could not reach embedding endpoint'), false],
    ['a 503 (outage, proven)', () => new errors.EmbeddingHttpError(503, 'service unavailable', null), false],
    ['a 522 from a proxy (outage, proven)', () => new errors.EmbeddingHttpError(522, 'origin did not answer', null), false],
    ['a request the lost process was never sent (outage, proven)', () => new errors.LostChildError('code=1', { inFlight: false }), false],
    ['the request the lost process held (lost)', () => new errors.LostChildError('code=139', { inFlight: true }), true],
    ['a child\'s text that reads like a timeout (outage, by words)', () => new Error('timeout waiting for the model'), true],
    ['a bundled model that cannot load (outage, by words)', () => new Error('fetch failed'), true],
    ['a 401 (record: the embedder spoke)', () => new errors.EmbeddingHttpError(401, 'bad key', null), true],
    ['a 400 (record)', () => new errors.EmbeddingHttpError(400, 'bad input', null), true],
    ['a 413 (ends: the embedder spoke)', () => new errors.EmbeddingHttpError(413, 'too large', null), true],
  ];
  for (const [what, failure, answered] of VERDICTS) {
    it(`a probe that fails with ${what} ${answered ? 'ends the pause: the claim goes on' : 'keeps the pause: nothing is claimed'}`, async () => {
      const h = harness({ probeAnswer: failure });
      h.gate.noteHandBack();
      h.runOut();
      const job = await h.gate.claim(h.claimJob, running);
      assert.equal(h.calls.probes, 1);
      if (answered) {
        assert.deepEqual(job, { _id: 'job-1' }, 'the embedder answered and the claim did not go on');
        assert.equal(h.pause.remainingMs(), 0, 'an answered probe left a pause');
      } else {
        assert.equal(job, null, 'the embedder did not answer and a job was claimed');
        assert.equal(h.calls.claims, 0);
        assert.ok(h.pause.remainingMs() > 0, 'an unanswered probe started no pause');
      }
    });
  }

  it('waits out a restart of the inference process before it claims', async () => {
    const h = harness();
    h.restart.held = true;
    const pending = h.gate.claim(h.claimJob, running);
    await settle();
    assert.equal(h.calls.claims, 0, 'claimed while the inference process was restarting');
    h.releaseRestart();
    assert.deepEqual(await pending, { _id: 'job-1' });
  });
});

describe('the worker\'s own gate', () => {
  afterEach(() => {
    gateMod.mediaClaimGate?.cancel();
    pauseMod.embedderOutagePause.noteEmbedded();
    inference._setLocalInferenceForTests(null);
  });

  it('waits out the inference host\'s restart (`waitOutLocalInferenceBackoff`), as the embed worker\'s claim does', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    inference._setLocalInferenceForTests({ waitOutBackoff: () => held });
    let claims = 0;
    const pending = gateMod.mediaClaimGate.claim(async () => { claims++; return null; }, running);
    await settle();
    assert.equal(claims, 0, 'the worker\'s claim did not wait for the inference process to come back');
    release();
    await pending;
    assert.equal(claims, 1);
  });

  it('has a pause of its own: the embed worker\'s pause neither holds it nor is ended by it', () => {
    pauseMod.embedderOutagePause.noteUnreachable();
    assert.equal(gateMod.mediaClaimGate.outageRemainingMs(), 0, 'an outage the embed worker noted holds the media claim');
    gateMod.mediaClaimGate.noteHandBack();
    pauseMod.embedderOutagePause.noteEmbedded();
    assert.ok(gateMod.mediaClaimGate.outageRemainingMs() > 0, 'an embed the embed worker made ended the media worker\'s pause');
    pauseMod.embedderOutagePause.noteUnreachable();
    gateMod.mediaClaimGate.cancel();
    assert.ok(pauseMod.embedderOutagePause.remainingMs() > 0, 'cancelling the media worker\'s pause cancelled the embed worker\'s');
  });

  it('stopping the media worker cancels its pause, and not the embed worker\'s', async () => {
    const worker = await import('../../server/dist/files/media/worker.js');
    gateMod.mediaClaimGate.noteHandBack();
    pauseMod.embedderOutagePause.noteUnreachable();
    worker.stopMediaEmbeddingWorker();
    assert.equal(gateMod.mediaClaimGate.outageRemainingMs(), 0, 'the stop left the media worker\'s pause running, which would delay a restart of the worker');
    assert.ok(pauseMod.embedderOutagePause.remainingMs() > 0, 'stopping the media worker ended the embed worker\'s pause');
  });
});

describe('what an operator sees', () => {
  const PROBES = 'ythril_media_embedder_probes_total';
  const count = async (outcome) => (await metricSeries(PROBES, { labels: { outcome } }))[0].value;

  it('the probe counter has exactly the outcomes `answered` and `unavailable`, each declared at zero', async () => {
    const series = await metricSeries(PROBES);
    assert.deepEqual(series.map(s => s.labels.outcome).sort(), ['answered', 'unavailable']);
  });

  it('a probe the embedder answered counts `answered`, one it did not counts `unavailable`', async () => {
    const before = { answered: await count('answered'), unavailable: await count('unavailable') };
    let fail = true;
    const h = harness({ probeAnswer: () => (fail ? new errors.EmbedUnreachableError('down') : { vector: [1] }) });
    h.gate.noteHandBack();
    h.runOut();
    await h.gate.claim(h.claimJob, running);
    assert.equal(await count('unavailable'), before.unavailable + 1);
    assert.equal(await count('answered'), before.answered);
    fail = false;
    h.runOut();
    await h.gate.claim(h.claimJob, running);
    assert.equal(await count('answered'), before.answered + 1);
    assert.equal(await count('unavailable'), before.unavailable + 1);
  });

  it('a hand-back and every unanswered probe say at warn that nothing is claimed, the probe\'s line with the embedder\'s words', async () => {
    const log = await import('../../server/dist/util/log.js');
    const lines = [];
    const stop = log.subscribeLogLines(l => lines.push(l));
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      const h = harness({ probeAnswer: () => new errors.EmbedUnreachableError('the endpoint is down') });
      h.gate.noteHandBack();
      h.runOut();
      await h.gate.claim(h.claimJob, running);
    } finally { Object.assign(console, saved); stop(); }
    const said = lines.filter(l => /media/i.test(l) && /claim/i.test(l));
    assert.equal(said.length, 2, `expected one line for the hand-back and one for the failed probe, got:\n${lines.join('\n')}`);
    assert.ok(said.every(l => /\bWARN\b/i.test(l)), `not at warn:\n${said.join('\n')}`);
    assert.ok(said[1].includes('the endpoint is down'), `the failed probe's line does not say why: ${said[1]}`);
  });
});
