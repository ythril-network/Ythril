/**
 * "The other edges at (from, label)" has ONE definition, and every counting site calls it (`Q-439`).
 *
 * ## The rule
 *
 * A functional label allows a subject at most one edge. "How many OTHER edges does this subject have under the label" was
 * answered three times, three ways: `write-plan/read-set.ts` (a NUL-joined key, counting distinct `to`), `spaces/validate-
 * stored-edges.ts` (a length-prefixed key, counting every row) and `brain/merge.ts` (a key prefixed on the subject only,
 * counting distinct `to`). They agreed while one id lived in one kind. They disagree on a second edge to the same `to` in
 * another kind, and the planner and the store must agree on "another edge" or a loser of a race is refused twice and
 * answered 409. The marker the guard index collides on IS that key.
 *
 * So one module (`brain/functional-subject.ts`) answers it: `functionalSubjectKey(from, label)`, a key no pair of distinct
 * inputs can share, and `otherEdgesAtSubject(stored, edge)`, how many of the stored edges at the edge's subject differ from it
 * IN IDENTITY (`to`, `fromKind`, `toKind`). The guard that is easy to drop is inside: a non-string input THROWS, because a
 * key built from `undefined` is the string `"undefined"` and counts every edge of a missing subject as one subject.
 *
 * ## Names this test chose
 *
 * The plan fixes the module's question, not its names: `functional-subject.ts`, `functionalSubjectKey` and
 * `otherEdgesAtSubject(stored, edge)` (`stored`: any iterable of `{from, to, label, fromKind?, toKind?}`, the edges already
 * held, those at other subjects ignored) are this test's.
 *
 * ## What is derived
 *
 * The counting sites are every `server/src` file that keeps a per-subject structure (`subjectKey`, `subjectCounts`,
 * `subjectEdges`). Each must import the module and define no key of its own. Floor: three.
 *
 * ## Seen red
 *
 * Red on 9a4b41c6: the module does not exist, and the three sites each define their own key. Mutation: put a
 * `const subjectKey = ...` back into `read-set.ts` (red: a local definition).
 *
 * Run: node --test testing/standalone/the-subject-count-has-one-definition.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const MODULE_SRC = 'server/src/brain/functional-subject.ts';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/brain/functional-subject.js', import.meta.url); });
const api = () => needModule(loaded, ['functionalSubjectKey', 'otherEdgesAtSubject'], 'the subject count');

const edge = (to, extra = {}) => ({ from: 'subject', label: 'reports_to', to, ...extra });

describe('the subject key', () => {
  it('is injective: pairs that a plain join would merge are two subjects', () => {
    const { functionalSubjectKey: key } = api();
    assert.notEqual(key('a:b', 'c'), key('a', 'b:c'));
    assert.notEqual(key('a', 'bc'), key('ab', 'c'));
    assert.notEqual(key('a\u0000b', 'c'), key('a', 'b\u0000c'));
    assert.equal(key('subject', 'reports_to'), key('subject', 'reports_to'));
    assert.equal(typeof key('subject', 'reports_to'), 'string');
  });

  it('throws on a non-string input rather than keying "undefined"', () => {
    const { functionalSubjectKey: key } = api();
    for (const bad of [[undefined, 'l'], ['f', undefined], [null, 'l'], [42, 'l'], ['f', {}]]) {
      assert.throws(() => key(...bad), undefined, `functionalSubjectKey(${bad.map(String).join(', ')}) did not throw`);
    }
  });
});

describe('"the other edges at (from, label)" — the truth table', () => {
  it('the edge itself (the same identity) is not its own duplicate', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('boss')], edge('boss')), 0);
  });

  it('an edge with a different `to` counts', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('boss')], edge('other-boss')), 1);
    assert.equal(others([edge('boss'), edge('other-boss')], edge('third')), 2);
  });

  it('the same `to` in a different `toKind` is another edge and counts', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('x', { toKind: 'fact' })], edge('x')), 1);
    assert.equal(others([edge('x')], edge('x', { toKind: 'fact' })), 1);
  });

  it('the same `to` in a different `fromKind` is another edge and counts', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('x', { fromKind: 'chrono' })], edge('x')), 1);
  });

  it('an end stated as `entity` and one left unstated are one identity, so neither counts', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('x', { toKind: 'entity' })], edge('x')), 0);
    assert.equal(others([edge('x')], edge('x', { fromKind: 'entity', toKind: 'entity' })), 0);
  });

  it('edges at another subject or under another label are not at this subject', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([{ ...edge('boss'), from: 'someone-else' }, { ...edge('boss'), label: 'knows' }], edge('new-boss')), 0);
  });

  it('a stored identity held twice (stored and planned) is counted once', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.equal(others([edge('boss'), edge('boss')], edge('other')), 1);
  });

  it('throws on a non-string input', () => {
    const { otherEdgesAtSubject: others } = api();
    assert.throws(() => others([edge('boss')], { from: undefined, label: 'reports_to', to: 'x' }));
    assert.throws(() => others([edge('boss')], { from: 'subject', label: 7, to: 'x' }));
    assert.throws(() => others([{ from: 'subject', label: 'reports_to', to: undefined }], edge('x')));
  });
});

describe('every counting site calls the one module', () => {
  const sources = trackedSources('server/src', { untracked: true })
    .filter(f => f !== MODULE_SRC)
    .map(file => ({ file, src: stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')) }));
  const sites = sources.filter(({ src }) => /\bsubject(?:Key|Counts|Edges)\b/.test(src));

  it('the counting sites are found (floor: read-set, validate-stored-edges, merge)', () => {
    assert.ok(sites.length >= 3, `only ${sites.length} counting site(s) found: ${sites.map(s => s.file).join(', ')}`);
  });

  it('each imports functional-subject and defines no subject key of its own', () => {
    const offenders = [];
    for (const { file, src } of sites) {
      if (!/from\s+'[^']*\bfunctional-subject\.js'/.test(src)) {
        offenders.push(`${file}: does not import functional-subject`);
      }
      if (/\b(?:const|let|function)\s+subjectKey\b/.test(src)) offenders.push(`${file}: defines its own subjectKey`);
      if (/\$\{[^}]*\.length\}:\$\{/.test(src)) offenders.push(`${file}: builds a length-prefixed key by hand`);
    }
    assert.deepEqual(offenders, []);
  });
});
