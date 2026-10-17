/**
 * Every transfer of a space enters the fence, ends at its next unit when an act registers, and leaves it on every path (bundle-106, §3.3a, W4, X5, X9).
 *
 * ## The rule, in three halves
 *
 * A wipe or a deletion of a space registers, then waits for the transfers ADMITTED before it to end (`awaitSpaceTransfersDrained`), then
 * deletes. For the wait to be short and the delete to be safe, three things hold for every transfer, and each is derived here from the code:
 *
 * 1. **The outbound turn is cancellable.** Every loop in the transfer modules that fetches from a peer asks `mayContinue(` inside its body
 *    (between pages, between files), and the fetch is handed the transfer's `signal` so the unit in flight is cut at once. A loop that
 *    never asks runs a whole turn (minutes to hours on a first sync) past a registered act. The transfer modules are DERIVED (every module
 *    under `sync/` with a `peerSafeFetch(` to a space-scoped route), every such fetch combines the turn's signal (`turnSignal(`) in a
 *    function that takes a `turn`, and every call of a function that takes a `turn` hands it on - so a wrapper that drops it (the tombstone
 *    pull's, the re-reads) is found at its call, not by a list.
 * 2. **Every inbound peer door enters and leaves.** The doors are derived: every route block under `server/src/api` that calls
 *    `refusePeerSpace(`, `pushAllowed(`, `refuseHeldPeer(` or — before those exist — `spaceAllowed(`, `requireSpaceAuthScoped`. Each must
 *    reach `enterSpaceTransfer(` in its own block or in the one helper it calls (one level: the helper is the module-level function of that
 *    name), and every function that enters releases in a `finally` and on the response's `close`. A door that enters and releases only on
 *    the happy path leaks a count, and a leaked count blocks an act's drain for ever (REL F11).
 * 3. **The fence is the ONE module.** Nobody but `sync/space-transfer-fence.ts` keeps a count of transfers of a space.
 *
 * ## Why derived, and why the floor
 *
 * v4 named three inbound askers by hand and the gate passed while a fourth door (`GET /api/sync/manifest`) entered nothing. The doors are
 * read out of the route registrations; `FLOOR` is the push doors alone (`pushAllowed` has seven callers at a638e702) — the read doors
 * only add to it once `refusePeerSpace` replaces their hand-written `spaceAllowed` pair.
 *
 * ## Seen red (by hand)
 *
 * At a638e702 neither the fence nor `sync/space-exchange.ts` exists: every case fails for that. After the fix: take `mayContinue(` out of
 * the file loop's body -> half 1 names the loop; move one door's `release()` out of its `finally` -> half 2 names the door; enter one
 * hand-named inbound door only -> half 2 names the rest (the v4 shape).
 *
 * Run: node --test testing/standalone/every-transfer-enters-the-fence.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, walkEveryNode, outermostFunctionOf, lineOf, routeBlocksOf, ts } from '../_shared/syntax-tree.mjs';

const FENCE = 'server/src/sync/space-transfer-fence.ts';
const EXCHANGE = 'server/src/sync/space-exchange.ts';
/** The modules the original four-file list named: the derivation below must still find each (its floor), and may only add to them. */
const FLOOR_MODULES = ['pull-family.ts', 'push-family.ts', 'file-sync.ts', 'tombstone-transfer.ts'].map(f => `server/src/sync/${f}`);
/** A space-scoped peer route: the sync data routes and the peer file door; the governance routes that name a network are not a space transfer. */
const SPACE_SCOPED = /\/api\/(?:sync\/(?!networks\/|warm\b|notify\b)|files\/)/;

/** The text a fetch's URL resolves to: the argument, or the initializer of the identifier it names inside the same function. */
function urlTextOf(call, fn, sf) {
  const arg = call.arguments[0];
  if (!arg) return '';
  if (!ts.isIdentifier(arg) || !fn) return arg.getText(sf);
  let found = '';
  walkEveryNode(fn, (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text && n.initializer) found = n.initializer.getText(sf); });
  return found || arg.getText(sf);
}

/**
 * Every `peerSafeFetch(` under `server/src/sync/` to a space-scoped route, with the outermost function it is written in: DERIVED, so a module
 * that starts fetching a space is a subject the day it does (the list this replaced named four files and missed the schema pull and merkle).
 */
function spaceFetches() {
  const out = [];
  for (const file of trackedSources(['server/src/sync'], { untracked: true, floor: 20 })) {
    const sf = parseSource(file, text(file));
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'peerSafeFetch') return;
      const fn = outermostFunctionOf(n);
      if (SPACE_SCOPED.test(urlTextOf(n, fn, sf))) out.push({ file, line: lineOf(sf, n), fn, sf });
    });
  }
  return out;
}
/** The outbound modules that move a space's pages and files: every module with a space fetch. */
const transferModules = () => [...new Set(spaceFetches().map(s => s.file))];

/** A function's parameter list names `turn` (a parameter, or a field of its options object). */
const takesTurn = (fn, sf) => !!fn && ts.isFunctionLike(fn) && fn.parameters.some(p => /\bturn\b/.test(p.getText(sf)));
/** The name of a function node: a declaration's own, or the const it is bound to. */
function nameOf(fn) {
  if (fn?.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn?.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}
/**
 * Calls that may leave the turn out, each with its reason. A row that no longer matches a call fails, so it cannot go stale into a hole.
 */
const TURNLESS_CALLS = [
  { caller: 'exchangeSpacesWithMember', callee: 'pullSpaceMetaFromUpstream',
    why: 'the schema pull of a HELD space runs outside the fence on purpose (design v5 X17): a wipe changes no schema, and that space has no turn to hand' },
];
/** The push doors alone, at a638e702: `pushAllowed` callers (docs.ts: five, tombstones.ts: two). */
const FLOOR = 7;
const DOOR_ASKS = ['refusePeerSpace', 'pushAllowed', 'refuseHeldPeer'];
/** What enters the fence: the admission itself, and the peer admission (`sync/peer-space-admission.ts`) that wraps it for every door. */
const ENTERING = ['enterSpaceTransfer', 'admitPeer'];
/**
 * Functions that enter and do NOT release themselves, because the transfer (or its release) is their RESULT. Each row names why, and the test
 * holds every call of it to a function that releases in a finally, or to another row whose own callers do — so a hander whose caller drops the
 * release is found at the call, not by a list of callers.
 */
const HANDS_ON = [
  { fn: 'admitPeer', why: 'returns the transfer it admitted, because the medium decides what a close is: a response binds it to its close, a tool call to its own end' },
  { fn: 'admitPeerToolCall', why: 'returns the release of a tool call\'s transfer, which the dispatcher keeps and calls from a finally however the call ends' },
  { fn: 'dispatchTool', why: 'pushes the release of every transfer its call was admitted with onto a list the wrapping callTool releases in a finally' },
];
const text = (f) => readFileSync(`${REPO_ROOT}/${f}`, 'utf8');
const callsNamed = (sf, name) => { const out = []; walkEveryNode(sf, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n); }); return out; };

/** Route registrations (`xRouter.get(...)`, `app.post(...)`) in a parsed file, each with its argument list text. */
const routeBlocks = routeBlocksOf;

describe('the outbound turn is cancellable', () => {
  it('the fence and the turn module exist', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${FENCE}`), `${FENCE} does not exist: no transfer is counted, so an act cannot know what to wait for`);
    assert.ok(existsSync(`${REPO_ROOT}/${EXCHANGE}`), `${EXCHANGE} does not exist: the per-space turn that enters the fence has no home (engine.ts is frozen and cannot hold it)`);
    assert.match(text(EXCHANGE), /\benterSpaceTransfer\(/, 'the turn never enters the fence');
  });

  it('the transfer modules are derived from the space fetches, at or above the four the first list named', () => {
    const found = transferModules();
    const missing = FLOOR_MODULES.filter(f => !found.includes(f));
    assert.deepEqual(missing, [], `the derivation no longer finds ${missing.join(', ')}: it is broken, and every check below would pass over less`);
  });

  it('every space fetch takes the turn\'s signal, in a function that can be handed the turn', () => {
    const fetches = spaceFetches();
    assert.ok(fetches.length >= 11, `only ${fetches.length} space fetch(es) under sync/ were found: the derivation is broken`);
    const blind = fetches.filter(s => !/\bturnSignal\(/.test(s.fn ? s.fn.getText(s.sf) : '')).map(s => `${s.file}:${s.line}`);
    assert.deepEqual(blind, [], `these fetches cannot be cut when an act registers - their function never combines the turn's signal:\n  ${blind.join('\n  ')}`);
    const turnless = fetches.filter(s => !takesTurn(s.fn, s.sf)).map(s => `${s.file}:${s.line} in ${nameOf(s.fn) ?? 'an anonymous function'}`);
    assert.deepEqual(turnless, [], `these fetches sit in a function that takes no turn, so no caller can hand it one:\n  ${turnless.join('\n  ')}`);
  });

  it('every call of a function that takes the turn hands it on (or is a listed exception with its reason)', () => {
    // The functions that take a turn, derived from their parameters: a wrapper of a transfer (the tombstone pull's, the re-reads) is one
    // the day it is given a `turn`, and a wrapper that is NOT given one is found here, at its call of the transfer it wraps.
    const takers = new Set();
    for (const file of trackedSources(['server/src/sync'], { untracked: true, floor: 20 })) {
      const sf = parseSource(file, text(file));
      walkEveryNode(sf, (n) => { if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && takesTurn(n, sf) && nameOf(n)) takers.add(nameOf(n)); });
    }
    assert.ok(takers.size >= 8, `only ${takers.size} function(s) take a turn: the derivation is broken`);
    const dropped = []; const used = new Set();
    for (const file of trackedSources(['server/src'], { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'))) {
      const sf = parseSource(file, text(file));
      walkEveryNode(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !takers.has(n.expression.text)) return;
        if (n.arguments.some(a => /\bturn\b/.test(a.getText(sf)))) return;
        const caller = nameOf(outermostFunctionOf(n));
        const row = TURNLESS_CALLS.find(r => r.caller === caller && r.callee === n.expression.text);
        if (row) { used.add(row); return; }
        dropped.push(`${file}:${lineOf(sf, n)} ${caller ?? '(module)'} -> ${n.expression.text}`);
      });
    }
    assert.deepEqual(dropped, [], `these calls drop the turn, so the fetches below them cannot be cut when an act registers:\n  ${dropped.join('\n  ')}`);
    for (const row of TURNLESS_CALLS) {
      assert.ok(used.has(row), `the exception ${row.caller} -> ${row.callee} no longer matches a call: remove or re-reason it`);
      assert.ok(row.why.split(/\s+/).length >= 8, `${row.caller} -> ${row.callee}: the reason is not a reason`);
    }
  });

  it('every loop that fetches from a peer asks mayContinue between units, and its fetch carries the transfer signal', () => {
    const loops = [];
    const TRANSFER_MODULES = transferModules();
    for (const file of TRANSFER_MODULES) {
      const sf = parseSource(file, text(file));
      walkEveryNode(sf, (n) => {
        if (!(ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n))) return;
        const body = n.statement.getText(sf);
        if (!/\bpeerSafeFetch\(|\bpullFamily\(|\bfetchPage\(|\bsyncOneFile\(/.test(body)) return;
        // Only the OUTERMOST loop that fetches is a unit boundary of the turn; an inner retry loop is inside its unit.
        let outer = n.parent; let nested = false;
        for (; outer && !ts.isFunctionLike(outer); outer = outer.parent) {
          if ((ts.isForStatement(outer) || ts.isForOfStatement(outer) || ts.isWhileStatement(outer)) && /\bpeerSafeFetch\(/.test(outer.statement.getText(sf))) nested = true;
        }
        if (!nested) loops.push({ file, line: lineOf(sf, n), body });
      });
    }
    assert.ok(loops.length >= 3, `the derivation found ${loops.length} fetching loop(s) across the transfer modules: an empty set passes every check below`);
    const blind = loops.filter(l => !/\bmayContinue\(/.test(l.body)).map(l => `${l.file}:${l.line}`);
    assert.deepEqual(blind, [], `these loops move units from a peer and never ask transfer.mayContinue(): an act registered meanwhile waits for the whole turn:\n  ${blind.join('\n  ')}`);
    for (const file of TRANSFER_MODULES) {
      assert.match(stripComments(text(file)), /\bsignal\b/,
        `${file} never mentions the transfer's signal: the unit in flight cannot be cut when an act registers`);
    }
  });

  it('the turn releases its transfer in a finally', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${EXCHANGE}`), `${EXCHANGE} does not exist: there is no turn to release`);
    const sf = parseSource(EXCHANGE, text(EXCHANGE));
    const enters = callsNamed(sf, 'enterSpaceTransfer');
    assert.ok(enters.length >= 1, 'the turn module never calls enterSpaceTransfer(');
    for (const call of enters) {
      const fn = outermostFunctionOf(call);
      let released = false;
      walkEveryNode(fn, (n) => { if (ts.isTryStatement(n) && n.finallyBlock && /\brelease\(/.test(n.finallyBlock.getText(sf))) released = true; });
      assert.ok(released, `${EXCHANGE}:${lineOf(sf, call)} enters the fence and does not release in a finally: a turn that throws (engine.ts throws on incomplete) leaks its count`);
    }
  });
});

describe('every inbound peer door enters the fence and leaves it on every path', () => {
  const apiFiles = () => trackedSources(['server/src/api', 'server/src/auth'], { untracked: true, floor: 30 });

  /** Module-level helpers (by name) across the api and auth trees, with their text: what a door's one call level may enter through. */
  function helperBodies() {
    const map = new Map();
    for (const file of [...apiFiles(), 'server/src/sync/space-exchange.ts', 'server/src/sync/peer-space-admission.ts'].filter(f => existsSync(`${REPO_ROOT}/${f}`))) {
      const sf = parseSource(file, text(file));
      walkEveryNode(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name) map.set(n.name.text, `${map.get(n.name.text) ?? ''}\n${n.getText(sf)}`); });
    }
    return map;
  }

  it('the doors, derived from what they ask, number at least the push doors', () => {
    let found = 0;
    for (const file of apiFiles()) {
      const sf = parseSource(file, text(file));
      for (const b of routeBlocks(sf)) if (DOOR_ASKS.some(a => new RegExp(`\\b${a}\\(`).test(b.node.getText(sf)))) found++;
    }
    assert.ok(found >= FLOOR, `only ${found} route block(s) ask pushAllowed/refusePeerSpace/refuseHeldPeer (floor ${FLOOR}): the derivation is broken`);
  });

  it('each door reaches enterSpaceTransfer, in its block or in the helper it asks', () => {
    const helpers = helperBodies();
    /** Does `body` enter the fence itself, or call a helper that does, as far as the admission's own depth (a door, its helper, the admission, the entry)? */
    const reachesFence = (body, depth = 4) => /\benterSpaceTransfer\(/.test(body)
      || (depth > 0 && [...helpers].some(([name, helperText]) => new RegExp(`\\b${name}\\s*\\(`).test(body) && reachesFence(helperText, depth - 1)));
    const asked = new Set(DOOR_ASKS);
    const missing = [];
    for (const file of apiFiles()) {
      const sf = parseSource(file, text(file));
      for (const b of routeBlocks(sf)) {
        const block = b.node.getText(sf);
        const asks = DOOR_ASKS.filter(a => new RegExp(`\\b${a}\\(`).test(block));
        if (asks.length === 0) continue;
        const enters = reachesFence(block) || asks.some(a => reachesFence(helpers.get(a) ?? ''));
        if (!enters) missing.push(`${file}:${b.line} ${b.route}`);
      }
    }
    assert.equal(asked.size, DOOR_ASKS.length);
    assert.deepEqual(missing, [], `these inbound peer doors never enter the fence, so a wipe's drain cannot see their transfer:\n  ${missing.join('\n  ')}`);
  });

  it('every function that enters releases in a finally AND on the response close, or hands the transfer on to one that does', () => {
    const offenders = [];
    let enterers = 0;
    const sources = trackedSources(['server/src'], { untracked: true, floor: 100 }).filter(f => f !== FENCE);
    const parsedSources = sources.map(file => ({ file, sf: parseSource(file, text(file)) }));
    const releasesInFinally = (fn, sf) => { let found = false; walkEveryNode(fn ?? sf, (n) => { if (ts.isTryStatement(n) && n.finallyBlock && /\brelease\(/.test(n.finallyBlock.getText(sf))) found = true; }); return found; };
    /** The call sites of a function by name: the outermost function each is written in, and the file. */
    const callSitesOf = (name) => parsedSources.flatMap(({ file, sf }) => callsNamed(sf, name).map(call => ({ file, sf, call, fn: outermostFunctionOf(call) })));
    const handers = new Map(HANDS_ON.map(h => [h.fn, h]));

    for (const { file, sf } of parsedSources) {
      for (const call of ENTERING.flatMap(name => callsNamed(sf, name))) {
        enterers++;
        const fn = outermostFunctionOf(call);
        const body = fn ? fn.getText(sf) : '';
        const name = fn && 'name' in fn && fn.name ? fn.name.text : '';
        if (handers.has(name)) continue; // judged below, by who holds its release
        const inFinally = releasesInFinally(fn, sf);
        // Inbound doors answer a response, so a client that drops mid-request must release too; the outbound turn has no response.
        const inbound = /\bres\b/.test(body) && /\breq\b/.test(body);
        const onClose = !inbound || /\.(?:once|on)\(\s*['"]close['"]/.test(body);
        if (!inFinally || !onClose) offenders.push(`${file}:${lineOf(sf, call)} (${inFinally ? '' : 'no release in a finally'}${!inFinally && !onClose ? '; ' : ''}${onClose ? '' : "no release on the response's close"})`);
      }
    }
    assert.ok(enterers >= 1, 'no module outside the fence calls enterSpaceTransfer(: nothing is counted');

    // A function that hands the transfer (or its release) on is only as good as its callers: each call of it sits in a function that releases in a
    // finally, or in another listed hander whose own callers do.
    const holdsRelease = (name, seen = new Set()) => {
      if (seen.has(name)) return [];
      seen.add(name);
      const bad = [];
      const sites = callSitesOf(name);
      if (sites.length === 0) bad.push(`${name} is handed a transfer and nothing calls it`);
      for (const { file, sf, call, fn } of sites) {
        const caller = fn && 'name' in fn && fn.name ? fn.name.text : '';
        if (handers.has(caller)) bad.push(...holdsRelease(caller, seen));
        else if (!releasesInFinally(fn, sf)) bad.push(`${file}:${lineOf(sf, call)} calls ${name} and releases in no finally`);
      }
      return bad;
    };
    for (const h of HANDS_ON) {
      assert.ok(h.why.split(/\s+/).length >= 6, `${h.fn}: the reason is not a reason`);
      offenders.push(...holdsRelease(h.fn));
    }
    assert.deepEqual(offenders, [], `a transfer that does not release on every path leaks a count that blocks every later act's drain:\n  ${offenders.join('\n  ')}`);
  });

  it('no module but the fence keeps a count of a space\'s transfers', () => {
    const owners = new Set([FENCE]);
    const offenders = trackedSources(['server/src'], { untracked: true, floor: 100 })
      .filter(f => !owners.has(f))
      .filter(f => /\b(?:transfersRunning|transferCounts?|inFlightTransfers)\b\s*(?:=|\.set\()/.test(text(f)));
    assert.deepEqual(offenders, [], 'a second counter of transfers is a second answer to "may the act begin"');
    assert.ok(existsSync(`${REPO_ROOT}/${FENCE}`), `${FENCE} does not exist: there is no counter at all`);
  });
});
