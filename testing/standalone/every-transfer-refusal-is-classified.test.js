/**
 * Every place a transfer reads a peer's refusal of a SPACE asks one classifier what the refusal means (bundle-106, §3.3 v4 (1) and v5 (1), W9, X10, X18, P-48).
 *
 * ## The rule
 *
 * A peer that holds a space answers `423` (`space_held`, `space_declined`); a sender that counts every non-2xx as a failed transfer turns
 * that into a failed cycle for the WHOLE member, then `PEER UNREACHABLE` after `STALE_FAILURE_THRESHOLD` of them, for a space that is
 * merely held. ONE function, `transferRefusal(resp)` in `sync/held-answer.ts`, says `'held' | 'declined' | 'failed'`, and every
 * `peerSafeFetch` a sync module makes to a space-scoped route reads its non-2xx branch through it.
 *
 * ## How the subjects are found (a rule, never a list)
 *
 * Read out of the code: every `peerSafeFetch(` call under `server/src/sync/` whose URL (the argument, or the declaration of the identifier
 * it names inside the same function) names a space-scoped `/api/sync/` route or the peer file door `/api/files/`. The routes that name a
 * NETWORK (`/api/sync/networks/...`, the warm-up) are governance, not a space transfer, and are not subjects. The design's first version
 * said "six" sites and P-48 found eleven; no number is written here but the floor, which is what P-48's list is, and which only the
 * derivation may raise.
 *
 * For each subject: every branch of its enclosing function that reads the response's `ok` or `status` calls `transferRefusal(`; a call
 * whose response is never read into a variable (a `.then`) makes the whole function the branch. Comments are not code: the walk is over the
 * syntax tree, so a sentence naming `transferRefusal(` in a docblock proves nothing.
 *
 * ## Seen red (by hand, each restored by hand)
 *
 * At a638e702 the classifier does not exist, so the first case fails and every subject fails its branch check. After the fix: delete the
 * `transferRefusal(` call at one non-2xx branch (the file-tombstone pull, `file-sync.ts`, is the one a six-site list forgot) -> that
 * subject names itself; add a scratch `peerSafeFetch(`${member.url}/api/sync/docs?...`)` with a bare `!r.ok` to `sync/pull-family.ts` ->
 * a new subject, red.
 *
 * Run: node --test testing/standalone/every-transfer-refusal-is-classified.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { parseSource, walkEveryNode, outermostFunctionOf, lineOf, ts } from '../_shared/syntax-tree.mjs';

/** The design's P-48 found this many (and the six-site list it corrected was wrong): the floor is a lower bound the derivation may only exceed. */
const SUBJECT_FLOOR = 11;

const HELD_ANSWER = 'server/src/sync/held-answer.ts';
const SPACE_SCOPED = /\/api\/(?:sync\/(?!networks\/|warm\b|notify\b)|files\/)/;

/** The text a call's URL resolves to: the first argument, or — when it is an identifier — the initializer it is declared with in the same function. */
function urlTextOf(call, fn, sf) {
  const arg = call.arguments[0];
  if (!arg) return '';
  if (!ts.isIdentifier(arg) || !fn) return arg.getText(sf);
  let found = '';
  walkEveryNode(fn, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text && n.initializer) found = n.initializer.getText(sf);
  });
  return found || arg.getText(sf);
}

/** The name the call's response is bound to (`const resp = await peerSafeFetch(...)`), or null when it is chained or discarded. */
function responseNameOf(call) {
  let n = call.parent;
  while (n && (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n))) n = n.parent;
  return n && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : null;
}

function subjects() {
  const files = trackedSources(['server/src/sync'], { untracked: true, floor: 20 });
  const out = [];
  for (const file of files) {
    const sf = parseSource(file, readFileSync(`${REPO_ROOT}/${file}`, 'utf8'));
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'peerSafeFetch') return;
      const fn = outermostFunctionOf(n);
      const url = urlTextOf(n, fn, sf);
      if (!SPACE_SCOPED.test(url)) return;
      out.push({ file, line: lineOf(sf, n), sf, call: n, fn, resp: responseNameOf(n), url });
    });
  }
  return out;
}

/** The `if` statements in `fn` whose condition reads `<resp>.ok` or `<resp>.status`: the non-2xx branches of this call. */
function branchesOf(subject) {
  const { fn, resp, sf } = subject;
  const found = [];
  if (!fn || !resp) return found;
  const reads = new RegExp(`\\b${resp}\\.(?:ok|status)\\b`);
  walkEveryNode(fn, (n) => {
    if (ts.isIfStatement(n) && reads.test(n.expression.getText(sf))) found.push(n);
  });
  return found;
}

const callsClassifier = (node, sf) => /\btransferRefusal\(/.test(node.getText(sf));

describe('every non-2xx a space transfer reads is classified by one function', () => {
  it('the classifier exists, in the module the design names, and is exported', () => {
    assert.ok(existsSync(`${REPO_ROOT}/${HELD_ANSWER}`),
      `${HELD_ANSWER} does not exist: the one classifier of a peer's 423 (held, declined, failed) is not written, so every transfer counts a held space as a failed transfer`);
    assert.match(readFileSync(`${REPO_ROOT}/${HELD_ANSWER}`, 'utf8'), /export\s+function\s+transferRefusal\(/, 'transferRefusal is not exported from sync/held-answer.ts');
  });

  it('the derivation found the space-scoped fetch sites, at or above the floor', () => {
    const found = subjects();
    assert.ok(found.length >= SUBJECT_FLOOR,
      `only ${found.length} peerSafeFetch call(s) to a space-scoped route were found (floor ${SUBJECT_FLOOR}): the derivation is broken, and an empty set passes every loop below. Found: ${found.map(s => `${s.file}:${s.line}`).join(', ')}`);
  });

  it('every subject reads its refusal through transferRefusal', () => {
    const found = subjects();
    const bare = [];
    for (const s of found) {
      const branches = branchesOf(s);
      const ok = s.resp === null || branches.length === 0
        // A call with no response variable, or one never branched on by name, is classified when its function classifies at all after the call.
        ? !!s.fn && /\btransferRefusal\(/.test(s.fn.getText(s.sf).slice(s.call.getStart(s.sf) - s.fn.getStart(s.sf)))
        : branches.every(b => callsClassifier(b, s.sf));
      if (!ok) bare.push(`${s.file}:${s.line} (${s.url.replace(/\s+/g, ' ').slice(0, 70)})`);
    }
    assert.deepEqual(bare, [],
      'these space-scoped transfers read a peer refusal without asking transferRefusal(resp), so a 423 space_held counts as a failed transfer for the whole member:\n  '
      + bare.join('\n  '));
  });
});

/*
 * Q-624 (design rev 4 section 5.4, re-anchor table): a peer building its edge identity index answers a push of the edges family with
 * `503 { code: 'edge_identity_building', retryable: true }`. That is neither a held space nor a failed transfer: it holds ONE family, so the turn and every
 * other family go on, and nothing counts as a member failure. The classifier says it with a fourth word, `'family-held'`, and the push family does not hand
 * that word to the turn (`refusedBy` would end the whole space's exchange, which is what `PositionsBuilding` did and the design refuses to reuse).
 */
describe('a peer that holds one family is classified, and does not end the space\'s turn', () => {
  const answer = (status, body) => ({ status, clone: () => ({ text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) });

  it('transferRefusal reads 503 edge_identity_building as family-held, and every other 503 as before', async () => {
    const errors = await import('../../server/dist/util/errors.js');
    assert.equal(errors.EDGE_IDENTITY_BUILDING, 'edge_identity_building', 'util/errors.ts does not export EDGE_IDENTITY_BUILDING');
    const { transferRefusal } = await import('../../server/dist/sync/held-answer.js');
    assert.equal(await transferRefusal(answer(503, { error: 'x', code: errors.EDGE_IDENTITY_BUILDING, retryable: true })), 'family-held');
    assert.equal(await transferRefusal(answer(503, { error: 'x' })), 'failed', 'a bare 503 stays a failure');
    assert.equal(await transferRefusal(answer(503, { error: 'x', code: 'something_else' })), 'failed');
    assert.equal(await transferRefusal(answer(503, { error: 'x', code: errors.POSITIONS_BUILDING })), 'held', 'the space-wide hold is unchanged');
  });

  it('TransferRefusal names family-held, and the push of a family does not hand it to the turn', () => {
    const answerSrc = readFileSync(`${REPO_ROOT}/${HELD_ANSWER}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const union = answerSrc.match(/export type TransferRefusal\s*=([^;]*);/);
    assert.ok(union, 'TransferRefusal is not declared in sync/held-answer.ts');
    assert.ok([...union[1].matchAll(/'([\w-]+)'/g)].map(m => m[1]).includes('family-held'), 'TransferRefusal does not name family-held');
    // The one consumer that hands a verdict to the turn for a family's push: `push-family.ts`. Its non-2xx branch must name the word, so it is a decision there.
    const push = readFileSync(`${REPO_ROOT}/server/src/sync/push-family.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const at = push.indexOf('await transferRefusal(resp)');
    assert.ok(at > -1, 'push-family.ts no longer classifies a refusal of its push');
    const branch = push.slice(at, push.indexOf('return `the peer answered', at));
    assert.ok(/'family-held'/.test(branch), 'push-family.ts does not decide what a family-held refusal does: handed to refusedBy it ends the whole space\'s turn for this member');
  });
});
