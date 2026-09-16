/**
 * An OPTIONAL vector index cannot condemn a space, and an index that does not exist is not "still building".
 *
 * ## The evidence
 *
 * The canary operator 2026-08-17T1540Z §8: fourteen spaces in their admin UI — three red *"Index build failed"*,
 * eleven blue *"Preparing indexes…"* — on an instance whose search worked normally. The same warning is in
 * their 3.0.1 logs from 2026-08-14, so it is not a 3.1.0 regression.
 *
 * **The three and the eleven are one number, and the source says which.** `FINALIZE_CONCURRENCY` is 3, so those
 * were the first batch to run out a 600 s window while the other eleven sat at `building` waiting for a worker.
 * One failure, fourteen times, presented as three failures and eleven pending.
 *
 * Two defects behind it, and this file gates both:
 *
 * 1. **The face gallery got a vote on `indexStatus`.** That field is what paints the badge red, and the gallery
 *    is not part of what a space's search depends on — recall, traversal and hybrid text all work without it.
 *    On their fleet `FACE_RECOGNITION_ENABLED=true` is set with no `externalModel` and no model files, so
 *    nothing can write a face vector; an unconfigured optional feature was condemning working spaces on every
 *    boot. Their line is the argument: *"a red badge that is always red on a working system trains an operator
 *    to stop reading red badges."*
 * 2. **The poll had no terminal state for an index that does not exist.** Nothing inside that loop creates an
 *    index, and `ensureVectorSearchIndex` has four paths that return without creating one. So absence was
 *    waited out for the full window — the identical mistake the `probe.permanent` branch beside it was written
 *    to fix, with the cost measured at the time: 600 s per index, then working spaces marked failed.
 *
 * ## Why a source gate
 *
 * The same reason `index-ready-poll.test.js` gives, and it is the same function: reproducing this needs a live
 * mongot that is missing one index while answering about the others, which CI's Atlas Local will not arrange on
 * request. Both regressions are also a one-line reversion whose symptom is a SLOW boot rather than a failing
 * test — the signature that let the first version survive two rounds of investigation.
 *
 * Run: node --test testing/standalone/optional-index-cannot-fail-a-space.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { deriveLiveIndexState, isDrifted } = await import('../../server/dist/api/pipeline-status.js');

const FILE = 'server/src/spaces/vector-index.ts';
const src = stripComments(readFileSync(FILE, 'utf8'));

/**
 * The body of one exported function in THIS file's source.
 *
 * A one-argument wrapper so the calls below stay short. The loop that used to be here was one of three
 * independent hand-rolls of the same bound, written within hours of each other — which is what
 * `_structural-window.mjs` was extracted for, and this was the last of the three still standing.
 */
const bodyIn = (name) => bodyOf(src, name, `${name} in ${FILE}`);

describe('the face gallery is polled but gets no vote on the space status', () => {
  const body = bodyIn('waitForSpaceIndexesReady');

  it('the verdict is computed over the REQUIRED indexes alone', () => {
    // The regression is one `push` away. Pushing the face poll into the array that `every(Boolean)` runs over
    // is how it had the vote in the first place, and it reads as harmless — one more index in a list of
    // indexes.
    assert.doesNotMatch(body, /\.push\(\s*pollVectorIndexReady\(/,
      'the face poll is back in the array the verdict is computed from — an optional index must not be able '
      + 'to write indexStatus: failed on a space whose search works');
    assert.match(body, /const results = await Promise\.all\(required\);/,
      'the verdict must be awaited over the required polls only');
    assert.match(body, /return results\.every\(Boolean\);/,
      'and be every-required-index-ready, not every-poll-that-ran');
  });

  it('but it IS still polled, and its outcome is reported', () => {
    // Withholding the vote must not become withholding the information. A gallery that genuinely fails to
    // build is something an operator should read about — just not as "this space's indexes failed".
    assert.match(body, /getFaceRecognitionConfig\(\)\.enabled/,
      'the face index must still be polled when the feature is on');
    assert.match(body, /faceEmbedding/, 'by name');
    assert.match(body, /log\.warn\(/,
      'a face index that did not come ready must still be logged — silence would trade one bad report for no '
      + 'report at all');
  });

  it('and its poll is started before the required ones are awaited', () => {
    // Sequencing it after the await would make an optional index add its whole window to every boot — the
    // cost this change exists to remove, reintroduced while the badge stayed green.
    const faceStart = body.indexOf('pollVectorIndexReady(spaceId, \'files\', faceIndexName');
    const requiredAwait = body.indexOf('await Promise.all(required)');
    assert.ok(faceStart > -1, 'the face poll is gone — re-anchor this gate');
    assert.ok(faceStart < requiredAwait,
      'the face poll must be kicked off before the required indexes are awaited, or its window is added to '
      + 'the boot rather than overlapped with it');
  });

  it('a REJECTED face poll cannot reach the verdict either', () => {
    // `false` is not the only way an optional index can report failure. An unhandled rejection propagating
    // out of waitForSpaceIndexesReady lands in finalizeSpaceIndexReady's catch, which writes exactly the
    // 'failed' this whole change is removing.
    assert.match(body, /\.catch\(\(\) => false\)/,
      'the optional poll must swallow its own rejection — otherwise a thrown error still condemns the space');
  });
});

describe('an index that does not exist is a terminal state, not a slow one', () => {
  const body = bodyIn('pollVectorIndexReady');

  it('absence ends the poll instead of running out the window', () => {
    assert.match(body, /if \(absentFor >= ABSENT_IS_TERMINAL_AFTER\)/,
      'the absent branch must have a terminal exit — nothing in this loop creates an index, so waiting longer '
      + 'cannot change the answer');
    // The exit must be INSIDE the not-present branch. A terminal give-up that also fired on a present-but-
    // building index would abandon builds that were going to finish.
    const notPresent = body.indexOf('if (!current) {');
    const terminal = body.indexOf('if (absentFor >= ABSENT_IS_TERMINAL_AFTER)');
    const elseBranch = body.indexOf('} else {');
    assert.ok(notPresent > -1 && terminal > notPresent && terminal < elseBranch,
      'the terminal exit must sit inside the not-present branch, or a genuinely building index gets abandoned');
  });

  it('only counts absence the backend actually answered about', () => {
    // `listSearchIndexes` returning nothing at all is not evidence the index is missing — it is evidence
    // mongot has not answered about this collection yet, which is the pre-existing lag case. Requiring OTHER
    // indexes in the list is what separates "not there" from "not asked yet", and it is the same
    // absence-of-evidence rule the probe branch below already honours.
    assert.match(body, /if \(all\.length > 0\) absentFor\+\+;/,
      'absence must only count when the backend listed other indexes on this collection');
  });

  it('and forgets the streak the moment the index appears', () => {
    // A catalogue that flaps would otherwise accumulate isolated absences across a whole build and give up on
    // an index that was present most of the time.
    assert.match(body, /\} else \{\s*\n\s*absentFor = 0;/,
      'the streak must reset when the index is seen, or non-consecutive absences add up to a false verdict');
  });

  it('the grace period is generous against a create and tiny against the boot window', () => {
    const m = src.match(/const ABSENT_IS_TERMINAL_AFTER = (\d+);/);
    assert.ok(m, 'ABSENT_IS_TERMINAL_AFTER is gone — re-anchor this gate');
    const secs = Number(m[1]);
    // Above the 2 s the drop path budgets for the same mongot bookkeeping lag, so a create followed by an
    // empty listing is never mistaken for a missing index.
    assert.ok(secs >= 10, `${secs}s is not enough slack for mongot's catalogue to catch up after a create`);
    // And far below the boot window it replaces, or the fix saves nothing.
    assert.ok(secs <= 60, `${secs}s is long enough that fourteen spaces still stall a boot`);
  });
});

/*
 * The THIRD view of the same failure, and the one that is exercised rather than read.
 *
 * `deriveLiveIndexState` is pure and exported, so this half needs no mongot at all — it can be called with the
 * exact listing their fleet produces. Worth having both kinds in one file: the source assertions above pin
 * decisions that only exist as code shape, and these pin the behaviour an operator actually sees.
 */
describe('the admin health panel does not call a healthy space missing', () => {
  const required = (status) => ['facts', 'entities', 'edges', 'chrono', 'files']
    .map(c => ({ collection: c, indexName: `s_${c}_embedding`, status }));
  const face = (status) => ({ collection: 'files', indexName: 's_files_faceEmbedding', status, optional: true });

  it('every search index READY and no face gallery reads as READY', () => {
    // Their exact fleet state: FACE_RECOGNITION_ENABLED=true, nothing able to write a face vector, so the
    // gallery index is absent while all five real indexes are fine.
    const live = deriveLiveIndexState([...required('READY'), face(null)], false);
    assert.equal(live, 'ready',
      'an absent OPTIONAL index made fourteen working spaces report `missing` — a red pill per space, the '
      + 'whole Tools tab `down`, and the drift banner on top');
  });

  it('and therefore does not trip the silent-loss drift flag either', () => {
    // `isDrifted` is defined as stored-ready versus live-not-ready, and this file calls it the silent-loss
    // signature. Firing it on every space permanently is how a signature stops signifying.
    const live = deriveLiveIndexState([...required('READY'), face(null)], false);
    assert.equal(isDrifted('ready', live), false,
      'the drift flag fired on a healthy space, which is what teaches an operator to ignore it');
  });

  it('a REQUIRED index that is absent still reads as missing', () => {
    // The other direction, or the fix would be "stop reporting missing indexes". This is the case the state
    // exists for: config says ready, the database has lost an index, recall silently returns nothing.
    const cols = [...required('READY'), face('READY')];
    cols[2].status = null;
    assert.equal(deriveLiveIndexState(cols, false), 'missing');
    assert.equal(isDrifted('ready', 'missing'), true, 'and it must still trip the drift flag');
  });

  it('a required index still building still reads as building', () => {
    const cols = [...required('READY'), face(null)];
    cols[0].status = 'PENDING';
    assert.equal(deriveLiveIndexState(cols, false), 'building',
      'excluding the optional index must not also swallow a genuine in-progress build');
  });

  it('an optional index that is present but NOT ready is not a building space either', () => {
    // The subtle one. Excluding it from `missing` and then letting it hold the space at `building` would move
    // the badge from red to blue and leave it there for ever — which is eleven of their fourteen.
    assert.equal(deriveLiveIndexState([...required('READY'), face('PENDING')], false), 'ready',
      'a pending optional index must not pin the space at `building` indefinitely');
  });

  it('a listing failure still wins over everything', () => {
    // Unknown is not the same as healthy: if mongot did not answer, the panel must say so rather than infer
    // health from a list it could not read.
    assert.equal(deriveLiveIndexState([...required('READY')], true), 'unknown');
  });

  it('the face index is marked optional where it is expected, not somewhere downstream', () => {
    // The flag has to be set by whoever knows the index is optional. Setting it in `deriveLiveIndexState` by
    // matching on the name would be a second place that knows which indexes are optional, and the two would
    // drift the moment a second optional index arrives.
    const panel = stripComments(readFileSync('server/src/api/pipeline-status.ts', 'utf8'));
    assert.match(panel, /indexName: `\$\{space\.id\}_files_faceEmbedding`, optional: true/,
      'the face index must be marked optional at the point it is added to the expected set');
    // The verdict function's own body. Bounded by a count, this absence check would pass on any version of the
    // function longer than 400 characters — including one that had just gained the hardcoded name it forbids.
    assert.doesNotMatch(bodyOf(panel, 'deriveLiveIndexState'), /faceEmbedding/,
      'the verdict function must not know any index BY NAME — it reads the flag, so a second optional index '
      + 'needs no change here');
  });
});
