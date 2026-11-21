/**
 * A test reads the `audit_log` collection only once the audit writer's pending inserts have landed.
 *
 * ## The failure this prevents (bundle-356, Full run 44886597449)
 *
 * `logAuditEntry` is fire-and-forget (`server/src/audit/audit.ts`), so a row can land after the test's read. The run was red on
 * `an-rdf-export-reads-a-view-db.test.js`: "the exports are audited: 9" for ten exports. `_audit-rows.mjs` exists for this race
 * (`auditRowsOf` reads once `auditWritesPending` is zero, `untilAuditWritesLanded` is the wait alone), and 21 files still read the
 * collection directly: each was the same flake waiting for a loaded runner.
 *
 * ## The rule
 *
 * A tracked `testing/**` test file or `.mjs` helper that READS `audit_log` (`find`, `findOne`, `countDocuments`, `aggregate` or
 * `distinct` on a handle of that collection, directly or through a name the file bound to it) must import `auditRowsOf` or
 * `untilAuditWritesLanded` from `_audit-rows.mjs` and call it. A write or a drop (`insertOne`, `deleteMany`, `drop`) is not a read.
 * The file is read as a syntax tree, so a mention in a comment or a quoted fixture does not count, and a line is reported as the file
 * has it. An exception is listed in `every-audit-log-read-waits-for-the-writer.allow.json` with a reason of three words or more and a
 * `reviewBy` date; an entry past its date, or one for a file that no longer breaks the rule, fails here.
 *
 * Run: node --test testing/standalone/every-audit-log-read-waits-for-the-writer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { parseSource, lineOf, ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./every-audit-log-read-waits-for-the-writer.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries;
const FILE_FLOOR = 300;
const READER_FLOOR = 5;
const WAITERS_MODULE = '_audit-rows.mjs';
const WAITERS = ['auditRowsOf', 'untilAuditWritesLanded'];
const HANDLE_CALLS = new Set(['collection', 'col', 'coll']);
const READ_METHODS = new Set(['find', 'findOne', 'countDocuments', 'aggregate', 'distinct']);

const isAuditName = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'audit_log';
const calleeNameOf = (call) => {
  const e = call.expression;
  return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '';
};

/** The local names this file imported from `_audit-rows.mjs` (an alias counts), for the waits it knows. */
function importedWaiters(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!st.moduleSpecifier.text.endsWith(WAITERS_MODULE)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) if (WAITERS.includes((el.propertyName ?? el.name).text)) names.add(el.name.text);
  }
  return names;
}

/** The name a handle expression is bound to: `const x = <handle>` or `const x = () => <handle>`, else null. */
function boundNameOf(handle) {
  for (let n = handle.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n)) return ts.isIdentifier(n.name) ? n.name.text : null;
    if (ts.isStatement(n)) return null;
  }
  return null;
}

/**
 * The 1-based lines at which `text` reads `audit_log`, and whether it imports and calls a wait from `_audit-rows.mjs`. `file` only picks
 * the language the file is parsed in.
 */
export function auditReadSites({ file, text }) {
  const sf = parseSource(file, text.replace(/\r\n/g, '\n'));
  const handles = [];
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && HANDLE_CALLS.has(calleeNameOf(n)) && n.arguments.some(isAuditName)) handles.push(n);
  });
  if (handles.length === 0) return { reads: [], waits: false };
  const waiters = importedWaiters(sf);
  let waits = false;
  const boundReads = new Map();
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && waiters.has(n.expression.text)) waits = true;
    if (!ts.isPropertyAccessExpression(n) || !READ_METHODS.has(n.name.text)) return;
    const target = ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression) ? n.expression.expression : n.expression;
    if (ts.isIdentifier(target)) boundReads.set(target.text, [...(boundReads.get(target.text) ?? []), lineOf(sf, n)]);
  });
  const lines = new Set();
  for (const h of handles) {
    const p = h.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === h && READ_METHODS.has(p.name.text)) lines.add(lineOf(sf, p));
    const bound = boundNameOf(h);
    if (bound) for (const l of boundReads.get(bound) ?? []) lines.add(l);
  }
  return { reads: [...lines].sort((a, b) => a - b), waits };
}

/** The lines of the reads of `audit_log` in a file that waits for no insert first; `[]` for a file that waits, or reads nothing. */
export function unguardedAuditReads(source) {
  const { reads, waits } = auditReadSites(source);
  return waits ? [] : reads;
}

const flagged = (text, file = 'planted.test.js') => unguardedAuditReads({ file, text });
const IMPORT = `import { auditRowsOf } from './_audit-rows.mjs';\n`;

describe('the gate recognises a read of the audit log that does not wait', () => {
  // The planted read is the shared reader's own, copied from its source: the line that reads the collection, not a retyped one.
  const helper = readFileSync(new URL('./_audit-rows.mjs', import.meta.url), 'utf8');
  const realRead = helper.split('\n').find(l => /collection\('audit_log'\)\.find\(/.test(l)).trim();
  const body = `it('y', async () => { const rows = await ${realRead.replace(/^return\s+/, '').replace(/;$/, '')}; });\n`;

  it('flags the read copied from the shared reader when no wait is imported, and reports its line', () => {
    assert.deepEqual(flagged(`import assert from 'node:assert/strict';\n${body}`), [2]);
  });

  it('passes the same read once the file imports a wait from _audit-rows.mjs and calls it', () => {
    assert.deepEqual(flagged(`${IMPORT}await auditRowsOf(mongo);\n${body}`), []);
    assert.deepEqual(flagged(`import { untilAuditWritesLanded } from './_audit-rows.mjs';\nawait untilAuditWritesLanded();\n${body}`), []);
    assert.deepEqual(flagged(`import { auditRowsOf as landed } from './_audit-rows.mjs';\nawait landed(mongo);\n${body}`), []);
  });

  it('flags a wait that is only imported, only named in a comment, a local function of the same name, or another module\'s', () => {
    assert.equal(flagged(`${IMPORT}${body}`).length, 1);
    assert.equal(flagged(`// auditRowsOf(mongo)\n${body}`).length, 1);
    assert.equal(flagged(`const auditRowsOf = (m) => m;\nauditRowsOf(mongo);\n${body}`).length, 1);
    assert.equal(flagged(`import { auditRowsOf } from './_space-act-harness.mjs';\nawait auditRowsOf(mongo, 'x');\n${body}`).length, 1);
  });

  it('flags each read method and each spelling of the handle', () => {
    for (const read of ['find({}).toArray()', 'findOne({})', 'countDocuments({})', 'aggregate([]).toArray()', 'distinct("operation")']) {
      assert.equal(flagged(`it('y', async () => { await mongo.getDb().collection('audit_log').${read}; });\n`).length, 1, read);
    }
    assert.equal(flagged(`it('y', async () => { await mongo.col("audit_log").find({}); });\n`).length, 1);
    assert.equal(flagged(`it('y', async () => { await door.coll(S, \`audit_log\`).countDocuments({}); });\n`).length, 1);
  });

  it('flags a read through a name the file bound to the collection', () => {
    assert.deepEqual(flagged(`const audit = d.col('audit_log');\n\nit('y', async () => { await audit.find({}); });\n`), [3]);
    assert.deepEqual(flagged(`const auditColl = () => door.mongo.getDb().collection('audit_log');\nit('y', async () => { await auditColl().findOne({}); });\n`), [2]);
  });

  it('does not flag a write, a drop, a comment, a quoted fixture or another collection', () => {
    assert.deepEqual(flagged(`it('y', async () => { await mongo.col('audit_log').deleteMany({}); await mongo.col('audit_log').drop(); });\n`), []);
    assert.deepEqual(flagged(`const audit = d.col('audit_log');\nit('y', async () => { await audit.insertOne({}); });\n`), []);
    assert.deepEqual(flagged(`// mongo.col('audit_log').find({})\nit('y', () => {});\n`), []);
    assert.deepEqual(flagged(`const src = "mongo.col('audit_log').find({})";\nit('y', () => run(src));\n`), []);
    assert.deepEqual(flagged(`it('y', async () => { await mongo.col('records').find({}); });\n`), []);
    assert.deepEqual(flagged(`const names = all.filter(n => n !== 'audit_log');\n`), []);
  });
});

describe('the repository', () => {
  const files = readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: FILE_FLOOR });
  const open = files.filter(f => !f.file.endsWith(`/${WAITERS_MODULE}`)).map(f => ({ file: f.file, lines: unguardedAuditReads(f) })).filter(f => f.lines.length);
  const allowed = (f) => ENTRIES.some(e => e.file === f.file);
  const readers = files.filter(f => auditReadSites(f).reads.length > 0);

  it(`read at least ${FILE_FLOOR} files (read ${files.length}) and saw ${READER_FLOOR} that read audit_log (saw ${readers.length}), so a broken scan cannot pass`, () => {
    assert.ok(files.length >= FILE_FLOOR, `only ${files.length} files were read`);
    assert.ok(readers.length >= READER_FLOOR, `only ${readers.length} files were seen reading audit_log: the detector is blind`);
  });

  it('no file reads the audit log without waiting for the writer, unless the allowlist names it', () => {
    const bad = open.filter(f => !allowed(f));
    assert.deepEqual(bad.map(f => `${f.file}:${f.lines.join(',')}`), [],
      `${bad.length} file(s) read audit_log before the writer's pending inserts have landed (a row can land after the read: Full run 44886597449). `
      + 'Read through auditRowsOf(mongo, filter) from _audit-rows.mjs, or await untilAuditWritesLanded() before the read; '
      + 'an exception goes in every-audit-log-read-waits-for-the-writer.allow.json with a reason and a reviewBy date.');
  });
});

describe(`the allowlist (${ENTRIES.length} exceptions)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const files = readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: FILE_FLOOR });
  const stillOpen = new Set(files.filter(f => unguardedAuditReads(f).length).map(f => f.file));

  it('every entry has a file, a reason of three words or more and a reviewBy date', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && e.file
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)
      && !Number.isNaN(Date.parse(e.reviewBy)) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(e => e.file ?? JSON.stringify(e)), [], 'each entry needs file, reason (3+ words) and reviewBy (YYYY-MM-DD)');
  });

  it('no entry is past its reviewBy date', () => {
    const late = ENTRIES.filter(e => typeof e.reviewBy === 'string' && e.reviewBy < today);
    assert.deepEqual(late.map(e => `${e.file} (reviewBy ${e.reviewBy}, today ${today})`), [], 'review the entry: make the file wait, or renew the date with a reason');
  });

  it('every entry still names a file that reads the audit log without waiting', () => {
    const gone = ENTRIES.filter(e => !stillOpen.has(e.file));
    assert.deepEqual(gone.map(e => e.file), [], 'the file waits now, or is gone: delete the entry');
  });
});
