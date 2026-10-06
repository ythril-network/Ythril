/**
 * Every `setInterval` timer in `server/src` is the interval job's, except the one stated exemption (`Q-317`, bundle-53 G26).
 *
 * ## The defect it prevents
 *
 * A repeating timer is five questions answered by hand: what if the last tick is still running, what if one throws, is its
 * database work bounded, is a tick that never ends ever named, does the timer keep the process alive. Fifteen bare
 * `setInterval` calls answered them fifteen different ways, mostly by omission (`util/interval-job.ts` has the list), and the
 * omissions were the kind that fail silently: a skipped-forever sweep, a timer that held a shutdown open, a throw that became an
 * unhandled rejection. `util/interval-job.ts` answers all five once. That holds only while nobody writes a sixteenth timer by hand,
 * and nothing but this makes the next author reach for the module.
 *
 * ## What it holds, and where each part comes from
 *
 * - **The token, everywhere.** `\bsetInterval\b` in every tracked or uncommitted `server/src` source with its comments stripped,
 *   except the module that owns the timer. The TOKEN, not a call form: an import (`import { setInterval } from 'node:timers'`,
 *   `from 'timers'`, an alias), `globalThis.setInterval(`, `timers.setInterval(` and a stored reference all contain it, and a pattern
 *   that read only `setInterval(` would see none of those.
 * - **One exemption, and its shape is the exemption.** `util/sse-stream.ts` keeps one bare `setInterval`: the keepalive of ONE
 *   connection, synchronous, touching no database, cleared in the `finally` of the function that closes the stream. It is exempt
 *   only as exactly one `setInterval` whose handle is cleared by a `clearInterval` inside a `finally { … }`: a second one in that file,
 *   or a clear that is not in a `finally`, is a finding, so a timer added beside it cannot ride on the exemption.
 * - **The owner is what it says.** `util/interval-job.ts` has exactly one `setInterval` and one `clearInterval`, the timer is
 *   `unref`'d before it is kept, and `stop` disarms it. These are the two halves of the owner a copy would drop (a timer that keeps
 *   the process alive; a `stop` that leaves the timer running), so the shape is held HERE as well as by the owner's own tests.
 * - **A floor on what is read.** The number of files read, and the number of files that call `intervalJob(`: a reader that stopped
 *   matching, or a tree that stopped using the module, makes "nothing here is a bare timer" a statement about nothing.
 *
 * ## What it does NOT conclude, stated so the title does not claim more than the body
 *
 * It is about `setInterval` timers. A worker that sleeps between passes (`await sleep(…)` in a `while` loop) and a chain of
 * `setTimeout`s that re-arms itself are repeating work too, and are a different question: neither overlaps itself (the next pass is
 * armed by the end of the last), and which of them need the interval job's bound is decided by `every-housekeeping-space-walk-is-
 * isolated`, which follows every scheduled root. A cron registration is `util/armed-schedule.ts`'s. Nothing here says those are
 * fine; it says this gate does not look.
 *
 * ## Seen red
 *
 * By hand, put back by hand: a bare timer in `brain/ttl-sweep.ts`; a second `setInterval` in `util/sse-stream.ts`; its `clearInterval`
 * moved out of the `finally`; the `unref` dropped from `util/interval-job.ts`; its `stop` no longer disarming; a `timers` import of
 * `setInterval` in a module. The fixtures below hold the reader to each spelling.
 *
 * Run: node --test testing/standalone/every-repeating-timer-is-an-interval-job.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const OWNER = 'server/src/util/interval-job.ts';
const KEEPALIVE = 'server/src/util/sse-stream.ts';

/**
 * Every offset of the token `setInterval` in one comment-stripped source — bar `typeof setInterval`, a TYPE position
 * (`ReturnType<typeof setInterval>`, the owner's own cast), which arms nothing.
 */
const timerTokens = src => [...src.matchAll(/(?<!\btypeof\s+)\bsetInterval\b/g)].map(m => m.index);

/**
 * What the keepalive exemption needs, read from one source: how many `setInterval` tokens it holds, and whether each is a
 * `const <handle> = setInterval(` whose handle is passed to a `clearInterval` inside a `finally { … }` block.
 *
 * @returns {{ count: number, unpaired: string[] }}
 */
export function keepaliveExemption(src) {
  const finallies = [...src.matchAll(/\bfinally\s*\{/g)].map(m => balancedFrom(src, m.index + m[0].length - 1, 'a finally block'));
  const unpaired = [];
  const tokens = timerTokens(src);
  for (const at of tokens) {
    const handle = /([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*$/.exec(src.slice(Math.max(0, at - 80), at))?.[1];
    const cleared = handle !== undefined
      && finallies.some(block => new RegExp(String.raw`\bclearInterval\(\s*${handle.replace(/\$/g, '\\$')}\s*\)`).test(block));
    if (!cleared) unpaired.push(src.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' '));
  }
  return { count: tokens.length, unpaired };
}

describe('the reader sees a timer however it is spelled (fixtures)', () => {
  const SPELLINGS = [
    ['a bare call', 'const t = setInterval(() => work(), 1000);'],
    ['an import from node:timers', "import { setInterval } from 'node:timers';"],
    ['an import from timers, aliased', "import { setInterval as every } from 'timers';"],
    ['the promises iterator', "import { setInterval } from 'node:timers/promises';\nfor await (const _ of setInterval(1000)) work();"],
    ['globalThis', 'globalThis.setInterval(work, 1000);'],
    ['a member of the timers module', "import timers from 'node:timers';\ntimers.setInterval(work, 1000);"],
    ['a stored reference', 'const arm = setInterval;\narm(work, 1000);'],
    ['a computed member', "global['setInterval'](work, 1000);"],
  ];
  for (const [what, src] of SPELLINGS) {
    it(`finds ${what}`, () => assert.equal(timerTokens(stripComments(src)).length >= 1, true, `${what} must be seen`));
  }

  it('does not count a type position (`typeof setInterval`)', () => {
    assert.deepEqual(timerTokens('let h: ReturnType<typeof setInterval> | null = null;'), []);
  });

  it('does not see a timer in a comment, or a longer name', () => {
    assert.deepEqual(timerTokens(stripComments('// a setInterval here\n/* and setInterval there */\nconst x = mySetInterval + setIntervalAll;')), []);
  });
});

describe('the keepalive exemption is its shape (fixtures)', () => {
  const OK = [
    'const heartbeat = setInterval(() => send(), 30);\nconst close = () => { try { a(); } finally { clearInterval(heartbeat); } };',
    'const hb: ReturnType<typeof setInterval> = setInterval(f, 1);\ntry { x(); } finally {\n  clearInterval(hb);\n}',
  ];
  OK.forEach((src, i) => it(`accepts the paired form ${i + 1}`, () => {
    assert.deepEqual(keepaliveExemption(src), { count: 1, unpaired: [] });
  }));

  it('refuses a second timer beside it (count 2: the file may hold exactly one)', () => {
    const src = `${OK[0]}\nconst other = setInterval(() => more(), 5);\ntry { x(); } finally { clearInterval(other); }`;
    assert.equal(keepaliveExemption(src).count, 2);
  });

  it('refuses a clear that is not in a finally', () => {
    const src = 'const heartbeat = setInterval(f, 1);\nconst close = () => { clearInterval(heartbeat); };';
    assert.equal(keepaliveExemption(src).unpaired.length, 1);
  });

  it('refuses a finally that clears a different handle', () => {
    const src = 'const heartbeat = setInterval(f, 1);\nconst other = 3;\ntry { x(); } finally { clearInterval(other); }';
    assert.equal(keepaliveExemption(src).unpaired.length, 1);
  });

  it('refuses a timer whose handle is not kept', () => {
    const src = 'setInterval(f, 1);\ntry { x(); } finally { clearInterval(heartbeat); }';
    assert.equal(keepaliveExemption(src).unpaired.length, 1);
  });
});

describe('server/src has no bare repeating timer', () => {
  const files = trackedSources('server/src', { untracked: true, exclude: [OWNER] });
  const read = file => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
  const sources = new Map([...files, OWNER].map(file => [file, read(file)]));

  it('reads a tree worth reading (the floors)', () => {
    assert.ok(files.length >= 300, `only ${files.length} source files were read`);
    assert.ok(sources.has(KEEPALIVE), `${KEEPALIVE} was not read: the exemption names a file that is gone, so re-anchor this gate`);
    const users = [...sources].filter(([file, src]) => file !== OWNER && /(?<![.\w$])intervalJob\s*(?:<[^>(;]*>)?\s*\(/.test(src)).length;
    assert.ok(users >= 10,
      `only ${users} file(s) call intervalJob(: the module is not what the tree uses, or this reader stopped matching, and "no bare timer` +
      ' anywhere else" would be a statement about nothing');
  });

  it('no module but the interval job owner holds a setInterval, bar the one keepalive', () => {
    const findings = [];
    for (const file of files) {
      if (file === KEEPALIVE) continue;
      const hits = timerTokens(sources.get(file));
      if (hits.length > 0) findings.push(`${file}: ${hits.length} \`setInterval\` token(s) — use \`intervalJob\` (util/interval-job.ts)`);
    }
    assert.deepEqual(findings, [],
      `a repeating timer written by hand answers the five questions of util/interval-job.ts by omission:\n  ${findings.join('\n  ')}\n`
      + 'Overlap, a throw, a database bound, a hung tick and an `unref` are what the interval job is for.');
  });

  it(`${KEEPALIVE} holds exactly one setInterval and clears it in a finally`, () => {
    const { count, unpaired } = keepaliveExemption(sources.get(KEEPALIVE));
    assert.equal(count, 1, `${KEEPALIVE} holds ${count} setInterval tokens: the exemption is ONE connection keepalive and no other timer may ride on it`);
    assert.deepEqual(unpaired, [], `a setInterval in ${KEEPALIVE} whose handle is not cleared in a \`finally\`: ${unpaired.join(' | ')}`);
  });

  describe('the owner holds the two halves a copy drops', () => {
    const owner = sources.get(OWNER);
    const start = () => balancedFrom(owner, owner.indexOf('start() {') + 'start() '.length - 1, 'the interval job start()');
    const stop = () => balancedFrom(owner, owner.indexOf('stop() {') + 'stop() '.length - 1, 'the interval job stop()');

    it('has exactly one setInterval and one clearInterval', () => {
      assert.equal(timerTokens(owner).length, 1, `${OWNER} must hold exactly one setInterval: it is the only owner`);
      assert.equal([...owner.matchAll(/\bclearInterval\b/g)].length, 1, `${OWNER} must hold exactly one clearInterval`);
      assert.match(owner, /\bsetInterval\(fn, ms\)/, 'the one setInterval is the default arm');
      assert.match(owner, /\bclearInterval\(handle\b/, 'the one clearInterval is the default disarm');
    });

    it('unrefs the timer before it keeps it, so a job can never hold the process open', () => {
      const body = start();
      const armAt = body.search(/\barm\(/);
      const unrefAt = body.search(/\bhandle\.unref\(\)/);
      const keepAt = body.search(/\btimer\s*=\s*handle\b/);
      assert.ok(armAt > -1 && unrefAt > armAt && keepAt > unrefAt,
        'start() must arm the timer, `unref` the handle, and only then keep it: a timer without `unref` holds a shutdown open');
    });

    it('stop() clears the timer it kept', () => {
      const body = stop();
      assert.match(body, /\bdisarm\(\s*handle\s*\)/, 'stop() must disarm the handle: a stop that only forgets it leaves the timer running');
      assert.match(body, /\btimer\s*=\s*null\b/, 'and forget it, so start() arms a fresh one');
    });
  });
});
