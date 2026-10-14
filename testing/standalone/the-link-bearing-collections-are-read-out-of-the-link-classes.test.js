/**
 * `LINK_BEARING_COLLECTIONS` (the collection suffixes that hold link arrays, and the kind of record each holds) is READ OUT OF
 * `LINK_CLASSES`, and equals what `LINK_CLASSES` says.
 *
 * ## The defect it prevents
 *
 * `brain/link-adjacency.ts` writes the product fact once: a class is a `(from kind, to kind)` pair, and each from kind lives in
 * one collection. `brain/links.ts` then wrote the same fact again as a literal (`facts: 'fact', chrono: 'chrono', files: 'file'`)
 * for the sync engine and the conversion, which have only a collection name in scope. Both are correct today; the day a
 * fourth record kind can name another record, `LINK_CLASSES` gains it and the literal does not, and the sync and the
 * conversion skip the new collection's links without any error. The table's own docblock says "three and not five" - a count
 * written beside a table that is meant to follow its source.
 *
 * ## What it holds
 *
 * Two halves, because each alone is satisfiable without the other:
 *
 *  - VALUE: the exported `LINK_BEARING_COLLECTIONS` deep-equals `{ [class.collection]: class.kind }` over `LINK_CLASSES`.
 *    A literal that has drifted fails; a derivation that was written wrongly fails.
 *  - SOURCE: its declaration in `links.ts` (comments removed) mentions `LINK_CLASSES` and spells no kind or collection
 *    of its own. A literal that happens to agree today passes the value half and fails this one: that is the copy this
 *    exists to remove.
 *
 * The source half is exercised on synthetic text so a weakening of it fails here.
 *
 * Run: node --test testing/standalone/the-link-bearing-collections-are-read-out-of-the-link-classes.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom } from './_structural-window.mjs';

const LINKS = 'server/src/brain/links.ts';
const NAME = 'LINK_BEARING_COLLECTIONS';

const { LINK_CLASSES } = await import('../../server/dist/brain/link-adjacency.js');
const { LINK_BEARING_COLLECTIONS } = await import('../../server/dist/brain/links.js');

/** The expression a module assigns to `export const <NAME>`, comments removed. */
function initializerOf(source, name) {
  const code = stripComments(source);
  const at = new RegExp(`export\\s+const\\s+${name}\\b`).exec(code);
  assert.ok(at, `${LINKS} does not declare \`export const ${name}\``);
  const statement = statementFrom(code, at.index, `the declaration of ${name}`);
  const eq = statement.search(/(?<![=!<>])=(?![=>])/);
  assert.ok(eq > -1, `the declaration of ${name} has no initializer`);
  return statement.slice(eq + 1);
}

/** What is wrong with an initializer: it must read `LINK_CLASSES` and spell no record kind or collection of its own. */
function sourceProblems(initializer) {
  const problems = [];
  if (!/\bLINK_CLASSES\b/.test(initializer)) problems.push('it does not read LINK_CLASSES');
  const spelled = [...initializer.matchAll(/\b(facts|entities|edges|chrono|files)\b\s*:|['"](fact|entity|edge|chrono|file)['"]/g)].map(m => m[1] ?? m[2]);
  if (spelled.length > 0) problems.push(`it spells ${[...new Set(spelled)].join(', ')} itself`);
  return problems;
}

describe('LINK_BEARING_COLLECTIONS is read out of LINK_CLASSES', () => {
  it('finds the classes (the derivation source is not empty)', () => {
    assert.ok(LINK_CLASSES.length >= 3, 'LINK_CLASSES is nearly empty');
    assert.ok(Object.keys(LINK_BEARING_COLLECTIONS).length >= 3, 'LINK_BEARING_COLLECTIONS is nearly empty');
  });

  it('VALUE: it deep-equals { collection: kind } over LINK_CLASSES', () => {
    const derived = Object.fromEntries(LINK_CLASSES.map(c => [c.collection, c.kind]));
    assert.deepEqual({ ...LINK_BEARING_COLLECTIONS }, derived);
  });

  it('judges an initializer: a literal fails, a derivation passes, a derivation that also spells a kind fails', () => {
    const literal = sourceProblems("{ facts: 'fact', chrono: 'chrono', files: 'file' }");
    assert.equal(literal.length, 2);
    assert.equal(literal[0], 'it does not read LINK_CLASSES');
    assert.match(literal[1], /^it spells .*facts.*itself$/);
    assert.deepEqual(sourceProblems('Object.fromEntries(LINK_CLASSES.map(c => [c.collection, c.kind]))'), []);
    assert.equal(sourceProblems("Object.fromEntries(LINK_CLASSES.map(c => [c.collection, c.kind])) as Record<string, 'fact'>").length, 1);
    assert.equal(sourceProblems("{ ...Object.fromEntries(LINK_CLASSES.map(c => [c.collection, c.kind])), files: 'file' }").length, 1);
  });

  it('reads the initializer of a declaration whatever type it is annotated with', () => {
    const src = "// LINK_CLASSES in a comment\nexport const X: Record<string, RefKind | undefined> = Object.fromEntries(\n  LINK_CLASSES.map(c => [c.collection, c.kind]),\n);\nconst y = 1;\n";
    assert.deepEqual(sourceProblems(initializerOf(src, 'X')), []);
    assert.equal(sourceProblems(initializerOf(src.replace('LINK_CLASSES.map', 'OTHER.map'), 'X')).length, 1);
  });

  it('SOURCE: its declaration reads LINK_CLASSES and spells no kind or collection of its own', () => {
    const problems = sourceProblems(initializerOf(readFileSync(LINKS, 'utf8'), NAME));
    assert.deepEqual(problems, [], `${LINKS}: ${NAME} is a second copy of what LINK_CLASSES says: ${problems.join('; ')}`);
  });
});
