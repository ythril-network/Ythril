/**
 * A join round is read as "open", "refused" or "not about this peer" in ONE place, `joinRoundOf` (Q-454; design v5 section 3.7, X13).
 *
 * ## What it prevents
 *
 * "Is this peer a pending joiner" was decided three ways. `spaceAllowed` asked `type === 'join' && subjectInstanceId === peer && !passed`, which
 * is TRUE for a round that was voted down or ran out of time — correct as a refusal, and a hole as soon as anyone reads the same line as an ALLOW,
 * which is what the standing question would have done (a voted-down joiner admitted to the votes of the network that refused it). The boot sweep
 * of orphaned peer credentials asked `!concluded && pendingMember`, and the revoke asked `!concluded && pendingMember.instanceId === id`: neither
 * looks at the deadline, so a round nobody concluded kept its joiner's credential for ever. Three spellings of one question, each right for its caller
 * and wrong for another's.
 *
 * ## What it holds, over the functions DERIVED from the source
 *
 * A *reader of a join round about a peer* is a function (the OUTERMOST around the access, `outermostFunctionAt`) that reads `pendingRounds` and
 * a round's `subjectInstanceId` or `pendingMember` (the list scan is the question; a function handed one round already in hand is applying it). Every reader is `joinRoundOf`
 * itself or an EXEMPT row below that says which different question it asks; an exemption must still match a reader. `joinRoundOf` must exist in
 * `networks/round-state.ts` and be called from outside its definition (floor 1: the three callers of the table in the design).
 *
 * The predicates are shown to fire on a fixture first.
 *
 * Run: node --test testing/standalone/one-reading-of-a-join-round.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { parseSource, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';
import { outermostFunctionAt } from './_source-helpers.mjs';

const READER = 'joinRoundOf';
const SUBJECT_FIELDS = ['subjectInstanceId', 'pendingMember'];

/** Readers that ask a DIFFERENT question of a join round, keyed `<file>::<function>`, each with what it asks instead. */
const EXEMPT = Object.freeze({
  'server/src/networks/member-acts.ts::admitByInviteKeyAct': 'answers the joiner polling its OWN round by the invite key it holds: the question is whose key this is, and the standing of a peer is not asked',
  'server/src/api/sync/votes.ts::GET /networks/:networkId/votes': 'serves the rounds a member may act on and strips the credential from the candidate it carries; it decides nothing about any peer',
  'server/src/util/seq.ts::resetStaleWatermarksIfNeeded': 'clears the candidate\'s own copy of the replication watermarks; it reads no peer\'s standing',
});

/** The outermost functions of one source that read a join round's subject, with the evidence: `{ key, evidence }`. */
export function readersIn(file, text) {
  const sf = parseSource(file, text);
  const per = new Map();
  const note = (node, what) => {
    const fn = outermostFunctionAt(file, text, node.getStart(sf));
    const key = `${file}::${fn?.name ?? '<module>'}`;
    (per.get(key) ?? per.set(key, new Set()).get(key)).add(what);
  };
  walkEveryNode(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && ['pendingRounds', ...SUBJECT_FIELDS].includes(n.name.text)) note(n, n.name.text);
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && ['pendingRounds', ...SUBJECT_FIELDS].includes(n.argumentExpression.text)) note(n, n.argumentExpression.text);
    if (ts.isBinaryExpression(n) && /^(?:===|!==|==|!=)$/.test(n.operatorToken.getText(sf)) && /\.type\b/.test(n.getText(sf)) && /'join'/.test(n.getText(sf))) note(n, "type === 'join'");
  });
  // A reader scans the LIST of rounds for a subject. A function handed ONE round and reading its subject (the conclusion code, the electorate)
  // is applying a round it already holds, not deciding which peers the network's rounds name; the design's wording ("any type === 'join'
  // comparison") would make every one of them an exemption, which is a site list under another name.
  return [...per].filter(([, what]) => what.has('pendingRounds') && SUBJECT_FIELDS.some(f => what.has(f)))
    .map(([key, what]) => ({ key, evidence: [...what].sort().join(', ') }));
}

describe('the predicates fire on a fixture first', () => {
  it('a function that scans the rounds for a subject is a reader; one that merely names a round is not', () => {
    const scan = 'export function isPending(net, id) { return net.pendingRounds.some(r => r.type === "join" && r.subjectInstanceId === id && !r.passed); }';
    assert.deepEqual(readersIn('server/src/x.ts', scan).map(r => r.key), ['server/src/x.ts::isPending']);
    assert.deepEqual(readersIn('server/src/x.ts', 'export function label(r) { return r.subjectLabel; }'), []);
  });
  it('the same scan inside a callback is the enclosing function\'s, and the ONE reader is not a violation', () => {
    const text = 'export function joinRoundOf(net, id) { return net.pendingRounds.filter(r => r.subjectInstanceId === id).length; }';
    assert.deepEqual(readersIn('server/src/networks/round-state.ts', text).map(r => r.key), ['server/src/networks/round-state.ts::joinRoundOf']);
  });
});

describe('a join round is read about a peer in one place', () => {
  const sources = trackedSources('server/src', { untracked: true, floor: 100 }).map(file => ({ file, text: readFileSync(file, 'utf8') }));
  const readers = sources.flatMap(s => readersIn(s.file, s.text));
  const OWN = 'server/src/networks/round-state.ts::joinRoundOf';

  it('the derivation found the readers, above the floor', () => {
    assert.ok(readers.length >= 1, 'no reader of a join round was found — the scan broke');
  });

  it('joinRoundOf exists in networks/round-state.ts, beside roundIsOpen, and is called from outside its own definition', () => {
    const state = sources.find(s => s.file === 'server/src/networks/round-state.ts');
    assert.ok(state, 'networks/round-state.ts is gone');
    assert.match(state.text, new RegExp(`export function ${READER}\\b`), `${READER} is not defined in networks/round-state.ts`);
    const callers = sources.filter(s => s.file !== 'server/src/networks/round-state.ts' && new RegExp(`\\b${READER}\\s*\\(`).test(s.text)).map(s => s.file);
    assert.ok(callers.length >= 1, `nothing calls ${READER}: the three spellings were not replaced by it`);
  });

  it('every reader of a join round about a peer is joinRoundOf or an exempt reader that asks a different question', () => {
    const stray = readers.filter(r => r.key !== OWN && !(r.key in EXEMPT)).map(r => `${r.key} (${r.evidence})`);
    assert.deepEqual(stray, [], `these decide something about a peer from the rounds list themselves: ask ${READER} (networks/round-state.ts) instead, or add an EXEMPT row naming the different question`);
  });

  it('every exemption still matches a reader, so the table cannot keep an exception for code that is gone', () => {
    const keys = new Set(readers.map(r => r.key));
    assert.deepEqual(Object.keys(EXEMPT).filter(k => !keys.has(k)), []);
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.split(/\s+/).length >= 8, `${k}: the reason is not a reason`);
  });
});
