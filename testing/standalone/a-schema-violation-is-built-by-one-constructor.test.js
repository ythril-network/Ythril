/**
 * A schema violation row is built by one constructor, which takes its code (`schemaViolation` in `spaces/schema-violation-codes.ts`,
 * Q-943): no other file of the server writes a `{ field, reason }` row by hand.
 *
 * ## The finding
 *
 * A violation was an object literal written wherever one was raised: fifteen sites in the validator, the rules engine, the link
 * take-back warning, the dangling-end refusal and the conversion's failure row, each spelling its prose inline. Giving every row a code
 * and its parameters is only true while every row is built through the one function that requires them; the next site written by hand
 * is the one whose chip a screen cannot word.
 *
 * ## What is derived
 *
 *  - **The scan**: every tracked (and uncommitted) `.ts` of `server/src`, with a floor. The schema package has no violation row (its
 *    `untranslated` entries are a TypeScript generator's report, with their own fixed reasons).
 *  - **A row**: an object literal, found in the syntax tree (a comment neither fails nor satisfies it), that has both a `field` and a
 *    `reason` member, and is not a store projection (`{ field: 1, reason: 1 }`).
 *  - **The rule**: such a literal exists in the constructor's module, or it is a COPY of a constructed row — it has a `code` member, and
 *    neither its `code` nor its `reason` is written as a literal text there (a projection such as `{ field: v.field, reason: v.reason,
 *    code: v.code, params: v.params }`); or it is one of the {@link EXEMPT} sites, each a row that is not a schema violation, with why.
 *  - **The constructor is used**: called from at least {@link FLOOR_CALLS} sites, so a scan that reads the wrong place cannot pass.
 *
 * ## Proven
 *
 * Synthetic sources at the end: a hand-built row is flagged, with and without a code, and a copy, a row in a comment and a row in the
 * constructor's module are not.
 *
 * Run: node --test testing/standalone/a-schema-violation-is-built-by-one-constructor.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ts, parseSource } from '../_shared/syntax-tree.mjs';
import { readTrackedSources, SERVER_SOURCE_ROOT } from './_sources.mjs';

const MODULE = 'server/src/spaces/schema-violation-codes.ts';
const CONSTRUCTOR = 'schemaViolation';
/** The sites that call the constructor: fewer and either the scan reads the wrong place or the sites were not moved. */
const FLOOR_CALLS = 15;

/** Rows that are not schema violations, by file and the top-level function holding them, each with why. */
const EXEMPT = [
  { file: 'server/src/sync/linkage-check.ts', fn: 'recordViolations',
    why: 'a stored LINK violation (`LinkViolationDoc`): the peer linkage report of a dangling reference, its own store and door, not a schema row' },
  { file: 'server/src/contract/unknown-field-rows.ts', fn: 'unknownFieldMoreRow',
    why: 'an unknown-field row of a write body: it carries its own code, `unknown_field`, and is no violation of the space\'s schema' },
  { file: 'server/src/spaces/unconverted-terms.ts', fn: 'unconvertedViolationOf',
    why: 'the stored form of a constructed row (text bounded, code and params added when the row has them): a copy, not a row raised' },
  { file: 'server/src/spaces/unconverted-terms.ts', fn: 'listedUnconvertedViolations',
    why: 'the tolerant reading of a stored item: an item stored before violations had codes holds text only, and is listed so (no migration)' },
  { file: 'server/src/rdf/schema-owl-shacl.ts', fn: 'literal',
    why: 'a schema value the RDF schema export left out (`leftOut`, `{ where, field, reason }`): a note on the export\'s summary, no violation of the space\'s schema' },
  { file: 'server/src/rdf/schema-owl-shacl.ts', fn: 'typeAnnotations',
    why: 'a retention window the RDF schema export left out as not fitting its declared type: the same `leftOut` note' },
  { file: 'server/src/mcp/tools/schema-rdf.ts', fn: 'RDF_SCHEMA_OUTPUT_SCHEMA',
    why: 'the JSON Schema of `space_schema_rdf`\'s `leftOut` notes: it names the fields `field` and `reason`, and builds no row' },
];

/** The name of the top-level function (or const) `node` sits in; `''` at module level. */
function holder(node) {
  let name = '';
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) name = n.name.getText();
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent?.parent?.parent ?? n)) name = n.name.text;
  }
  return name;
}

const memberName = (m) => ((ts.isPropertyAssignment(m) || ts.isShorthandPropertyAssignment(m)) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null);

/** Whether an initializer is a text written there: a string, a template, or a `+` of them. */
function isLiteralText(e) {
  if (!e) return false;
  if (ts.isParenthesizedExpression(e)) return isLiteralText(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return true;
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && (isLiteralText(e.left) || isLiteralText(e.right));
}

/** Every `{ field, reason }` literal of `files`, and every call of the constructor. */
export function analyse(files) {
  const rows = [];
  let calls = 0;
  for (const { file, text } of files) {
    const sf = parseSource(file, text);
    (function visit(n) {
      if (ts.isObjectLiteralExpression(n)) {
        const members = new Map(n.properties.map(m => [memberName(m), m]).filter(([k]) => k !== null));
        const init = (k) => (members.has(k) && ts.isPropertyAssignment(members.get(k)) ? members.get(k).initializer : undefined);
        // `{ field: 1, reason: 1 }` is a store projection naming the two fields, not a row.
        const projection = init('reason') !== undefined && ts.isNumericLiteral(init('reason'));
        if (members.has('field') && members.has('reason') && !projection) {
          const copy = members.has('code') && !isLiteralText(init('code')) && !isLiteralText(init('reason'));
          rows.push({ file, fn: holder(n), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, copy });
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === CONSTRUCTOR) calls += 1;
      ts.forEachChild(n, visit);
    })(sf);
  }
  return { rows, calls };
}

const exemptRow = (r) => EXEMPT.some(e => e.file === r.file && e.fn === r.fn);

/** The rows built by hand outside the constructor's module, as `file:line (fn)`. */
export function handBuilt({ rows }) {
  return rows.filter(r => r.file !== MODULE && !r.copy && !exemptRow(r)).map(r => `${r.file}:${r.line} (${r.fn || 'module level'})`);
}

describe('every schema violation row is built by the one constructor', () => {
  const found = analyse(readTrackedSources(SERVER_SOURCE_ROOT, { floor: 300, untracked: true }));

  it('the scan found rows and constructor calls (floors: a stopped match reports success about nothing)', () => {
    assert.ok(found.rows.length >= 3, `only ${found.rows.length} { field, reason } literal(s) found`);
    assert.ok(found.calls >= FLOOR_CALLS, `the constructor is called from ${found.calls} site(s), under the floor of ${FLOOR_CALLS}`);
  });

  it('no row is built by hand outside the constructor\'s module', () => {
    assert.deepEqual(handBuilt(found), [], 'a violation row written by hand carries no code a screen can word: build it with schemaViolation(code, params, { field, value })');
  });

  it('every exemption still names a row (one that names nothing is a hole waiting for a row)', () => {
    const named = EXEMPT.filter(e => !found.rows.some(r => r.file === e.file && r.fn === e.fn));
    assert.deepEqual(named.map(e => `${e.file} ${e.fn}`), []);
  });
});

describe('the gate flags what it is meant to flag', () => {
  const run = (file, text) => handBuilt(analyse([{ file, text }]));

  it('a row written by hand is found, with a code or without one', () => {
    assert.equal(run('server/src/a.ts', "function f() { return { field: 'type', value: 1, reason: 'not allowed' }; }").length, 1);
    assert.equal(run('server/src/a.ts', "function f(t) { return { field: 'x', reason: `expected ${t}`, code: 'type', params: {} }; }").length, 1);
    assert.equal(run('server/src/a.ts', "function f(v) { return { field: v.field, reason: v.reason }; }").length, 1, 'a projection that drops the code');
  });

  it('a copy of a constructed row, a row in a comment and a row in the constructor\'s module are not', () => {
    assert.deepEqual(run('server/src/a.ts', 'function f(v) { return { field: v.field, reason: v.reason, code: v.code, params: v.params }; }'), []);
    assert.deepEqual(run('server/src/a.ts', 'const g = ({ field, reason, code, params }) => ({ field, reason, code, params });'), []);
    assert.deepEqual(run('server/src/a.ts', "// return { field: 'type', reason: 'bad' };\nconst t = 1;"), []);
    assert.deepEqual(run('server/src/a.ts', 'col.find({}, { projection: { docId: 1, field: 1, reason: 1 } });'), []);
    assert.deepEqual(run(MODULE, "export function schemaViolation(code, params, field, value) { return { field, value, reason: text(code, params), code, params }; }"), []);
  });
});
