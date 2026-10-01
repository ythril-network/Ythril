/**
 * The media worker is WIRED to the slot pool the way the pool's contract needs (`Q-114`).
 *
 * `a-slot-pool-refills-a-slot-as-it-frees.test.js` holds the pool to its rules; this holds worker.ts to the
 * pool. Two things can be wrong on the worker's side while every pool case passes:
 *
 * - `limits` returns a value captured at startup. The pool re-reads it on every pass, so a worker that hands it
 *   a snapshot makes a hot-reloaded `workerConcurrency` (PATCH /api/admin/media-config, no restart) dead again;
 * - the `_heldJobs` accounting drifts away from the claim. `releaseHeldJobs` hands back what this process holds
 *   at shutdown, so a job must be recorded the instant it is claimed, inside `onClaimed`, and nowhere after it.
 *
 * Every bound is structural: a call's own brackets and an object's own top-level properties, never a character
 * window.
 *
 * Run: node --test testing/standalone/the-media-worker-runs-through-the-slot-pool.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, bodyOf } from './_structural-window.mjs';

const FILE = 'server/src/files/media/worker.ts';
const src = stripComments(readFileSync(join(REPO_ROOT, FILE), 'utf8'));

/** The text of one top-level property of the pool's options object, following a bare reference to its body. */
function poolProperty(optionsText, key) {
  const [options] = argumentsOf(optionsText, 0, `${FILE} runSlotPool call`);
  assert.ok(options && options.startsWith('{'), `${FILE}: runSlotPool's argument is not an object literal`);
  const parts = argumentsOf(options, 0, `${FILE} runSlotPool options`);
  const prop = parts.find(p => new RegExp(`^${key}\\b`).test(p));
  assert.ok(prop, `runSlotPool is not given \`${key}\``);
  const shorthand = prop.match(new RegExp(`^${key}\\s*(?::\\s*([A-Za-z_$][\\w$]*)\\s*)?$`));
  if (shorthand) return bodyOf(src, shorthand[1] ?? key, `${FILE} ${key}`);
  return prop;
}

describe('worker.ts runs its jobs through runSlotPool', () => {
  const calls = [...src.matchAll(/\brunSlotPool\s*\(/g)];

  it('calls runSlotPool exactly once', () => {
    assert.equal(calls.length, 1, `${calls.length} calls to runSlotPool in ${FILE}`);
  });

  it('no longer claims a batch and awaits all of it', () => {
    assert.ok(!/Promise\.allSettled\(\s*claimed\b/.test(src), 'the batch-and-await shape is back: a long job holds the other slot');
  });

  it('`limits` reads getMediaEmbeddingConfig when it is called, not once at startup', () => {
    assert.ok(calls.length > 0, `${FILE} does not call runSlotPool`);
    const optionsAt = calls[0].index + calls[0][0].length - 1;
    const limits = poolProperty(src.slice(optionsAt), 'limits');
    assert.ok(/=>|function/.test(limits), '`limits` must be a function the pool calls on every pass');
    assert.ok(/getMediaEmbeddingConfig\s*\(/.test(limits), '`limits` does not read the live media config');
  });

  it('the _heldJobs accounting happens inside onClaimed, and nowhere else adds to it', () => {
    assert.ok(calls.length > 0, `${FILE} does not call runSlotPool`);
    const optionsAt = calls[0].index + calls[0][0].length - 1;
    const onClaimed = poolProperty(src.slice(optionsAt), 'onClaimed');
    assert.ok(/_heldJobs\.add\(/.test(onClaimed), '`onClaimed` does not record the claim in _heldJobs');
    assert.equal([...src.matchAll(/_heldJobs\.add\(/g)].length, 1, 'a second place adds to _heldJobs');
    const run = poolProperty(src.slice(optionsAt), 'run');
    assert.ok(!/_heldJobs\.add\(/.test(run), 'the claim is recorded in `run`, after the pool has already started the job');
  });

  it('a finished job leaves _heldJobs, and shutdown still releases what is left', () => {
    assert.ok(/_heldJobs\.delete\(/.test(src), 'a finished job is never removed from _heldJobs');
    assert.ok(/_heldJobs/.test(bodyOf(src, 'releaseHeldJobs')), 'releaseHeldJobs no longer reads _heldJobs');
  });
});
