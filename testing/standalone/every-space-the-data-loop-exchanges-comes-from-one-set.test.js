/**
 * Every space the data loop exchanges comes from the ONE set the hold produces, and every watermark it writes asks the hold first (bundle-106 PR A,
 * section 3.4, section 6.2; VR6, VR13, T-1c, TS-8).
 *
 * ## The rule, as a rule and not as a spelling
 *
 * The data loop walks the spaces a network carries and exchanges each with a member. Two defects came out of walking a LIST instead of asking: a
 * deletion that applied in the gossip pass of the same cycle did not stop the exchange of the space it removed (the loop held the list it read at
 * the start), and the watermarks of that exchange were written back after the removal had cleared them. So:
 *
 * 1. **Every loop that exchanges a space iterates a set `exchangeVerdicts(` produced.** In `server/src/sync/`, every `for (... of X)` whose body calls
 *    `pullFromPeer(`, `pushToPeer(`, `syncFiles(` or the per-space turn `exchangeSpaceWithMember(` iterates an `X` that is initialised from
 *    `exchangeVerdicts(` - read through whatever name the variable has, because v2 matched the literal `for (... of net.spaces)` and a renamed variable
 *    evaded it. A loop over `net.spaces` is the defect.
 * 2. **Each such loop asks `mayExchangeNow(` again, inside its body, BEFORE the exchange call** (an act can begin, or a wipe finish, between the verdicts and
 *    this space's turn - the tick, the relay and an operator's cast apply mid-loop).
 * 3. **Every statement that writes a `lastSeqReceived` or `lastSeqPushed` mark sits inside an `if` that asks `mayExchangeNow(`**: a space removed or
 *    newly held between the start of its exchange and the write is not written back. The writers are derived BY THE ASSIGNMENT, not named.
 * 4. **The third mark writer** (`setMemberSpaceMark(`) is reached only from inside the held iteration, which is why it has no guard of its own: its callers
 *    are listed with that reason, and a new caller file fails until someone decides.
 *
 * ## Why the floors, and the instrument
 *
 * Every set is read out of the code and carries a floor (at least one exchanging loop, at least two mark writers, at least two `setMemberSpaceMark`
 * callers): an empty derivation passes every loop written over it. The classifiers are exercised on snippets first - a loop over a verdict set passes, a
 * loop over `net.spaces`, a renamed list, an unguarded mark write and a guarded one each get the verdict the rule needs - so a green gate is not a scan that
 * cannot see.
 *
 * ## Seen red
 *
 * Against 84f0b3cc `exchangeVerdicts` and `mayExchangeNow` do not exist: the engine's loop iterates `net.spaces` (rule 1), asks nothing before the exchange
 * (rule 2), and both mark writes sit under `if (highestSeq > sinceSeq)` / `if (maxSeqPushed > lastSeqPushed)` alone (rule 3). After the fix, by hand: iterate
 * `net.spaces` in the loop head -> rule 1 names the loop; remove the guard from one watermark write -> rule 3 names it.
 *
 * Run: node --test testing/standalone/every-space-the-data-loop-exchanges-comes-from-one-set.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, walkEveryNode, lineOf, ts } from '../_shared/syntax-tree.mjs';

const SYNC_DIR = 'server/src/sync';
/** The calls that exchange one space with one member: the three transfers and the per-space turn the design moves them into. */
const EXCHANGE_CALLS = ['pullFromPeer', 'pushToPeer', 'syncFiles', 'exchangeSpaceWithMember'];
/** The marks whose writes the hold guards (one number per member per space, one per direction). */
const MARKS = ['lastSeqReceived', 'lastSeqPushed'];
/** The callers of the third mark writer at 84f0b3cc, each reached only from inside the held iteration. */
const SET_MARK_CALLERS = [
  { file: 'server/src/sync/file-tombstone-ack.ts', why: 'the file-tombstone acknowledgement is written by the file transfer the loop runs for a space it has just asked the hold about' },
  { file: 'server/src/sync/served-watermark.ts', why: 'what THIS instance served a peer: written by the inbound document doors, which ask refusePeerSpace before they serve' },
];

const source = (file) => stripComments(readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
const syncSources = () => trackedSources(SYNC_DIR, { untracked: true, floor: 30 }).filter(f => f.endsWith('.ts'));

const calledNames = (node, sf) => {
  const names = [];
  walkEveryNode(node, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.push({ name: n.expression.text, pos: n.getStart(sf) }); });
  return names;
};

/** The function (or source file) a node is written in, for resolving a variable's initialiser. */
const scopeOf = (node) => { let s = node.parent; while (s && !ts.isFunctionLike(s) && !ts.isSourceFile(s)) s = s.parent; return s; };

/** The text a local name is initialised from in the scope of `node`: `const x = ...`, `const { x } = ...`, `const { y: x } = ...`; `null` when it is declared no such way. */
export function initialiserTextOf(node, name, sf) {
  let found = null;
  walkEveryNode(scopeOf(node), (n) => {
    if (found !== null || !ts.isVariableDeclaration(n) || !n.initializer) return;
    if (ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer.getText(sf);
    else if (ts.isObjectBindingPattern(n.name) && n.name.elements.some(e => ts.isIdentifier(e.name) && e.name.text === name)) found = n.initializer.getText(sf);
  });
  return found;
}

/** Every `for (... of X)` whose body exchanges a space, with what `X` is initialised from, and where the re-check sits relative to the exchange call. */
export function exchangingLoops(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isForOfStatement(n)) return;
    const inBody = calledNames(n.statement, sf);
    const exchange = inBody.filter(c => EXCHANGE_CALLS.includes(c.name)).map(c => c.pos);
    if (exchange.length === 0) return;
    const iterable = ts.isIdentifier(n.expression) ? n.expression.text : null;
    const recheck = inBody.filter(c => c.name === 'mayExchangeNow').map(c => c.pos);
    out.push({
      file, line: lineOf(sf, n), iterableText: n.expression.getText(sf),
      initialisedFrom: iterable ? initialiserTextOf(n, iterable, sf) : n.expression.getText(sf),
      recheckBeforeExchange: recheck.length > 0 && Math.min(...recheck) < Math.min(...exchange),
    });
  });
  return out;
}

/** Every assignment to `<x>.lastSeqReceived[...]` / `<x>.lastSeqPushed[...]`, with whether an enclosing `if` (within its function) asks `mayExchangeNow(`. */
export function markWrites(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = n.left;
    if (!ts.isElementAccessExpression(left)) return;
    const target = left.expression;
    const mark = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : null;
    if (!MARKS.includes(mark)) return;
    let guarded = false;
    for (let p = n.parent; p && !ts.isFunctionLike(p); p = p.parent) {
      if (ts.isIfStatement(p) && /\bmayExchangeNow\s*\(/.test(p.expression.getText(sf))) guarded = true;
    }
    out.push({ file, line: lineOf(sf, n), mark, guarded });
  });
  return out;
}

describe('the classifiers are exercised before they are trusted', () => {
  const loops = (src) => exchangingLoops('snippet.ts', src).map(l => ({ from: /exchangeVerdicts\s*\(/.test(l.initialisedFrom ?? '') ? 'verdicts' : 'other', recheck: l.recheckBeforeExchange }));
  it('a loop over a verdict set passes, whatever the variable is called; a loop over net.spaces, a renamed list and a loop with a late re-check do not', () => {
    assert.deepEqual(loops(`async function f() { const { exchange, held } = exchangeVerdicts(net, m); for (const s of exchange) { if (!mayExchangeNow(a, b, s)) continue; await pullFromPeer(m, s); } }`), [{ from: 'verdicts', recheck: true }]);
    assert.deepEqual(loops(`async function f() { const carried = exchangeVerdicts(net, m).exchange; for (const s of carried) { if (!mayExchangeNow(a, b, s)) continue; await exchangeSpaceWithMember(m, s); } }`), [{ from: 'verdicts', recheck: true }]);
    assert.deepEqual(loops(`async function f() { for (const s of net.spaces) { await pullFromPeer(m, s); } }`), [{ from: 'other', recheck: false }]);
    assert.deepEqual(loops(`async function f() { const list = net.spaces; for (const s of list) { await syncFiles(m, s); } }`), [{ from: 'other', recheck: false }]);
    assert.deepEqual(loops(`async function f() { const { exchange } = exchangeVerdicts(net, m); for (const s of exchange) { await pushToPeer(m, s); if (!mayExchangeNow(a, b, s)) continue; } }`), [{ from: 'verdicts', recheck: false }]);
  });
  it('a loop that exchanges nothing is not a subject', () => {
    assert.deepEqual(exchangingLoops('snippet.ts', `async function f() { for (const s of net.spaces) { warm(s); } }`), []);
  });
  it('a mark write is guarded only by an enclosing if that asks mayExchangeNow, in its own function', () => {
    const writes = (src) => markWrites('snippet.ts', src).map(w => `${w.mark}:${w.guarded}`);
    assert.deepEqual(writes(`function f() { if (highestSeq > sinceSeq) { if (m) { m.lastSeqReceived[s] = highestSeq; } } }`), ['lastSeqReceived:false']);
    assert.deepEqual(writes(`function f() { if (mayExchangeNow(a, b, s) && highestSeq > sinceSeq) { m.lastSeqPushed[s] = max; } }`), ['lastSeqPushed:true']);
    // a closure runs later than the if that encloses it: the guard of the outer function says nothing about the moment the closure writes
    assert.deepEqual(writes(`function f() { if (mayExchangeNow(a, b, s)) { const g = () => { m.lastSeqPushed[s] = max; }; } }`), ['lastSeqPushed:false']);
    assert.deepEqual(writes(`function f() { m.somethingElse[s] = 1; m.lastSeqReceived = {}; }`), []);
  });
});

describe('the data loop exchanges only what exchangeVerdicts produced', () => {
  const found = () => syncSources().flatMap(f => exchangingLoops(f, source(f)));

  it('the derivation found at least one exchanging loop', () => {
    const loops = found();
    assert.ok(loops.length >= 1, 'no for-of loop under sync/ calls a transfer: the derivation cannot see the data loop, and every check below is vacuous');
  });

  it('rule 1: each loop iterates a set initialised from exchangeVerdicts(', () => {
    const offenders = found().filter(l => !/\bexchangeVerdicts\s*\(/.test(l.initialisedFrom ?? ''))
      .map(l => `${l.file}:${l.line} iterates ${l.iterableText}${l.initialisedFrom ? ` (initialised from ${l.initialisedFrom.slice(0, 60)})` : ''}`);
    assert.deepEqual(offenders, [], `these loops exchange the spaces of a list read at the start of the cycle, not the set the hold produced:\n  ${offenders.join('\n  ')}`);
  });

  it('rule 2: each loop asks mayExchangeNow( in its body before the exchange call', () => {
    const offenders = found().filter(l => !l.recheckBeforeExchange).map(l => `${l.file}:${l.line}`);
    assert.deepEqual(offenders, [], `these loops go straight to the exchange: an act that began, or a wipe that finished, since the verdicts is not noticed:\n  ${offenders.join('\n  ')}`);
  });
});

describe('every watermark the data loop writes asks the hold first', () => {
  const writes = () => trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts')).flatMap(f => markWrites(f, source(f)));

  it('the derivation found the two mark writers', () => {
    const found = writes();
    assert.ok(found.length >= 2 && MARKS.every(m => found.some(w => w.mark === m)), `found ${found.length} mark write(s) (${found.map(w => `${w.file}:${w.line} ${w.mark}`).join(', ')}): want at least one lastSeqReceived and one lastSeqPushed`);
  });

  it('rule 3: each is inside an if that asks mayExchangeNow(', () => {
    const offenders = writes().filter(w => !w.guarded).map(w => `${w.file}:${w.line} writes ${w.mark}`);
    assert.deepEqual(offenders, [], `these writes put a position into the config for a space nobody asked the hold about: a deletion mid-iteration resurrects cleared marks, and a wipe mid-pull leaves a mark past data about to go:\n  ${offenders.join('\n  ')}`);
  });

  it('rule 4: setMemberSpaceMark( is called from the listed files only, each with its reason', () => {
    const callers = new Map();
    for (const file of trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts') && f !== 'server/src/sync/member-space-mark.ts')) {
      const sf = parseSource(file, source(file));
      let n = 0;
      walkEveryNode(sf, (node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setMemberSpaceMark') n++; });
      if (n > 0) callers.set(file, n);
    }
    assert.ok(callers.size >= 2, `only ${callers.size} file(s) call setMemberSpaceMark(: the derivation is broken`);
    for (const entry of SET_MARK_CALLERS) assert.ok(entry.why.split(/\s+/).length >= 6, `${entry.file}: the reason is not a reason`);
    assert.deepEqual([...callers.keys()].sort(), SET_MARK_CALLERS.map(e => e.file).sort(),
      'the set of files that write a per-space mark through setMemberSpaceMark( changed: decide whether the new writer is reached only inside the held iteration, then list it with its reason');
  });
});
