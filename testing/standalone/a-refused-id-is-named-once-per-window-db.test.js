/**
 * A document a door refuses is NAMED once per window, not by every cycle that is offered it again
 * (`ArrivalOptions.namedOnce` in `sync/arrivals.ts`, answered by `refusalIsNews` in `sync/pull-page.ts`; part 1 of the
 * 5.6.4 patch).
 *
 * ## The rule
 *
 * A pull whose peer still holds a document the receiver refuses is offered that document on every cycle. Naming it every
 * time puts the same line into the log ring each cycle for as long as the peer keeps it. So the writer asks the door's
 * `namedOnce` once for each refused document, in the page's order, and names only the ids for which it answers `true`;
 * `refusalIsNews` answers `true` for an (space, family, id) not named within the window.
 *
 * ## What is asserted
 *
 * Of `refusalIsNews` (offline, with a clock the test owns):
 *  - an id is news the first time and not again; a different id, family or space is its own key;
 *  - it is news again once the window has passed (the window is a time, not a latch);
 *  - a peer's id cannot make the key larger than a bounded part, and a NUL in it cannot join two keys into one.
 *
 * Of the writer (against a real Mongo, because the writer reads the store before it can say anything):
 *  - `namedOnce` is asked exactly once for each refused document, in the page's order, and for no other document;
 *  - only the ids it accepts are named, the refusal is NOT dropped from the outcome (`refused` keeps all of them: the
 *    position and the counts depend on it), and the line is silent when every refusal was named already;
 *  - absent, every refusal is named (a push door never passes it);
 *  - wired as the pull wires it (`refusalIsNews` per space, family and id), a second offer of the same page names nothing.
 *
 * ## Seen red
 *
 * By hand, each restored by hand: the `namedOnce` filter in `writeArrivals` replaced by the whole `out.refused` (the asked-
 * once, only-accepted-ids, silent and pull-wired cases fail); the `every` window removed from `refusedNamed` (the
 * "news again once the window has passed" case fails: "the window is a latch"); `refusalIsNews` made to answer `true` always
 * (the first-and-not-again cases and the pull-wired case fail).
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 node --test testing/standalone/a-refused-id-is-named-once-per-window-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

// The window is a time, so the test owns the clock. `warnOnce` takes `Date.now` as its default clock WHEN IT IS BUILT
// (module load), so this is in place before the module is imported; the window case fails if it ever stops being so.
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const { refusalIsNews } = await import('../../server/dist/sync/pull-page.js');
const { writeArrivals } = await import('../../server/dist/sync/arrivals.js');
const { log, LOG_VALUE_MAX } = await import('../../server/dist/util/log.js');

/** Further than any window the server could plausibly use. */
const A_DAY_MS = 24 * 60 * 60_000;

describe('refusalIsNews answers whether a refused id is news', () => {
  it('is true the first time an id is asked and false the next, and a different id, family or space is its own', () => {
    assert.equal(refusalIsNews('news-s1', 'facts', 'a'), true, 'a refusal never named was not news');
    assert.equal(refusalIsNews('news-s1', 'facts', 'a'), false, 'the same refusal was news twice');
    assert.equal(refusalIsNews('news-s1', 'facts', 'b'), true, 'another id shared the first one\'s key');
    assert.equal(refusalIsNews('news-s1', 'entities', 'a'), true, 'another family shared the first one\'s key');
    assert.equal(refusalIsNews('news-s2', 'facts', 'a'), true, 'another space shared the first one\'s key');
    assert.equal(refusalIsNews('news-s2', 'facts', 'a'), false);
  });

  it('is news again once the window has passed, and not before', () => {
    assert.equal(refusalIsNews('news-w', 'facts', 'a'), true);
    skewMs += 1_000;
    assert.equal(refusalIsNews('news-w', 'facts', 'a'), false, 'a second later is within any window');
    skewMs += A_DAY_MS;
    assert.equal(refusalIsNews('news-w', 'facts', 'a'), true, 'a day later the id was still silenced: the window is a latch');
    assert.equal(refusalIsNews('news-w', 'facts', 'a'), false, 'naming it again re-armed nothing');
  });

  it('keys a peer\'s id bounded: an id far past the renderer\'s cap answers, once', () => {
    const huge = 'x'.repeat(LOG_VALUE_MAX * 8);
    assert.equal(refusalIsNews('news-big', 'facts', huge), true);
    assert.equal(refusalIsNews('news-big', 'facts', huge), false);
  });

  it('a NUL in a peer\'s id cannot make it another key\'s twin', () => {
    // `space NUL family NUL id` is the key; an id that carries the separators must not read as a different (family, id).
    assert.equal(refusalIsNews('news-nul', 'a', 'b\u0000c'), true);
    assert.equal(refusalIsNews('news-nul', 'a\u0000b', 'c'), true, 'the NUL moved from the id into the family and the keys joined');
  });
});

describe('the writer names a refused id only when namedOnce says so', { skip }, () => {
  const SPACE = 'namedonce';
  const warnings = [];
  const realWarn = log.warn;
  before(async () => {
    await openTestMongo('namedonce');
    log.warn = (...a) => { warnings.push(a.join(' ')); };
  });
  after(async () => {
    log.warn = realWarn;
    await closeTestMongo();
  });

  /** A fact the writer refuses outright (no seq), with an id no other line of the run contains. */
  const refusedFact = (id) => ({ _id: id, spaceId: SPACE, fact: 'x', tags: [] });
  const REFUSED_LINE = /fact\w* record\(s\) refused in space/;

  /** Write the page and return what the writer said about the refusals and what it answered. */
  async function write(docs, opts) {
    warnings.length = 0;
    const out = await writeArrivals(SPACE, 'facts', 'fact', docs, { from: 'peer', ...opts });
    return { out, lines: warnings.filter(l => REFUSED_LINE.test(l)) };
  }

  it('asks once for each refused document, in the page\'s order, and for nothing else', async () => {
    const asked = [];
    await write([refusedFact('order-3'), refusedFact('order-1'), refusedFact('order-2')], { namedOnce: id => { asked.push(id); return true; } });
    assert.deepEqual(asked, ['order-3', 'order-1', 'order-2'], 'asked more or less than once for a refusal, or out of order');
  });

  it('names the ids it accepts, leaves out the ones it refuses, and still reports every refusal in the outcome', async () => {
    const { out, lines } = await write(
      [refusedFact('keep-named'), refusedFact('keep-silent'), refusedFact('keep-named-too')],
      { namedOnce: id => id !== 'keep-silent' });
    assert.equal(lines.length, 1, `expected one refusal line, got ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes('keep-named') && lines[0].includes('keep-named-too'), `the accepted ids are not named: ${lines[0]}`);
    assert.ok(!lines[0].includes('keep-silent'), `an id namedOnce refused was named: ${lines[0]}`);
    assert.deepEqual(out.refused.map(r => r._id).sort(), ['keep-named', 'keep-named-too', 'keep-silent'],
      'the outcome lost a refusal: the position and the counts are read from it, not from the log');
  });

  it('is silent when every refusal was named already', async () => {
    const { out, lines } = await write([refusedFact('quiet-a'), refusedFact('quiet-b')], { namedOnce: () => false });
    assert.deepEqual(lines, [], 'a line was written naming nothing new');
    assert.equal(out.refused.length, 2);
  });

  it('names every refusal when the door passes no namedOnce', async () => {
    const { lines } = await write([refusedFact('all-a'), refusedFact('all-b')], {});
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0].includes('all-a') && lines[0].includes('all-b'), lines[0]);
  });

  it('wired as the pull wires it, a second offer of the same page names nothing', async () => {
    const page = [refusedFact('offered-again')];
    const namedOnce = id => refusalIsNews(SPACE, 'facts', id);
    const first = await write(page, { namedOnce });
    assert.equal(first.lines.length, 1);
    assert.ok(first.lines[0].includes('offered-again'), first.lines[0]);
    const second = await write(page, { namedOnce });
    assert.deepEqual(second.lines, [], 'the same refused id was named by the next cycle');
    assert.equal(second.out.refused.length, 1, 'a silenced refusal is still a refusal');
  });
});
