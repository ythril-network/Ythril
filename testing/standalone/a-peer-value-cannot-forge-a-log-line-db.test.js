/**
 * A value a peer sent cannot forge a line in this instance's log (`Q-107` part 1, pre-ship security pass; widened by
 * `Q-218` round R, item R6).
 *
 * ## The rule
 *
 * The arrival paths name what they did not store — document ids, the reason each was refused (built from the
 * document), the peer, a file's path — so an operator can find them. Interpolated raw, an `_id` of
 * `x\r\nFORGED [ERROR] ...` ends the warning and prints a second line that reads exactly like this server's own: log
 * injection, through the one channel an operator trusts to say what happened. Every such value goes through
 * `logSafe` (`util/log.ts`), which writes control characters as their escapes.
 *
 * ## Two halves
 *
 * 1. **Behaviour, sampled**: the log lines the server actually emits (the in-process ring) for two refusal paths a
 *    peer can steer — a document refused by the arrival writer's shape check, and one refused by the wire schema.
 *    Seen red by mutation, restored by hand: `logSafe` bypassed in `warnArrivalsNotStored`.
 * 2. **Source, over the whole set** (R6): a sample proves two paths and says nothing about the next one, which is how
 *    raw `member.label`, `round.roundId`, `remote.path` and `${err}` interpolations survived the first pass. So in
 *    EVERY file on the push, pull, import and gossip paths, every `${…}` inside a `log.*(…)` call is either wrapped
 *    whole in `logSafe(…)` / `peerText(…)` / `peerList(…)` (the same rule under three names, the last two also
 *    cutting) or is on `LOCAL_VALUES` — a short list of values this instance owns (a validated space id,
 *    a family name, a number). The file set is DERIVED: every tracked file under `server/src/sync`,
 *    `server/src/api/sync` and `server/src/networks` (where gossip's acts log what a peer told it), and every file
 *    that calls `writeArrivals(`, with floors. Comments are blanked before reading (so a comment
 *    explaining the fix neither trips nor satisfies the gate) with line numbers kept, so a finding names the real line.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-peer-value-cannot-forge-a-log-line-db.test.js
 * (requires a prior `npm run build` in server/; the source half needs no database)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const S = 'pushforge';
const FORGED = 'FORGED [ERROR] this line was written by a peer';
let door, logMod;

/** Every line the server logged while `fn` ran, split the way a log reader splits them. */
async function linesDuring(fn) {
  const lines = [];
  const stop = logMod.subscribeLogLines((l) => lines.push(l));
  try { await fn(); } finally { stop(); }
  return lines.join('\n').split(/\r\n|\r|\n/);
}

describe('a peer value cannot forge a log line', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushforge', spaces: [{ id: S, label: 'Forge', folders: [], meta: {} }] });
    logMod = await import('../../server/dist/util/log.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('logSafe escapes every line-breaking character and leaves ordinary text alone', () => {
    const { logSafe } = logMod;
    assert.equal(logSafe('plain id-1'), 'plain id-1');
    assert.equal(logSafe('a\r\nb'), 'a\\r\\nb');
    const LS = String.fromCharCode(0x2028), ESC = String.fromCharCode(0x1b), NEL = String.fromCharCode(0x85);
    assert.doesNotMatch(logSafe(`x${LS}y${ESC}z${NEL}w`), new RegExp(`[${LS}${ESC}${NEL}]`));
  });

  for (const [label, page] of [
    ['a document the arrival writer refuses (an implausible seq)', async () => {
      const { MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js');
      return { facts: [build.fact(S, `poison\r\n${FORGED}`, MAX_INGEST_SEQ + 1)] };
    }],
    ['a document the wire schema refuses (no fact text)', async () => {
      const bad = build.fact(S, `misfit\r\n${FORGED}`, 5);
      delete bad.fact;
      return { facts: [bad] };
    }],
  ]) {
    it(`${label}: its id is named, escaped, and starts no line of its own`, async () => {
      const body = await page();
      const lines = await linesDuring(async () => {
        const r = await door.push('/batch-upsert', body, { spaceId: S });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(r.body.facts.rejected, 1, 'fixture check: the document was not refused, so nothing was logged');
      });
      assert.ok(lines.some(l => l.includes('FORGED')), 'fixture check: the refusal was not logged at all');
      const forged = lines.filter(l => l.startsWith('FORGED'));
      assert.deepEqual(forged, [], 'a peer-supplied id started a log line of its own — log injection');
      assert.ok(lines.some(l => l.includes('\\r\\nFORGED')), 'the id was not shown escaped, so an operator cannot see what was sent');
    });
  }
});

// ── 2. the source rule, over every file on the arrival paths ──────────────────────────────────────────────────────

/**
 * Values this instance OWNS, so a peer cannot steer their text. Exact expressions, never patterns, each for a reason:
 *
 *  - ids this instance configured, read after the route checked them against config (`spaceAllowed`) or out of the
 *    config itself: `spaceId`, `networkId`, `net.id`, and a scheduler's own `schedule` / `cronExpr`;
 *  - registry names: a family, its collection, its payload key, an import type, a document type;
 *  - text built from parts that were ALREADY escaped: the writer's `message(err)` (it is `logSafe` inside) and its
 *    summary `shown` (each part `logSafe`d where it is built), and the writer's own `what` (a literal at each call).
 */
const LOCAL_VALUES = new Set([
  'spaceId', 'networkId', 'net.id', 'schedule', 'cronExpr',
  'family', 'family.collection', 'payloadKey', 'urlSuffix', 'kind', 't', 'collName', 'docType',
  'message(err)', "shown.join(', ')", 'what',
]);
/**
 * A NUMBER, and only what is a number BY CONSTRUCTION: an integer literal, a module constant, a `.length` or `.size`. Never a
 * NAME that sounds numeric (`status`, `seq`, `count`, `v` ...): a name says nothing about the value's type, and a
 * peer string under such a name would pass (`Q-218` round S, found by the pre-ship sweep). Anything else goes
 * through `logSafe`, which prints a number unchanged.
 */
const NUMERIC = /^(?:\d+|[A-Z][A-Z_]+|[\w.!]*\.(?:length|size))$/;
/** An arithmetic of numbers (`items.length - shown.length`), or a slice/case of a locally-owned name (`kind.slice(1)`). */
const derivedLocal = (e) =>
  e.split(/\s*[-+]\s*/).every(part => NUMERIC.test(part))
  || (/^(\w+)(?:\[\d+\]!?|\.(?:slice|toUpperCase|toLowerCase)\([\d, ]*\))+$/.test(e) && LOCAL_VALUES.has(e.match(/^\w+/)[0]));
/** A list whose every element was escaped as it was joined: `xs.map(x => logSafe(x)).join(', ')`. */
const joinedSafe = (e) => /^[\w.]+\.map\(\(?(\w+)\)? => logSafe\(\1\)\)\.join\('[^']*'\)$/.test(e);

/**
 * The files on the push, pull and import paths, and on gossip's: derived, with floors. `server/src/networks` is in
 * the set because what gossip LEARNS from a peer (a member's label, a vote round's subject, a space announcement) is
 * logged there, by the acts the engine hands it to (`Q-218` round S: three raw sites sat outside the first set).
 */
function arrivalPathFiles() {
  const syncDirs = trackedSources(['server/src/sync', 'server/src/api/sync', 'server/src/networks'], { floor: 20, specs: false });
  const callers = trackedSources('server/src', { specs: false })
    .filter(f => /\bwriteArrivals\s*\(/.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
  assert.ok(callers.length >= 4, `only ${callers.length} file(s) call writeArrivals: ${callers}`);
  return [...new Set([...syncDirs, ...callers])];
}

/** Index of the character closing the bracket opened at `open`, skipping strings and templates. */
function closing(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length > 0) {
    const ch = src[i];
    if (ch === '\'' || ch === '"') { i = skipString(src, i); continue; }
    if (ch === '`') { i = skipTemplate(src, i); continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i - 1;
}
function skipString(src, i) {
  const q = src[i++];
  while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}
function skipTemplate(src, i) {
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { i = closing(src, i + 1) + 1; continue; }
    i++;
  }
  return i + 1;
}
/** Every `${…}` in the span, nested templates included, as { expr, at }. */
function interpolations(src, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const ch = src[i];
    if (ch === '\'' || ch === '"') { i = skipString(src, i); continue; }
    if (ch === '`') {
      i++;
      while (i < to && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          const end = closing(src, i + 1);
          out.push({ expr: src.slice(i + 2, end).trim(), at: i });
          out.push(...interpolations(src, i + 2, end));
          i = end + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}
/**
 * The renderers of `util/log.ts` that escape a value for a line: `logSafe` and its bounded successors `peerText` (one
 * value) and `peerList` (a joined list), which cut as well (`Q-231`, `Q-270`). `logSafe` IS `peerText` — an alias pin
 * in `a-peer-value-is-rendered-escaped-redacted-and-bounded` — so accepting all three accepts one rule under three
 * names, and a slot rewritten from `logSafe(x)` to `peerText(x)` is no reason for this gate to go red.
 */
const BOUNDING_CALL = /^(?:logSafe|peerText|peerList)\(/;
/** `logSafe(…)` / `peerText(…)` / `peerList(…)` wrapping the WHOLE expression, not a part of it. */
const wholeLogSafe = (e) => BOUNDING_CALL.test(e) && closing(e, e.indexOf('(')) === e.length - 1;
/**
 * An expression whose every possible VALUE is a string literal: a literal, or a ternary choosing between literals (its
 * condition is never printed). A nested template counts as a literal here because its own `${…}` are checked on
 * their own.
 */
function literalsOnly(e) {
  let s = '';
  for (let i = 0; i < e.length;) {
    if (e[i] === '\'' || e[i] === '"') { i = skipString(e, i); s += '""'; continue; }
    if (e[i] === '`') { i = skipTemplate(e, i); s += '""'; continue; }
    s += e[i++];
  }
  const values = s.includes('?') ? s.slice(s.indexOf('?') + 1).split(':') : [s];
  return values.every(v => v.trim() === '""');
}

describe('every interpolation in a log call on the arrival paths is escaped or locally owned (R6)', () => {
  it('the file set is derived from the tree and the writer\'s callers, and every ${…} in a log.* call passes', () => {
    const files = arrivalPathFiles();
    assert.ok(files.length >= 15, `only ${files.length} arrival-path file(s): ${files}`);
    const raw = [];
    let calls = 0;
    for (const f of files) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      const src = blankComments(text);
      for (const m of src.matchAll(/\blog\.(?:warn|error|info|debug)\(/g)) {
        calls++;
        const open = m.index + m[0].length - 1;
        for (const { expr, at } of interpolations(src, open + 1, closing(src, open))) {
          if (wholeLogSafe(expr) || LOCAL_VALUES.has(expr) || NUMERIC.test(expr) || literalsOnly(expr)
            || derivedLocal(expr) || joinedSafe(expr)) continue;
          if (BOUNDING_CALL.test(expr) === false && /\b(?:logSafe|peerText|peerList)\(/.test(expr) && interpolationsOnlySafe(expr)) continue;
          raw.push(`${f}:${src.slice(0, at).split('\n').length}: \${${expr}}`);
        }
      }
    }
    assert.ok(calls >= 50, `only ${calls} log call(s) read — the scan is broken, not the code`);
    assert.deepEqual(raw, [], 'a log line on the push, pull or import path interpolates a value that is neither '
      + 'escaped with logSafe nor owned by this instance: a peer that controls it can end the line and forge the next');
  });
});

/** A conditional or concatenation whose every value-bearing operand is a bounding-renderer call or a string literal. */
function interpolationsOnlySafe(expr) {
  let rest = expr;
  for (;;) {
    const at = rest.search(/\b(?:logSafe|peerText|peerList)\(/);
    if (at < 0) break;
    const open = rest.indexOf('(', at);
    rest = `${rest.slice(0, at)}''${rest.slice(closing(rest, open) + 1)}`;
  }
  return literalsOnly(rest);
}
