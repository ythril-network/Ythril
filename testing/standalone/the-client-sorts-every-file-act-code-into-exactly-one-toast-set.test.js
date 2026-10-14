/**
 * The Files page sorts every code a file act answers into exactly one of its two toast sets: a REMEDY (the toast stays until
 * dismissed, because it tells the operator what to do) or a FACT (the toast states what happened and expires).
 *
 * ## The defect it prevents
 *
 * The page keeps ONE set, `FILE_REFUSALS_WITH_REMEDY`, and everything not in it is shown as a fact that expires. A code
 * the server starts answering is therefore not "unhandled" on the client, it is silently classified as a fact: if its
 * sentence is an instruction, the toast takes the instruction with it after a few seconds and a screen reader's user may
 * never have reached it. Nothing fails, because "not in the set" is a valid answer. The second set makes the choice a
 * decision a reader can see: a code is either named in the remedy set or named in the fact set, and a code in neither
 * is one nobody decided.
 *
 * ## What it holds
 *
 * The server's codes are DERIVED from `files/act-answers.ts` (its `code: '<x>'` literals, comments removed). The client's two
 * sets are read from the source of `file-listing.store.ts` BY PATH (the client cannot be imported into a standalone test, and
 * a standalone test cannot import what the client imports): `FILE_REFUSALS_WITH_REMEDY` and `FILE_REFUSALS_THAT_STATE_A_FACT`,
 * each a `new Set([...])` of string literals or of module constants that hold one. Then, over the whole set of server codes:
 *
 *  - every code is in exactly one of the two sets (a code in neither is undecided; one in both is decided twice);
 *  - neither set names a code the server does not answer (a code that was retired and still decides a toast).
 *
 * The client spec `file-act-answers.spec.ts` already derives the same server codes and holds that every one has a sentence in
 * every locale; this holds what it does not: which of the two kinds of toast each is.
 *
 * Run: node --test testing/standalone/the-client-sorts-every-file-act-code-into-exactly-one-toast-set.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { between } from './_structural-window.mjs';

const ANSWERS = 'server/src/files/act-answers.ts';
const STORE = 'client/src/app/pages/files/file-listing.store.ts';
const REMEDY = 'FILE_REFUSALS_WITH_REMEDY';
const FACT = 'FILE_REFUSALS_THAT_STATE_A_FACT';

/** The codes a module spells in its answers. */
const serverCodes = (src) => [...new Set([...stripComments(src).matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))].sort();

/**
 * The members of `export const <name>: ReadonlySet<string> = new Set([ ... ])`, each a string literal or a module `const` that
 * holds one. A member this cannot resolve THROWS: dropping it would make the set smaller than it is and the gate quieter.
 */
function setMembers(src, name) {
  const code = stripComments(src);
  const declaration = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*new\\s+Set\\(\\s*\\[`).exec(code);
  assert.ok(declaration, `${STORE} does not declare \`export const ${name}: ReadonlySet<string> = new Set([...])\``);
  const list = between(code.slice(declaration.index + declaration[0].length - 1), '[', ']', `the members of ${name}`);
  return list.split(',').map(t => t.trim()).filter(Boolean).map(token => {
    const literal = /^'([^']*)'$|^"([^"]*)"$/.exec(token);
    if (literal) return literal[1] ?? literal[2];
    const constant = new RegExp(`\\bconst\\s+${token}\\s*(?::[^=]+)?=\\s*['"]([^'"]*)['"]`).exec(code);
    assert.ok(constant, `${name} has a member \`${token}\` that is neither a string literal nor a module constant holding one`);
    return constant[1];
  }).sort();
}

/** What is wrong with the two sets against the server's codes, as sentences. */
function problems(server, remedy, fact) {
  return [
    ...server.filter(c => !remedy.includes(c) && !fact.includes(c)).map(c => `${c} is in neither ${REMEDY} nor ${FACT}`),
    ...server.filter(c => remedy.includes(c) && fact.includes(c)).map(c => `${c} is in both ${REMEDY} and ${FACT}`),
    ...[...remedy, ...fact].filter((c, i, all) => !server.includes(c) && all.indexOf(c) === i).map(c => `${c} is in a client set and is not a code the server answers`),
  ];
}

describe('the client sorts every file act code into exactly one toast set', () => {
  const server = serverCodes(readFileSync(ANSWERS, 'utf8'));
  const store = readFileSync(STORE, 'utf8');

  it('finds the server codes and the remedy set (the reads themselves still work)', () => {
    assert.ok(server.length >= 8, `only ${server.length} codes read from ${ANSWERS}`);
    assert.ok(setMembers(store, REMEDY).length >= 4, `${REMEDY} was read as nearly empty`);
  });

  it('reads a set whose members are literals and constants, and refuses one it cannot resolve', () => {
    const src = "const HELD = 'held_one';\nexport const S: ReadonlySet<string> = new Set([\n  'a_b', \"c_d\", HELD, // note\n]);";
    assert.deepEqual(setMembers(src, 'S'), ['a_b', 'c_d', 'held_one']);
    assert.throws(() => setMembers(src.replace("const HELD = 'held_one';", ''), 'S'), /HELD/);
  });

  it('judges a code in neither set, in both, or in a set but not answered by the server', () => {
    assert.deepEqual(problems(['x', 'y'], ['x'], ['y']), []);
    assert.deepEqual(problems(['x', 'y'], ['x'], []), [`y is in neither ${REMEDY} nor ${FACT}`]);
    assert.deepEqual(problems(['x', 'y'], ['x', 'y'], ['y']), [`y is in both ${REMEDY} and ${FACT}`]);
    assert.deepEqual(problems(['x'], ['x'], ['gone']), ['gone is in a client set and is not a code the server answers']);
  });

  it(`every code the server answers is in exactly one of ${REMEDY} and ${FACT}, and the sets name no other`, () => {
    const found = problems(server, setMembers(store, REMEDY), setMembers(store, FACT));
    assert.deepEqual(found, [], found.join('\n'));
  });
});
