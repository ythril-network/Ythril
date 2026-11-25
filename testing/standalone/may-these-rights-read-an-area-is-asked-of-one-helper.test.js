/**
 * "May these rights read area X of space S?" is asked of ONE function, `mayReadArea` (`server/src/auth/reachable-spaces.ts`; Q-748,
 * bundle-269 lens sweep, finding 9).
 *
 * ## The defect it prevents
 *
 * The question was written longhand four times (the exports' file triples, the stored values a check reads, the facts a type's history reads
 * from records, the spaces a refusal may name), two of them by bundle-269: an instance administrator's short cut (`rights.instanceAdmin`)
 * beside `holdsRung(rights, space, area, 'read')`. Each copy has its own place for the short cut and its own guard for rights that do not
 * exist; a copy that dropped the short cut refuses an administrator, one that dropped the guard throws for a call with no rights, and a
 * fifth would be the next to drift.
 *
 * ## What it holds
 *
 * No server source but the helper's own (comments never read: the tree is parsed) calls `holdsRung(..., 'read')` in a function that also
 * reads `.instanceAdmin`: that pair is the question, and `mayReadArea` is its answer. A function that reads `.instanceAdmin` for another
 * question (a write, an admin act) is not this question and is not flagged; one that asks the rung `read` without the short cut asks the
 * matrix alone and is not either.
 *
 * ## Seen red
 *
 * On the four copies, before they were replaced. The scan is proven on a planted copy: the helper's own text read under another file name,
 * which it flags, and under its own, which it passes.
 *
 * Run: node --test testing/standalone/may-these-rights-read-an-area-is-asked-of-one-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources, SERVER_SOURCE_ROOT } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

/** The one place the question is answered. */
const HOME = 'server/src/auth/reachable-spaces.ts';

/** The nearest function-like node around `node`, or the file. */
function functionAround(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
}

/** `file:line` of each `holdsRung(..., 'read')` call in `text` whose function also reads `.instanceAdmin`: a longhand copy of the question. */
function copiesIn(file, text) {
  if (file === HOME) return [];
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'holdsRung') return;
    const rung = n.arguments[3];
    if (!rung || !ts.isStringLiteralLike(rung) || rung.text !== 'read') return;
    const scope = functionAround(n) ?? sf;
    let admin = false;
    walkEveryNode(scope, (m) => { if (ts.isPropertyAccessExpression(m) && m.name.text === 'instanceAdmin') admin = true; });
    if (admin) out.push(`${file}:${lineOf(sf, n)}`);
  });
  return out;
}

describe('the question "may these rights read an area of a space" has one asker', () => {
  const sources = readTrackedSources([SERVER_SOURCE_ROOT], { untracked: true });

  it('reads a tree worth reading, and the helper exists in its home', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} server sources were read`);
    const home = sources.find(s => s.file === HOME);
    assert.ok(home, `${HOME} is not among the sources`);
    assert.match(home.text, /export function mayReadArea\(/, 'the helper is not exported from its home');
  });

  it('no server source writes the question longhand', () => {
    const copies = sources.flatMap(s => copiesIn(s.file, s.text));
    assert.deepEqual(copies, [], `the question is written longhand: ask mayReadArea (${HOME}) instead:\n  ${copies.join('\n  ')}`);
  });

  it('the helper is asked: every place that told a caller what a space holds reads through it', () => {
    // The RDF export asks it through the member helper it shares with the quad source (bundle-271, Q-756).
    for (const file of ['server/src/rdf/rdf-members.ts', 'server/src/spaces/rdf-settle.ts', 'server/src/spaces/schema-validate-door.ts', 'server/src/spaces/schema-type-acts.ts']) {
      const s = sources.find(x => x.file === file);
      assert.ok(s, `${file} is not among the sources`);
      assert.match(s.text, /\bmayReadArea\(/, `${file} no longer asks mayReadArea`);
    }
  });

  it('flags the helper\'s own text read under another name, and passes it under its own', () => {
    const home = sources.find(s => s.file === HOME);
    assert.deepEqual(copiesIn(HOME, home.text), [], 'the helper flagged itself');
    const planted = copiesIn('server/src/planted-copy.ts', home.text);
    assert.equal(planted.length, 1, `the scan does not see a copy of the helper (${JSON.stringify(planted)})`);
  });
});
