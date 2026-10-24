/**
 * No sync push handler, and nothing a push hands its page to, RAISES the space's version counter to a number a peer sent (bundle-81, design
 * rev 8 §1a and §6b, D-19 B, Q-241) — read over every handler the routers register.
 *
 * ## What this replaces
 *
 * `a-push-bumps-before-it-answers` held the opposite, from Q-198 (2026-08): every push handler AWAITED a bump of the counter past what it
 * received before it answered, because a counter left behind a record this instance held let the next local edit of that record take a LOWER
 * seq, which every peer holding the record refused. That rule had a price nobody had measured until Q-241: one peer record at `MAX_INGEST_SEQ`
 * dragged the counter to the ceiling, and this instance's next local write was stamped above what every receiver accepts, for ever. The
 * counter is the space's own version clock and nothing a peer sends moves it any more: the stamp of a local write is `max(V + 1, the version of
 * the record it replaces + 1, …)` (`util/version-stamp.ts`), so a local edit of a received record is above it WITHOUT the counter following. The
 * two guarantees are the same guarantee kept by a different mechanism, and each half is held elsewhere:
 *
 *  - an edit lands above the arrival it replaces, and a create lands above a tombstone a peer planted: `a-local-write-casts-on-the-version-it-read-db`
 *    and `a-planted-tombstone-blocks-no-create-db`;
 *  - nothing a peer sends can strand the counter near the ceiling: `q241-a-near-ceiling-record-is-held-to-the-ceiling-db` (behaviour).
 *
 * This file is the structural half of the second: **no path from a push door reaches a raiser of the counter.**
 *
 * ## What is derived, and the floors
 *
 *  - **The raisers.** `raiseVersionTo` (`util/version-stamp.ts`, the one function that raises the counter to a given value) and every function in
 *    `server/src` whose body calls one, to a fixpoint. Floor: the restore act is among them (it raises the counter to what it restored).
 *  - **The handlers.** Every POST registered on the sync routers that takes a seq off a received document (`TAKES_A_RECEIVED_SEQ`), with a handler
 *    built by a factory in the same file read through it; and the arrival writers every door hands its page to (`writeArrivals`,
 *    `acceptArrivingPage`, `applyPeerTombstones`), which are held as subjects of their own because a handler that moved the work out of its
 *    own text would otherwise be an escape. Floor: six handlers.
 *  - **The rule**: a handler's text, and each named writer's body, names no raiser.
 *
 * What a fork does is allowed and is not this: a fork is a LOCAL stamp (`versionsForRows`), which moves the counter by one per fork and never to
 * a received number.
 *
 * Run: node --test testing/standalone/a-push-never-moves-the-counter.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom, bodyOf } from './_structural-window.mjs';

const TAKES_A_RECEIVED_SEQ = /\.seq\b|seq:\s*z\.|Incoming\w+Doc|isSeqImplausible\(|rejectImplausibleSeq\(/;
/** The arrival writers every push door hands its page to: each is a subject, so a handler cannot move the work out of its own text to escape. */
const ARRIVAL_WRITERS = [
  ['server/src/sync/arrivals.ts', 'writeArrivals'],
  ['server/src/sync/accept-page.ts', 'acceptArrivingPage'],
  ['server/src/sync/tombstone-apply.ts', 'applyPeerTombstones'],
];

const HANDS_TO_A_WRITER = new RegExp(`\\b(?:${ARRIVAL_WRITERS.map(([, name]) => name).join('|')})\\(`);

/** `raiseVersionTo` and every server function whose body calls a raiser, to a fixpoint. */
function raisers() {
  const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: 200 }).map(({ file, text }) => ({ file, src: stripComments(text) }));
  const decls = [];
  for (const { file, src } of sources) {
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*async\b/gm)) {
      const name = m[1] ?? m[2];
      let body;
      try { body = bodyOf(src, name, `${file} ${name}`); } catch { continue; }
      decls.push({ name, body, file: file.replace(/\\/g, '/') });
    }
  }
  const found = new Set(['raiseVersionTo']);
  for (let grew = true; grew;) {
    grew = false;
    const callsOne = new RegExp(`\\b(?:\\w+\\.)?(?:${[...found].join('|')})\\(`);
    for (const d of decls) {
      if (!found.has(d.name) && d.name !== 'raiseVersionTo' && callsOne.test(d.body)) { found.add(d.name); grew = true; }
    }
  }
  return { found, decls };
}

/** Every POST on the sync routers that takes a seq off a received document, with its handler text resolved through same-file factories. */
function pushHandlers() {
  const out = [];
  for (const { file, text } of readTrackedSources('server/src/api/sync', { ext: ['.ts'], floor: 5 })) {
    const src = stripComments(text);
    const localFns = new Set([...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]));
    for (const m of src.matchAll(/(\w+Router)\.post\(\s*'([^']+)'/g)) {
      const reg = statementFrom(src, m.index, `${file} POST ${m[2]}`);
      const called = [...reg.matchAll(/\b(\w+)\(/g)].map(c => c[1]).filter(n => localFns.has(n));
      const handler = [reg, ...called.map(n => bodyOf(src, n, `${file} ${n}`))].join('\n');
      // Two ways to take a received page: in the handler's own text, or by handing it to one of the arrival writers (the tombstone door and the
      // single-record doors validate nothing themselves and hand their page to the one apply every door shares).
      if (TAKES_A_RECEIVED_SEQ.test(handler) || HANDS_TO_A_WRITER.test(handler)) out.push({ where: `${file.replace(/\\/g, '/')} POST ${m[2]}`, handler });
    }
  }
  return out;
}

const { found: RAISERS, decls } = raisers();
const HANDLERS = pushHandlers();

describe('no push handler raises the counter to a number a peer sent', () => {
  it('the derivations found their subjects, so an empty set cannot pass', () => {
    assert.ok(RAISERS.has('raiseVersionTo'), `raisers: ${[...RAISERS]}`);
    assert.ok(decls.some(d => d.file === 'server/src/db/restore-act.ts' && RAISERS.has(d.name)),
      `the restore act is no raiser (${[...RAISERS]}): the closure over the callers of raiseVersionTo is broken, so a handler could reach one unseen`);
    assert.ok(HANDLERS.length >= 6,
      `only ${HANDLERS.length} push handler(s) derived — the sweep is broken: ${HANDLERS.map(h => h.where).join(', ')}`);
  });

  for (const h of HANDLERS) {
    it(`${h.where} names no raiser of the counter`, () => {
      const names = [...RAISERS].join('|');
      const hits = [...h.handler.matchAll(new RegExp(`(?:^|[^\\w.])((?:\\w+\\.)?(?:${names}))\\(`, 'gm'))].map(m => m[1]);
      assert.deepEqual(hits, [],
        `${h.where} reaches ${hits.join(', ')}, which raises the version counter: a peer's number must never move this instance's own versions (D-19 B)`);
    });
  }

  for (const [file, name] of ARRIVAL_WRITERS) {
    it(`${name} (${file}), which every push door hands its page to, raises nothing`, () => {
      const src = stripComments(readTrackedSources('server/src', { ext: ['.ts'], floor: 200 }).find(s => s.file.replace(/\\/g, '/') === file)?.text ?? '');
      assert.ok(src.length > 0, `${file} is not among the tracked sources`);
      const body = bodyOf(src, name, `${file} ${name}`);
      const names = [...RAISERS].join('|');
      const hits = [...body.matchAll(new RegExp(`(?:^|[^\\w.])((?:\\w+\\.)?(?:${names}))\\(`, 'gm'))].map(m => m[1]);
      assert.deepEqual(hits, [], `${name} calls ${hits.join(', ')}, which raises the version counter to a number a peer sent`);
    });
  }

  it('the scan sees a raiser when there is one (a bump spelled as the old arrival writer spelled it is found)', () => {
    const body = 'async function door() { await raiseVersionTo(space, top); }';
    assert.ok(new RegExp(`(?:^|[^\\w.])((?:\\w+\\.)?(?:raiseVersionTo))\\(`, 'gm').test(body));
  });
});
