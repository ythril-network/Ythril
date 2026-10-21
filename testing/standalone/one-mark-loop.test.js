/**
 * One loop over a network's member marks, and it visits every member the config holds (bundle-157 plan rev 2 and rev 5 R5.2).
 *
 * ## The defect this holds
 *
 * A network member carries six `spaceId -> position` maps (`PER_SPACE_WATERMARKS`). Forgetting them for a space (a wipe, a leave, now a
 * restore) and carrying them to a new id (a rename) is ONE loop, `eachMemberMarkOf` in `sync/receive-marks.ts`. A second loop over the same
 * maps is the defect this repo produces most: `resetStaleWatermarksIfNeeded` (`util/seq.ts`) walks the list itself and visits
 * `pendingRounds[].pendingMember` by hand, which the shared loop does not, so a wipe forgets every member's marks and leaves the ones a
 * join round in flight carries. A mark that is kept there is read as a position in numbers about to be reused.
 *
 * ## What it holds
 *
 * 1. **The gate.** Every function the server program contains that WALKS THE MARK SET - a loop that reads `PER_SPACE_WATERMARKS` (or a
 *    constant that is it), or indexes something by a key whose type is the union of the mark names - goes through `eachMemberMarkOf`. The
 *    subjects are derived from the type-checked program, not listed. A reader of ONE named mark (a retention floor, a count of re-reads
 *    owed) asks a different question and is not a subject: it does not walk the set.
 * 2. **The loop reaches the pending member.** `eachMemberMarkOf` visits `pendingRounds[].pendingMember` as well as `members`. Driven through
 *    the exported callers that forget and carry (`forgetEveryMark` / `moveEveryMark`, which the design renames from `forgetReceiveMarks` /
 *    `moveReceiveMarks`; the old names are read when the new ones do not exist yet), and directly when `eachMemberMarkOf` is exported.
 *
 * ## Red today
 *
 * Row 1 names `resetStaleWatermarksIfNeeded` in `server/src/util/seq.ts`; row 2 finds the pending member's marks left in place.
 *
 * ## Floors, and the gate seen red
 *
 * The subjects found must include the helper itself (a scan that cannot see the helper sees nothing) and the list's length is at least four.
 * Seen red, then put back by hand: (a) `resetStaleWatermarksIfNeeded` today; (b) a scratch copy of the reset's loop in a held-out source.
 *
 * Run: node --test testing/standalone/one-mark-loop.test.js (a prior `npx tsc -p server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { serverProgram } from '../_shared/server-program.mjs';

const { PER_SPACE_WATERMARKS } = await import('../../server/dist/config/types-networks.js');
const receiveMarks = await import('../../server/dist/sync/receive-marks.js');

const HELPER = 'eachMemberMarkOf';
const LOOP_METHODS = new Set(['forEach', 'map', 'some', 'every', 'filter', 'flatMap', 'reduce', 'find', 'findIndex']);

const isLoop = (n) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)
  || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && LOOP_METHODS.has(n.expression.name.text));

/** The outermost function-like that has a NAME (a declaration, a method, or a variable holding an arrow), or the file when there is none. */
function subjectFunctionOf(node) {
  let name = null; let at = node;
  for (let n = node; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) { name = n.name.getText(); at = n; }
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) { name = n.parent.name.text; at = n.parent; }
  }
  return { name, at };
}

/** Is this identifier `PER_SPACE_WATERMARKS` or a constant initialised to it, however many aliases deep? */
function namesTheMarkList(checker, ident) {
  let sym = checker.getSymbolAtLocation(ident);
  for (let depth = 0; sym && depth < 6; depth++) {
    if (sym.getName() === 'PER_SPACE_WATERMARKS') return true;
    const aliased = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    if (aliased.getName() === 'PER_SPACE_WATERMARKS') return true;
    const decl = aliased.valueDeclaration;
    const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    if (!init || !ts.isIdentifier(init)) return false;
    sym = checker.getSymbolAtLocation(init);
  }
  return false;
}

/** Is this the type of a key that can be ANY of the marks: a union of at least two string literals, all of them mark names? */
function isMarkKeyType(checker, expr) {
  const t = checker.getTypeAtLocation(expr);
  const parts = t.isUnion() ? t.types : [t];
  return parts.length >= 2 && parts.every(p => p.isStringLiteral() && PER_SPACE_WATERMARKS.includes(p.value));
}

/** Every function that walks the mark set inside a loop: `{ file, name, line, callsHelper }`. */
function markWalkers() {
  const { checker, serverSources, repoPath } = serverProgram();
  const found = new Map();
  for (const sf of serverSources()) {
    const visitInLoop = (loop) => {
      const hits = [];
      const walk = (n) => {
        if (ts.isIdentifier(n) && namesTheMarkList(checker, n) && !ts.isVariableDeclaration(n.parent)) hits.push(n);
        else if (ts.isElementAccessExpression(n) && isMarkKeyType(checker, n.argumentExpression)) hits.push(n);
        ts.forEachChild(n, walk);
      };
      walk(loop);
      return hits;
    };
    const scan = (n) => {
      if (isLoop(n)) {
        for (const hit of visitInLoop(n)) {
          const { name, at } = subjectFunctionOf(hit);
          const key = `${repoPath(sf.fileName)}#${name ?? '(module level)'}`;
          if (found.has(key)) continue;
          let callsHelper = false;
          const look = (m) => { if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === HELPER) callsHelper = true; ts.forEachChild(m, look); };
          look(at);
          found.set(key, { file: repoPath(sf.fileName), name: name ?? '(module level)', line: sf.getLineAndCharacterOfPosition(hit.getStart(sf)).line + 1, callsHelper });
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
  }
  return [...found.values()];
}

describe('one loop over the member marks', () => {
  it('every function that walks the mark set goes through eachMemberMarkOf', () => {
    assert.ok(PER_SPACE_WATERMARKS.length >= 4, 'PER_SPACE_WATERMARKS read as empty: the gate would conclude about nothing');
    const walkers = markWalkers();
    const helper = walkers.find(w => w.name === HELPER && w.file === 'server/src/sync/receive-marks.ts');
    assert.ok(helper, `the scan cannot see ${HELPER} itself walking PER_SPACE_WATERMARKS in sync/receive-marks.ts: it reads nothing (found: ${walkers.map(w => `${w.file}#${w.name}`)})`);
    const second = walkers.filter(w => w.name !== HELPER && !w.callsHelper);
    assert.deepEqual(second.map(w => `${w.file}:${w.line} ${w.name}`), [],
      'these functions walk the member marks in a loop of their own instead of through eachMemberMarkOf - a second loop is a second set of members to miss (pendingMember)');
  });
});

describe('the loop visits every member the config holds', () => {
  const forget = receiveMarks.forgetEveryMark ?? receiveMarks.forgetReceiveMarks;
  const move = receiveMarks.moveEveryMark ?? receiveMarks.moveReceiveMarks;
  const marked = (instanceId) => ({
    instanceId,
    lastSeqReceived: { s: 5, other: 1 }, lastSeqPushed: { s: 7, other: 1 }, lastSeqServed: { s: 6, other: 1 },
    lastFileTombstoneAckedAt: { s: '2026-01-01T00:00:00.000Z', other: 'x' }, tombstoneRereadAt: { s: 'done', other: 'done' },
    fileMetaRereadAt: { s: 'done', other: 'done' },
  });
  const netWith = () => ({ id: 'n', spaces: ['s'], members: [marked('member-1')], pendingRounds: [{ roundId: 'r1', pendingMember: marked('pending-1') }] });

  it('forgetting a space\'s marks reaches a member a join round in flight carries, as it reaches the members', () => {
    assert.equal(typeof forget, 'function', 'sync/receive-marks exports neither forgetEveryMark nor forgetReceiveMarks');
    const net = netWith();
    forget(net, 's');
    for (const [who, member] of [['member-1', net.members[0]], ['pending-1', net.pendingRounds[0].pendingMember]]) {
      const left = PER_SPACE_WATERMARKS.filter(k => member[k]?.['s'] !== undefined);
      assert.deepEqual(left, [], `${who} still holds marks for the forgotten space: ${left}`);
      const other = PER_SPACE_WATERMARKS.filter(k => member[k]?.['other'] === undefined);
      assert.deepEqual(other, [], `${who} lost the marks of ANOTHER space: ${other}`);
    }
  });

  it('carrying a space\'s marks to a new id reaches the pending member too', () => {
    assert.equal(typeof move, 'function', 'sync/receive-marks exports neither moveEveryMark nor moveReceiveMarks');
    const net = netWith();
    move(net, 's', 't');
    for (const [who, member] of [['member-1', net.members[0]], ['pending-1', net.pendingRounds[0].pendingMember]]) {
      const unmoved = PER_SPACE_WATERMARKS.filter(k => member[k]?.['t'] === undefined || member[k]?.['s'] !== undefined);
      assert.deepEqual(unmoved, [], `${who} still carries marks under the old id, or none under the new one: ${unmoved}`);
    }
  });

  it('eachMemberMarkOf hands out the maps of the members AND of the pending member', () => {
    // Exported since the one-loop change (8c12003d); a missing export is a failure here, never a skip.
    assert.equal(typeof receiveMarks[HELPER], 'function', `sync/receive-marks exports no ${HELPER}`);
    const net = netWith();
    const seen = new Set();
    receiveMarks[HELPER](net, 's', (marks) => { seen.add(marks); });
    const pending = net.pendingRounds[0].pendingMember;
    assert.ok(PER_SPACE_WATERMARKS.every(k => seen.has(pending[k])), 'the pending member\'s maps were not visited');
    assert.ok(PER_SPACE_WATERMARKS.every(k => seen.has(net.members[0][k])), 'the members\' maps were not visited');
  });
});
