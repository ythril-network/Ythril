/**
 * Every schema refusal answers `SchemaViolationError.toStructured()` — one body, from one place, on every door
 * (`Q-315`, R4.1, R5-3, R6-16).
 *
 * ## The finding
 *
 * A schema refusal has a documented body, `{ error: 'schema_violation', message, introduced, preExisting, violations }`,
 * and six places each said it their own way: the MCP entity and chrono tools caught the refusal themselves (the chrono
 * one dropped the message, so the same refusal read `Error: schema_violation` there and `Error: schema_violation: <the
 * sentence>` through `callTool`), a refused merge answered `{ error: <sentence>, violations }`, a bulk row carried a
 * string built from the bare reasons. Each was correct on the day it was written; together they made the answer depend
 * on which client the caller picked, which is the defect `CLAUDE.md` opens with.
 *
 * ## What is derived, never listed
 *
 * Read from the compiler's tokens of every `server/src` file (so a docblock can neither satisfy nor fail it, and a
 * sentence that merely names the body is not a body being built):
 *
 *  - **The family**: every class whose name says `SchemaViolation` (`SchemaViolationError`, `EdgeSchemaViolation`,
 *    `MergeSchemaViolation`, and the next one).
 *  - **The tag sites**: every string or template that STARTS with `schema_violation` (optionally after `Error: `).
 *  - **The branches**: every `instanceof <member of the family>`, with the branch it leads to — the `then` of the `if`
 *    it conditions, the arm of a `?:`, or the statement it sits in — and the top-level function that holds it.
 *
 * ## The rules, each a claim about ALL of them
 *
 *  1. **One body-builder.** Exactly one class of the family defines `toStructured`; the others inherit it. A second
 *     definition is a second body — the refused merge's was `{ violations }` and nothing else.
 *  2. **The tag is written in one module.** A string starting with `schema_violation` appears only in
 *     `brain/write-validation.ts`, which owns the body, and inside `itemReason` in `brain/bulk.ts` — the published
 *     `schema_violation: …` PREFIX of a bulk row's `reason`, exempt BY NAME because the row's reason is a published
 *     string and the structured half travels beside it (R5-3). Any other site (`text: 'Error: schema_violation'`, a
 *     template that interpolates it) is a hand-built body.
 *  3. **Every branch on the family answers or re-raises.** An `instanceof` of a member leads to the one mapping
 *     (`toStructured()`, `connectionRefusalAnswer`, `writeRefusalAnswer`), or re-raises (`throw`), or sits in the named
 *     bulk function. A branch that does anything else is a door answering in its own words.
 *
 * ## Seen red
 *
 * On 85c4c564: `MergeSchemaViolation extends Error` defines its own `toStructured` (rule 1), and `mcp/tools/entity.ts`
 * and `mcp/tools/chrono.ts` each build `Error: schema_violation…` by hand (rule 2). Restoring either catch after the fix
 * turns rule 2 red again; the fixture cases at the end show every rule failing on a synthetic source, so no part of the
 * product has to be put back to see it.
 *
 * Run: node --test testing/standalone/a-schema-refusal-has-one-body-on-every-door.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ts, parseSource } from '../_shared/syntax-tree.mjs';
import { readTrackedSources } from './_sources.mjs';

const BODY_OWNER = 'server/src/brain/write-validation.ts';
const BULK = 'server/src/brain/bulk.ts';
const BULK_EXEMPT_FUNCTION = 'itemReason';
const BODY_TAG = /^(?:Error(?: \(\d+\))?: )?schema_violation\b/;
const MAPPING = /\btoStructured\s*\(|\bconnectionRefusalAnswer\s*\(|\bwriteRefusalAnswer\s*\(/;

/** The name of the top-level function (or const) `node` sits in; `''` at module level. */
function holder(node) {
  let name = '';
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) name = n.name.getText();
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent?.parent?.parent ?? n)) name = n.name.text;
  }
  return name;
}

/** The `then` of the `if` that `node` conditions, else the whole statement `node` is in (a `throw x instanceof E ? … : x` is one). */
function branchOf(node) {
  for (let n = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isIfStatement(p) && p.expression === n) return p.thenStatement;
    if (ts.isStatement(p) && !ts.isBlock(p)) return p;
  }
  return node;
}

/**
 * The family, the tag sites and the branches of `files` (`[{ file, text }]`).
 *
 * @returns {{ classes: object[], tags: object[], branches: object[] }}
 */
export function analyse(files) {
  const parsed = files.map(({ file, text }) => ({ file, sf: parseSource(file, text) }));
  const classes = [];
  for (const { file, sf } of parsed) {
    (function visit(n) {
      if (ts.isClassDeclaration(n) && n.name && /SchemaViolation/.test(n.name.text)) {
        const heritage = n.heritageClauses?.flatMap(h => h.types.map(t => t.expression.getText(sf))) ?? [];
        classes.push({ name: n.name.text, file, extendsClause: heritage.join(', '),
          definesToStructured: n.members.some(m => ts.isMethodDeclaration(m) && m.name.getText(sf) === 'toStructured') });
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  const names = new Set(classes.map(c => c.name));
  const tags = [];
  const branches = [];
  for (const { file, sf } of parsed) {
    (function visit(n) {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && BODY_TAG.test(n.text)) {
        tags.push({ file, fn: holder(n), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(n.right) && names.has(n.right.text)) {
        branches.push({ file, name: n.right.text, fn: holder(n), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          branch: branchOf(n).getText(sf) });
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return { classes, tags, branches };
}

const answersOrReraises = (b) => MAPPING.test(b.branch) || /\bthrow\b/.test(b.branch);
const exempt = (s) => s.file === BULK && s.fn === BULK_EXEMPT_FUNCTION;

/** The rules, as lists of what breaks them. */
export function breaches({ classes, tags, branches }) {
  return {
    bodies: classes.filter(c => c.definesToStructured).map(c => `${c.name} (${c.file})`),
    tagsOutside: tags.filter(t => t.file !== BODY_OWNER && !exempt(t)).map(t => `${t.file}:${t.line} (${t.fn || 'module level'}) builds the body's tag by hand`),
    branchesOutside: branches.filter(b => !answersOrReraises(b) && !exempt(b))
      .map(b => `${b.file}:${b.line} (${b.fn}) \`instanceof ${b.name}\` leads to ${b.branch.replace(/\s+/g, ' ').slice(0, 100)}`),
  };
}

describe('a schema refusal has one body, built in one place', () => {
  const found = analyse(readTrackedSources('server/src', { floor: 300, untracked: true }));
  const broken = breaches(found);

  it('the derivation found the family, its tag sites and its branches (floors: a stopped match reports success about nothing)', () => {
    assert.ok(found.classes.length >= 3, `only ${found.classes.length} SchemaViolation class(es) found: ${found.classes.map(c => c.name)}`);
    assert.ok(found.classes.some(c => c.name === 'SchemaViolationError' && c.file === BODY_OWNER), 'SchemaViolationError is not defined in the body owner');
    assert.ok(found.tags.some(t => t.file === BODY_OWNER), 'the body owner writes no tag — the tag matcher has stopped matching');
    assert.ok(found.tags.some(t => t.file === BULK && t.fn === BULK_EXEMPT_FUNCTION), `${BULK_EXEMPT_FUNCTION} in bulk.ts writes no tag — the named exemption no longer names anything`);
    assert.ok(found.branches.length >= 4, `only ${found.branches.length} instanceof site(s) of the family found`);
  });

  it('exactly one class defines toStructured; the rest inherit the one body', () => {
    assert.deepEqual(broken.bodies, [`SchemaViolationError (${BODY_OWNER})`],
      'a second class of the family builds its own refusal body — a door answering it answers a different body than every other schema refusal');
  });

  it('the body\'s tag is written only by its owner, and by bulk\'s published reason prefix inside itemReason', () => {
    assert.deepEqual(broken.tagsOutside, [],
      'a door builds a schema refusal in its own words instead of answering toStructured() — the chrono tool\'s dropped the message');
  });

  it('every branch on the family answers the one mapping, or re-raises', () => {
    assert.deepEqual(broken.branchesOutside, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The rules, seen to fail on a synthetic source: nothing in the product has to be put back to see them red.

describe('the gate flags what it is meant to flag', () => {
  const run = (...files) => breaches(analyse(files.map(([file, text]) => ({ file, text }))));

  it('a second toStructured is found, and a subclass that only inherits is not one', () => {
    const owner = ['server/src/brain/write-validation.ts', 'export class SchemaViolationError extends Error { toStructured() { return {}; } }'];
    assert.deepEqual(run(owner, ['b.ts', 'export class MergeSchemaViolation extends Error { toStructured() { return { violations: [] }; } }']).bodies,
      ['SchemaViolationError (server/src/brain/write-validation.ts)', 'MergeSchemaViolation (b.ts)']);
    assert.deepEqual(run(owner, ['b.ts', 'export class MergeSchemaViolation extends SchemaViolationError { constructor() { super(1); } }']).bodies,
      ['SchemaViolationError (server/src/brain/write-validation.ts)']);
  });

  it('a hand-built tag in code is found; the same words in a comment, or in a sentence that names the body, are not', () => {
    assert.equal(run(['mcp/tools/chrono.ts', "const t = 'Error: schema_violation';"]).tagsOutside.length, 1);
    assert.equal(run(['mcp/tools/entity.ts', 'const t = `Error: schema_violation: ${m}`;']).tagsOutside.length, 1);
    assert.equal(run(['a.ts', "return { error: 'schema_violation', message };"]).tagsOutside.length, 1);
    assert.deepEqual(run(['a.ts', "// Error: schema_violation is what this used to say\nconst t = 1;"]).tagsOutside, []);
    assert.deepEqual(run(['a.ts', "const t = 'an MCP tool answers a structured `schema_violation`';"]).tagsOutside, []);
  });

  it('the tag is allowed in the body owner, and in bulk only inside itemReason', () => {
    assert.deepEqual(run(['server/src/brain/write-validation.ts', "const a = { error: 'schema_violation' };"]).tagsOutside, []);
    assert.deepEqual(run([BULK, 'function itemReason(e) { return `schema_violation: ${e}`; }']).tagsOutside, []);
    assert.equal(run([BULK, 'function other(e) { return `schema_violation: ${e}`; }']).tagsOutside.length, 1);
  });

  it('a catch that answers in its own words is found; one that calls the mapping or re-raises is not', () => {
    const own = "class SchemaViolationError extends Error {}\nfunction f(err) { if (err instanceof SchemaViolationError) { return { content: [{ text: 'bad' }] }; } throw err; }";
    assert.equal(run(['x.ts', own]).branchesOutside.length, 1, 'a catch that builds its own answer was let through');
    const mapped = "class SchemaViolationError extends Error {}\nfunction f(err) { if (err instanceof SchemaViolationError) { return { status: 422, body: err.toStructured() }; } }";
    assert.deepEqual(run(['y.ts', mapped]).branchesOutside, []);
    const reraised = "class EdgeSchemaViolation extends Error {}\nfunction g(err, i) { throw err instanceof EdgeSchemaViolation ? err.named(`edges[${i}]`) : err; }";
    assert.deepEqual(run(['z.ts', reraised]).branchesOutside, []);
  });
});
