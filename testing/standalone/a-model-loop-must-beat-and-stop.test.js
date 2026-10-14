/**
 * A loop that calls a model inside one job step must report progress and must stop when its lease is gone.
 *
 * ## The defect
 *
 * `worker.ts` builds both halves — a `heartbeat` that stamps job progress and reports whether the claim is
 * still ours, and a `leaseLost` flag the long phases poll — and passed them **only** to the document pipeline.
 * `embedImage`, `embedAudio` and `embedVideo` got neither.
 *
 * One of the three mattered, and it is the only one that calls a model repeatedly inside a single step:
 *
 * - **The stall floor was fifty-three times short.** `extractKeyframes` writes `frame_%06d.jpg` with no cap,
 *   one frame per 30 s of footage. An hour of video is 120 captions; at the 120 s vision budget that is
 *   14 400 s inside a step reporting no progress at all, against a 270 s floor.
 * - **And the recovered job ran twice.** Stall recovery clears the claim token, so the sweep handed the file to
 *   a second worker — while nothing in the media path polled the lease, so the first run kept captioning. Two
 *   runs, same chunk ids, same GPU. `worker.ts` names that exact risk in the comment explaining why the
 *   document path polls.
 *
 * ## Why the rule is derived and not a list of three names
 *
 * A gate naming `embedVideo` goes stale the day a fourth media type is added, and the thing it would miss is
 * the same thing missed here — a new long loop nobody connected to the heartbeat. So the subject is computed:
 * **every `for` loop in the media path whose body awaits a provider call**. That set is one today. If it
 * becomes two, the second has to beat and stop or this fails.
 *
 * The sibling gates are complementary and none of them could have caught this one:
 * `stall-floor-covers-every-hop` asks whether each budget is KNOWN, `a-fallback-chain-is-one-hop` asks what one
 * hop COSTS, and this asks whether a step that exceeds any budget SAYS SO while it runs.
 *
 * Run: node --test testing/standalone/a-model-loop-must-beat-and-stop.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, enclosingBlockMatching } from './_structural-window.mjs';

/** Media-path sources, tracked and untracked-but-not-ignored (a new embedder must not be exempt on its own commit). */
function mediaFiles() {
  const arg = 'server/src/files/media/*.ts';
  const tracked = execFileSync('git', ['ls-files', arg], { encoding: 'utf8' });
  const fresh = execFileSync('git', ['ls-files', '--others', '--exclude-standard', arg], { encoding: 'utf8' });
  return [...new Set(`${tracked}\n${fresh}`.split(/\r?\n/))].filter(Boolean).map(p => p.replace(/\\/g, '/'));
}

/** A call to a captioning or transcribing provider — the two model calls the media path makes. */
const PROVIDER_CALL = /await\s+[\w.]*\b(?:caption|transcribe)\s*\(/g;
const FOR_LOOP = /\bfor\s*(\(|await\s*\()/;

/**
 * Every provider call that sits inside a `for` loop, with the loop body.
 *
 * Containment, not proximity: `enclosingBlockMatching` walks the real brace stack, so a loop that opened and
 * closed above the call is not returned. A `slice(at - 400, at)` would have called the chunk loop further down
 * `video-embedder.ts` an enclosing loop of the caption call, which it is not.
 */
function loopedProviderCalls() {
  const out = [];
  for (const file of mediaFiles()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(PROVIDER_CALL)) {
      const loop = enclosingBlockMatching(src, m.index, FOR_LOOP, `${file} @${m.index}`);
      if (loop) out.push({ file, call: m[0], loop });
    }
  }
  return out;
}

describe('a model loop beats and stops', () => {
  it('finds the loop, so an empty sweep cannot pass', () => {
    // The keyframe caption loop is the one. If this ever returns zero the matcher has broken, not the code —
    // and a silently-empty scan reads exactly like a clean codebase.
    const found = loopedProviderCalls();
    assert.ok(
      found.length >= 1,
      'no looped provider call found in server/src/files/media — the scan has broken, so nothing below is '
      + 'being checked. Re-point PROVIDER_CALL.',
    );
  });

  it('every looped model call beats inside its own loop', () => {
    const silent = loopedProviderCalls().filter(c => !/onProgress|beat\(/.test(c.loop));
    assert.deepEqual(
      silent.map(c => `${c.file}: \`${c.call}\``), [],
      'A loop calling a model N times inside one job step reports no progress for its whole duration, so the '
      + 'stall sweep re-queues the job mid-loop however high the hop budget is — the budget bounds ONE call '
      + 'and the loop is N of them. Beat once per iteration.',
    );
  });

  it('every looped model call checks its lease inside its own loop', () => {
    const unstoppable = loopedProviderCalls().filter(c => !/shouldStop/.test(c.loop));
    assert.deepEqual(
      unstoppable.map(c => `${c.file}: \`${c.call}\``), [],
      'Stall recovery clears the claim token and hands the file to another worker. A loop that never checks '
      + 'keeps going, so both runs write the same chunk ids and compete for the same model. This is the risk '
      + "worker.ts documents on `leaseLost`, and it applied to the media path too.",
    );
  });

  it('no beat sits in a try block, in any looped embedder', () => {
    /*
     * The sharp one, and the reason it is asserted separately from the loop-level check above.
     *
     * A beat written inside the `try` goes silent exactly when a provider starts failing — the moment the
     * stall detector most needs to know the worker is alive. The job is then re-queued for being stalled while
     * it is in fact working correctly through a list of frames the model is refusing, and the replacement does
     * the same thing. So the beat belongs after the attempt: in the `finally`, or below the catch.
     *
     * Checked across EVERY looped embedder, not just one. Written against `video-embedder.ts` alone first, and
     * a mutant that moved the AUDIO beat into its try walked straight through — the assertion was reading a
     * file the mutation had not touched, which is a gate that only appears to cover its subject.
     */
    const offenders = [];
    for (const { file, call } of loopedProviderCalls()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const at = src.search(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const tryBlock = enclosingBlockMatching(src, at, /\btry\s*\{/, `${file} try block`);
      if (tryBlock && /beat\(|onProgress/.test(tryBlock)) offenders.push(`${file}: \`${call}\``);
    }
    assert.deepEqual(
      offenders, [],
      'A beat inside the try stops firing on the first provider failure. The job then looks stalled precisely '
      + 'while it is working, and gets re-queued into a replacement that fails the same way.',
    );
  });

  it('the lease is checked BEFORE the call, not after', () => {
    // Checking after spends a whole vision budget producing a caption the recovering run will overwrite.
    const src = stripComments(readFileSync('server/src/files/media/video-embedder.ts', 'utf8'));
    const loop = enclosingBlockMatching(
      src, src.search(/await\s+vision\.caption\s*\(/), FOR_LOOP, 'the keyframe loop');
    assert.ok(loop, 'no enclosing keyframe loop — re-point this gate');
    assert.ok(
      loop.indexOf('shouldStop') < loop.indexOf('vision.caption'),
      'the lease check must come before the model call: after it, the run has already spent up to a full '
      + 'vision budget on work another worker is redoing.',
    );
  });

  it('the worker actually passes both halves to the video path', () => {
    // The gate above proves the loop USES them; this proves the caller SUPPLIES them. A default of `undefined`
    // satisfies the first and delivers nothing, which is the shape that would quietly restore the defect.
    const worker = stripComments(readFileSync('server/src/files/media/worker.ts', 'utf8'));
    const at = worker.indexOf('embedVideo(');
    assert.notEqual(at, -1, 'no embedVideo call — re-point this gate');
    const stmt = worker.slice(at, worker.indexOf(';', at));
    assert.match(stmt, /onProgress:\s*heartbeat/, 'the video path must be given the same heartbeat the document path gets');
    assert.match(stmt, /shouldStop:\s*\(\)\s*=>\s*leaseLost/, 'and the same lease flag');
    // The claim rides in the same opts bag (`MediaRunOpts`): every write the run makes about its file is under it (`writeUnderClaim`).
    assert.match(stmt, /\bclaim\b/, 'and the run\'s claim: the embedders write nothing without it');
  });

  it('every step a beat names is one the bar can draw', () => {
    /*
     * A `step` absent from its own `steps` array renders as no segment at all — indistinguishable from a job
     * that is not reporting, which would make this whole fix invisible in the UI it feeds.
     *
     * Checked against the route arrays in `progress.ts` rather than against one embedder's own constant,
     * because `embedVideo` calls `embedAudio` and passes its OWN route down: the audio stage of a video job
     * names `transcribe` while the array in force is `VIDEO_STEPS`. Both arrays therefore have to contain
     * every step name any embedder can report, and asserting per-file would miss exactly that crossing.
     */
    const progress = stripComments(readFileSync('server/src/files/media/progress.ts', 'utf8'));
    const routes = [...progress.matchAll(/const (\w+_STEPS) = \[([^\]]*)\]/g)]
      .map(m => ({ name: m[1], steps: [...m[2].matchAll(/'([^']+)'/g)].map(s => s[1]) }));
    assert.ok(routes.length >= 2, `expected the audio and video routes in progress.ts, found ${routes.length}`);

    for (const { file } of loopedProviderCalls()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const named = /step:\s*'([^']+)'/.exec(src);
      assert.ok(named, `${file} beats without naming a step`);
      const fallback = /steps\s*\?\?\s*(\w+_STEPS)/.exec(src);
      assert.ok(fallback, `${file} must default to a named route, not an inline array`);

      const own = routes.find(r => r.name === fallback[1]);
      assert.ok(own, `${file} defaults to ${fallback[1]}, which progress.ts does not define`);
      assert.ok(
        own.steps.includes(named[1]),
        `${file} reports step '${named[1]}', which its own route ${own.name} does not contain`,
      );
    }
  });

  it('an embedder run as a STAGE of another gets a route containing its step', () => {
    /*
     * The crossing the per-file check above cannot see, and the one that actually breaks the bar.
     *
     * `embedVideo` calls `embedAudio` and passes its OWN route down, so the audio stage of a video job reports
     * `transcribe` against `VIDEO_STEPS`. If those two ever disagree the bar draws nothing for the longest
     * stage of a video — and both files would still pass every assertion about themselves.
     *
     * Derived from the forwarding call rather than hardcoded, so a third embedder composed this way is covered
     * on the commit that adds it.
     */
    const progress = stripComments(readFileSync('server/src/files/media/progress.ts', 'utf8'));
    const routeOf = name => {
      const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(progress);
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map(s => s[1]) : null;
    };

    let crossings = 0;
    for (const file of mediaFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // `embedAudio(… steps: opts?.steps ?? VIDEO_STEPS …)` — a call that hands a callee a route of its own.
      for (const m of src.matchAll(/\b(embed[A-Z]\w*)\s*\([^;]*?steps:\s*[^,;}]*?\?\?\s*(\w+_STEPS)/gs)) {
        const [, callee, routeName] = m;
        const calleeFile = mediaFiles().find(f => f.endsWith(`${callee.replace(/^embed/, '').toLowerCase()}-embedder.ts`));
        assert.ok(calleeFile, `cannot locate the source of ${callee} — re-point this gate`);
        const step = /step:\s*'([^']+)'/.exec(stripComments(readFileSync(calleeFile, 'utf8')));
        if (!step) continue;                       // that callee has no beat, so nothing to agree with
        const route = routeOf(routeName);
        assert.ok(route, `${routeName} is not defined in progress.ts`);
        assert.ok(
          route.includes(step[1]),
          `${file} runs ${callee} as a stage under ${routeName}, but ${callee} reports step '${step[1]}' and `
          + `${routeName} is [${route.join(', ')}]. The bar would draw no segment for that stage.`,
        );
        crossings++;
      }
    }
    assert.ok(crossings >= 1, 'no embedder-as-a-stage crossing found — the matcher has broken, not the code');
  });

  it('the image path beats at the entry of each hop and checks its lease before the next, on a route the bar can draw', () => {
    /*
     * An image run is two model hops in sequence (the caption, then the face provider, which beats once per face). Neither beat
     * before, so a caption hop that outlasted the stall threshold left the job silent, stall recovery took it, and the run met
     * its own fence at the first write after the recovery. The beat sits at the ENTRY of a hop — before the model call, never
     * inside a try that a failing provider would skip — and each hop checks the lease before it spends a model budget.
     */
    const progress = stripComments(readFileSync('server/src/files/media/progress.ts', 'utf8'));
    const route = /const IMAGE_STEPS = \[([^\]]*)\]/.exec(progress);
    assert.ok(route, 'progress.ts defines no IMAGE_STEPS route: the image run has no route of its own to report against');
    const steps = [...route[1].matchAll(/'([^']+)'/g)].map(s => s[1]);
    for (const step of ['caption', 'faces']) assert.ok(steps.includes(step), `IMAGE_STEPS [${steps}] does not contain '${step}'`);

    const image = stripComments(readFileSync('server/src/files/media/image-embedder.ts', 'utf8'));
    const captionBeat = image.search(/step:\s*'caption'/);
    const facesBeat = image.search(/step:\s*'faces'/);
    assert.ok(captionBeat >= 0 && facesBeat >= 0, 'the image embedder must beat both hops: caption and faces');
    assert.ok(captionBeat < image.search(/await\s+vision\.caption\s*\(/), 'the caption beat must come BEFORE the vision call');
    assert.ok(facesBeat < image.search(/await\s+embedFaces\s*\(/), 'the faces beat must come BEFORE the face step');
    assert.match(image, /shouldStop/, 'the image embedder never checks its lease');
    assert.match(image, /IMAGE_STEPS/, 'the image embedder reports against no named route');

    const face = stripComments(readFileSync('server/src/files/media/face-embedder.ts', 'utf8'));
    const loop = enclosingBlockMatching(face, face.search(/await\s+gallerySearch\s*\(/), FOR_LOOP, 'the per-face loop');
    assert.ok(loop, 'no per-face loop found — re-point this gate');
    assert.match(loop, /onProgress|beat\(/, 'the per-face loop does not beat once per face');
    assert.match(loop, /shouldStop/, 'the per-face loop does not check the lease');

    const worker = stripComments(readFileSync('server/src/files/media/worker.ts', 'utf8'));
    const at = worker.indexOf('embedImage(');
    assert.notEqual(at, -1, 'no embedImage call in the worker — re-point this gate');
    const stmt = worker.slice(at, worker.indexOf(';', at));
    assert.match(stmt, /onProgress:\s*heartbeat/, 'the image path must be given the heartbeat');
    assert.match(stmt, /shouldStop:\s*\(\)\s*=>\s*leaseLost/, 'and the lease flag');
    assert.match(stmt, /steps:\s*IMAGE_STEPS/, 'and its own route');
    assert.match(stmt, /\bclaim\b/, 'and the run\'s claim');
  });
});
