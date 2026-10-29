/**
 * Every position stream's open hold is named by the watchdog, whichever stream it is (Q-415 item 3).
 *
 * ## The defect it would otherwise be
 *
 * The release line speaks when a hold ENDS; a hold that has not ended is the one stopping replication right now, and the watchdog
 * (`util/horizon-holds.ts`, `warnStalled`) is what names it, once, as `<noun> held <age>s and still open: space=… <key>=… holder=…`.
 * Nothing under `testing/` held that line for any stream: the release line has tests (`a-stalled-position-hold-is-reported-db`), and
 * a watchdog that stopped naming a stream's hold, or a stream built outside the one registry the watchdog scans, would have failed
 * silently.
 *
 * ## The rule this file holds
 *
 * For EVERY `createPositionStream(` in `server/src`, derived from the source and held to a floor:
 *
 *  1. its hold registry is one the watchdog scans (it is among the process's `HorizonHolds` instances, found by its noun);
 *  2. a hold of it that is older than the warn age is named by one `... and still open` line carrying its noun, the space, the floor
 *     and the holder;
 *  3. the watchdog names a hold ONCE: the next pass in the same window adds no line.
 *
 * The set of streams is read out of the source, never listed, so a third stream is held to the same three the day it is written.
 *
 * Run: node --test testing/standalone/every-position-stream-says-a-hold-is-still-open.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { elapse } from '../_shared/sleep.mjs';

const REPO = REPO_ROOT;
const STREAM_FLOOR = 2;
/** Narrow enough that a hold is old after a fraction of a second: the warn age is half the hold deadline. */
const BOUND = { writeTimeoutMs: 600, holdDeadlineMs: 600 };
const SPACE = 'stillopenspace';
const STILL_OPEN = / held \d+(?:\.\d+)?s and still open: /;

/** The text of the call that opens at `from` (the index of its `(`), up to the matching `)`. */
function callText(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error('an unterminated createPositionStream( call');
}

/** Every stream the server builds: its file and the noun its lines open with (`wording.noun`, else its `name`). */
function derivedStreams() {
  const found = [];
  for (const file of trackedSources('server/src')) {
    if (file.endsWith('util/position-clock.ts')) continue; // the definition and its overloads, not a stream
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const m of src.matchAll(/createPositionStream\(/g)) {
      const call = callText(src, m.index + m[0].length - 1);
      const noun = /noun:\s*'([^']+)'/.exec(call)?.[1] ?? /name:\s*'([^']+)'/.exec(call)?.[1];
      assert.ok(noun, `${file}: a createPositionStream( call names neither a wording.noun nor a name`);
      found.push({ file, noun });
    }
  }
  return found;
}

const streams = derivedStreams();

describe('every position stream says a hold is still open', () => {
  let instances = [], warn, lines = [], unsubscribe = () => {}, restoreBound = () => {};
  const held = [];

  before(async () => {
    const dist = (file) => import(`../../server/dist/${relative('server/src', file).replace(/\\/g, '/').replace(/\.ts$/, '.js')}`);
    for (const { file } of streams) await dist(file);
    const holdsModule = await import('../../server/dist/util/horizon-holds.js');
    assert.equal(typeof holdsModule.horizonHoldsForTest, 'function', 'util/horizon-holds.ts exports no horizonHoldsForTest: no test can reach the registries the watchdog scans');
    instances = holdsModule.horizonHoldsForTest();
    const bound = await import('../../server/dist/db/write-bound.js');
    bound.setWriteBoundForTest(BOUND);
    restoreBound = () => bound.setWriteBoundForTest(null);
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines((l) => { lines.push(l); });
    warn = (now) => { for (const h of instances) h.warnStalled(now); };
  });
  after(() => { for (const { holds, hold, space } of held) holds.release(space, hold, 'ok'); unsubscribe(); restoreBound(); });

  it('the derivation found the streams (a floor, so an empty read cannot pass)', () => {
    assert.ok(streams.length >= STREAM_FLOOR, `found ${streams.length} createPositionStream( call(s) in server/src: ${JSON.stringify(streams)}`);
    assert.equal(new Set(streams.map(s => s.noun)).size, streams.length, 'two streams share a noun: their lines cannot be told apart');
  });

  it('every stream\'s registry is one the watchdog scans', () => {
    for (const { file, noun } of streams) {
      const holds = instances.filter(i => i.wording.noun === noun);
      assert.equal(holds.length, 1, `${file}: ${holds.length} hold registries say '${noun}' among those the watchdog scans (${instances.map(i => i.wording.noun).join(', ')})`);
    }
  });

  it('a hold older than the warn age is named once per stream, with its noun, space, floor and holder', async () => {
    for (const { noun } of streams) {
      const holds = instances.find(i => i.wording.noun === noun);
      const holder = `probe${held.length}`;
      held.push({ holds, hold: holds.enter(SPACE, 7, holder), space: SPACE });
    }
    await elapse(BOUND.holdDeadlineMs / 2 + 150, 'ttl elapses: the holds must be older than the warn age');
    lines.length = 0;
    warn(Date.now());
    const said = lines.filter(l => STILL_OPEN.test(l));
    for (const [i, { noun, file }] of streams.entries()) {
      const mine = said.filter(l => l.includes(` ${noun} held `));
      assert.equal(mine.length, 1, `${file}: expected one 'and still open' line for '${noun}', got ${mine.length}; the log held ${JSON.stringify(lines)}`);
      assert.match(mine[0], new RegExp(`space=${SPACE}\\b.*holder=probe${i}\\b`), `${file}: the line does not name the space and the holder: ${mine[0]}`);
    }
    assert.equal(said.length, streams.length, `the watchdog said ${said.length} 'and still open' line(s) for ${streams.length} stream(s): ${JSON.stringify(said)}`);
  });

  it('the next pass of the same window adds none', () => {
    lines.length = 0;
    warn(Date.now());
    assert.deepEqual(lines.filter(l => STILL_OPEN.test(l)), [], 'a hold was named a second time');
  });
});
