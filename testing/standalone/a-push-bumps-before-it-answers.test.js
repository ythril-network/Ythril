/**
 * Every sync push handler AWAITS its counter bump before it answers about the documents it received — read by
 * statement ORDER, over every handler the routers register (`Q-198`, `Q-107` part 1 §3).
 *
 * ## Why an order gate and not only a behaviour test
 *
 * `a-push-moves-the-counter-past-what-it-received-db` observes the counter at the moment of the answer, which
 * is the behaviour. It cannot see a door it has no case for, and a fire-and-forget `$max` that happens to land
 * in time looks identical to an awaited one on a fast machine. This file asks the structural half: in the
 * handler's own text, every answer that follows the point where the body was accepted is preceded by an
 * `await` of something that bumps the counter, and no bump is left un-awaited.
 *
 * ## The rule, exactly
 *
 * For every POST registered on the sync routers whose handler takes a `seq` off a received document:
 *
 *   1. **Every `res.status(` / `res.json(` after the body is accepted is preceded by an awaited bump.** "After
 *      the body is accepted" is after the last shape/plausibility guard (`parsed.success`,
 *      `rejectImplausibleSeq(`, `isSeqImplausible(`): a 400 refusing a malformed body has received nothing to
 *      bump over. The 400s that follow it — a fork at its cap, a chrono type this space does not declare —
 *      were parsed, and so bump first (security `S9`).
 *   2. **No bump is called without `await`.** `bumpSeq(...).catch(() => {})` is the shape this gate exists to
 *      end: the answer goes out while the counter is still behind.
 *
 * "Bumps" is DERIVED, not listed: `bumpSeq` and every function in `server/src` whose body awaits one, to a
 * fixpoint, so a writer that bumps per chunk (`writeArrivals`) counts without this file naming it.
 *
 * Statement order is an approximation of execution order, and it is stated as one: an awaited bump inside an
 * `if` branch above an answer satisfies rule 1 textually. The behaviour test is the other half for that reason.
 *
 * Run: node --test testing/standalone/a-push-bumps-before-it-answers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom, bodyOf } from './_structural-window.mjs';

const TAKES_A_RECEIVED_SEQ = /\.seq\b|seq:\s*z\.|Incoming\w+Doc|isSeqImplausible\(|rejectImplausibleSeq\(/;
const GUARD = /parsed\.success|rejectImplausibleSeq\(|isSeqImplausible\(/g;

/** `bumpSeq` and every server function whose body awaits a bumper, to a fixpoint. */
function bumpers() {
  const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: 200 }).map(({ file, text }) => ({ file, src: stripComments(text) }));
  const decls = [];
  for (const { file, src } of sources) {
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*async\b/gm)) {
      const name = m[1] ?? m[2];
      let body;
      try { body = bodyOf(src, name, `${file} ${name}`); } catch { continue; }
      decls.push({ name, body });
    }
  }
  const found = new Set(['bumpSeq']);
  for (let grew = true; grew;) {
    grew = false;
    const awaitsOne = new RegExp(`\\bawait\\s+(?:\\w+\\.)?(?:${[...found].join('|')})\\(`);
    for (const d of decls) {
      if (!found.has(d.name) && awaitsOne.test(d.body)) { found.add(d.name); grew = true; }
    }
  }
  return found;
}

/**
 * Every POST on the sync routers that takes a seq off a received document, with its handler text resolved.
 *
 * Two ways to take one: in the handler's own text (`TAKES_A_RECEIVED_SEQ`), or by handing what arrived to a
 * derived bumper — the tombstone door validates nothing itself since bundle-46, it hands its page to the one apply
 * both tombstone doors share, and a selection by spelling alone lost the door the day its seq check moved.
 */
function pushHandlers(bumperNames) {
  const handsToABumper = new RegExp(`\\bawait\\s+(?:\\w+\\.)?(?:${[...bumperNames].join('|')})\\(`);
  const out = [];
  for (const { file, text } of readTrackedSources('server/src/api/sync', { ext: ['.ts'], floor: 5 })) {
    const src = stripComments(text);
    const localFns = new Set([...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]));
    for (const m of src.matchAll(/(\w+Router)\.post\(\s*'([^']+)'/g)) {
      const reg = statementFrom(src, m.index, `${file} POST ${m[2]}`);
      // A handler built by a factory in the same file is read through it, so moving the body into one is no escape.
      const called = [...reg.matchAll(/\b(\w+)\(/g)].map(c => c[1]).filter(n => localFns.has(n));
      const handler = [reg, ...called.map(n => bodyOf(src, n, `${file} ${n}`))].join('\n');
      if (TAKES_A_RECEIVED_SEQ.test(handler) || handsToABumper.test(handler)) out.push({ where: `${file.replace(/\\/g, '/')} POST ${m[2]}`, handler });
    }
  }
  return out;
}

/** Index just past the last accept guard, widened to the end of the `if` statement it opens, if it opens one. */
function acceptedFrom(handler) {
  const guards = [...handler.matchAll(GUARD)];
  if (guards.length === 0) return 0;
  const last = guards.at(-1).index;
  const lineStart = handler.lastIndexOf('\n', last) + 1;
  const line = handler.slice(lineStart);
  if (/^\s*if\s*\(/.test(line)) {
    const stmtStart = lineStart + line.search(/\S/);
    return stmtStart + statementFrom(handler, stmtStart, 'accept guard').length;
  }
  return last;
}

const BUMPERS = bumpers();
const HANDLERS = pushHandlers(BUMPERS);

describe('every push handler awaits its counter bump before it answers', () => {
  it('the derivations found their subjects, so an empty set cannot pass', () => {
    assert.ok(BUMPERS.has('bumpSeq') && BUMPERS.size >= 2, `bumpers: ${[...BUMPERS]}`);
    assert.ok(HANDLERS.length >= 6,
      `only ${HANDLERS.length} push handler(s) derived — the sweep is broken: ${HANDLERS.map(h => h.where).join(', ')}`);
  });

  for (const h of HANDLERS) {
    it(`${h.where}: every answer after the body is accepted follows an awaited bump`, () => {
      const names = [...BUMPERS].join('|');
      const awaited = [...h.handler.matchAll(new RegExp(`\\bawait\\s+(?:\\w+\\.)?(?:${names})\\(`, 'g'))].map(m => m.index);
      const from = acceptedFrom(h.handler);
      const early = [...h.handler.matchAll(/\bres\.(?:status|json)\(/g)]
        .filter(m => m.index > from && !awaited.some(a => a < m.index))
        .map(m => h.handler.slice(m.index, h.handler.indexOf('\n', m.index)).trim());
      assert.deepEqual(early, [],
        `${h.where} answers before any awaited counter bump. A peer told its push landed while this instance's `
        + 'counter is still below what it received lets the next local write take a lower seq than a record the '
        + `peer already holds. Bumpers derived: ${[...BUMPERS].join(', ')}`);
    });

    it(`${h.where}: no bump is left un-awaited`, () => {
      const names = [...BUMPERS].join('|');
      const loose = [...h.handler.matchAll(new RegExp(`(^|[^\\w.])((?:\\w+\\.)?(?:${names}))\\(`, 'gm'))]
        .filter(m => !/(?:await|function)\s*$/.test(h.handler.slice(h.handler.lastIndexOf('\n', m.index) + 1, m.index + m[1].length)))
        .map(m => h.handler.slice(m.index, h.handler.indexOf('\n', m.index)).trim());
      assert.deepEqual(loose, [], `${h.where} calls a counter bump without awaiting it`);
    });
  }
});
