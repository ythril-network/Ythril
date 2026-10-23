/**
 * No Mongo write puts back a value computed from a copy of the document it writes: a count is `$inc`ed, never `$set` to
 * `<copy>.<field> + n`, and a read whose result feeds a write of the same document leaves no window between them.
 *
 * ## The two shapes
 *
 * **1. Read, await, write back** (`findReadModifyWrite`). A document is READ, something is AWAITED, and the same document is written
 * back using values derived from the read. The await is the window: a concurrent writer's change lands inside it and is silently
 * clobbered by the write that follows. This is the database twin of #604, where a reference into `config.networks` was taken, a
 * bcrypt hash was awaited, and the push landed on an object the config reload had already replaced.
 *
 * **2. A counter `$set` from a snapshot** (`findCounterFromSnapshot`, Q-477, moved in from Q-550). A field is written as `$set: {
 * <field>: <copy>.<field> + n }`, where the copy is whatever this code holds: a `findOne`, a page of a read, a row out of a CACHED
 * ARRAY (`subs.find(…)`, which has no await at all and is still a read-modify-write: the cache is one process's, and two processes,
 * or two calls in one, each add one to the same number). Two failures at once write the same count. The rule is the field, not the
 * read: a `$set` of `<x>.<f> + n` (or `(<x>.<f> ?? 0) + n`, or a plain `<f> + n`) into a key whose last segment is `<f>`, reached
 * directly, through ONE local binding (`const failures = sub.consecutiveFailures + 1`), or as a call argument into a function whose
 * write `$set`s that parameter (`recordMoveAttempt(…, attempts, …)` in another file). The write is any of `updateOne`, `updateMany`,
 * `replaceOne`, `findOneAndUpdate`. The fix is `$inc` (with a guarded filter when the count decides something), or a reasoned row
 * in {@link EXEMPT} saying what makes the snapshot the only writer.
 *
 * ## Why this file says what it found, and the self-tests
 *
 * The first version of this header read "Zero sites", and it was true of what the first detector looked at: a `findOne` assigned to
 * a variable on one line, followed by an await and a write within sixty lines. `markWebhookFailure` read from a cached array, wrote
 * through a local variable, and had no await between, so it was invisible; `finishOwedMoves` passed the count to a function in
 * another file whose write is `updateMany`, which the write pattern did not name. A clean sweep is a fact about what the sweep reads.
 * The self-tests plant each shape the detector claims to see, so losing one of them is red here, and an exemption that matches no
 * site is refused (a row outliving its site would excuse the next one written there).
 *
 * The sources are `git ls-files server/src` through `trackedSources`, whose floor makes an empty listing a failure, never a pass.
 *
 * Run: node --test testing/standalone/no-read-modify-write.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression, outermostFunctionOf } from '../_shared/syntax-tree.mjs';

/**
 * Blank comments IN PLACE, so reported line numbers stay true (shape 1's line reader; shape 2 reads the syntax tree, which has no
 * comments to be fooled by).
 *
 * An earlier scanner in this repo stripped comments instead and reported line numbers that pointed at the wrong
 * code — which made two innocent sites look guilty and cost the time to prove they were not.
 */
function blankComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '`' || c === '\'' || c === '"') { state = c === '`' ? 'tmpl' : c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } else out += ' '; i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? c : ' '); i++; continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if ((state === 'tmpl' && c === '`') || c === state) state = 'code';
    out += c; i++;
  }
  return out;
}

/** The driver calls that write a document: the one list both shapes read. */
const WRITE_METHODS = ['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate'];

const READ = /(?:const|let)\s+(\w+)(?:\s*:[^=]+)?\s*=\s*(?:await\s+)?[^;]*\.findOne\(/;
const WRITE = new RegExp(`\\.(${WRITE_METHODS.join('|')})\\(`);
const AWAIT = /\bawait\b/;

/**
 * Shape 1: read-modify-write windows in one file's text, as `{ readLine, writeLine, variable, awaits }`.
 *
 * Scope-aware by brace depth: it stops at the end of the block the read was in, so a write in a *sibling*
 * block is not attributed to it. Without that, a function with an early-return read and an unrelated update
 * further down reads as a defect.
 */
export function findReadModifyWrite(text) {
  const lines = blankComments(text).split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = READ.exec(lines[i]);
    if (!m) continue;
    const variable = m[1];
    let depth = 0;
    let awaits = 0;
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      const l = lines[j];
      depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
      if (depth < 0) break;
      if (AWAIT.test(l) && !WRITE.test(l)) awaits++;
      if (WRITE.test(l)) {
        const near = lines.slice(j, Math.min(lines.length, j + 4)).join(' ');
        if (new RegExp(`\\b${variable}\\b`).test(near) && awaits > 0) {
          hits.push({ readLine: i + 1, writeLine: j + 1, variable, awaits });
        }
        break;
      }
    }
  }
  return hits;
}

// ── Shape 2: a counter $set from a snapshot ───────────────────────────────────────────────────────────────────────────

const lastSegment = (key) => key.split('.').at(-1);
const isFallback = (op) => op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken;

/** The fields a `+` expression counts from: `<x>.<f> + n`, `(<x>.<f> ?? 0) + n` and `<f> + n` each give `f`. */
function counterFields(expr) {
  const e = unwrapExpression(expr);
  if (!e || !ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return [];
  const out = [];
  for (const side of [e.left, e.right]) {
    let s = unwrapExpression(side);
    if (s && ts.isBinaryExpression(s) && isFallback(s.operatorToken.kind)) s = unwrapExpression(s.left);
    if (s && ts.isPropertyAccessExpression(s)) out.push(s.name.text);
    else if (s && ts.isIdentifier(s)) out.push(s.text);
  }
  return out;
}

/** The functions around `node`, innermost first. */
function functionsAround(node) {
  const out = [];
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && !ts.isSourceFile(n)) out.push(n);
  return out;
}

/** The initializer of the local `const`/`let` named `name` in the nearest function around `node` that declares one. */
function localInitializer(node, name) {
  for (const fn of functionsAround(node)) {
    let found = null;
    walkEveryNode(fn, (n) => {
      if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    });
    if (found) return found;
  }
  return null;
}

/** The fields `value` counts from: directly, or through ONE local binding. */
function countedFields(value) {
  const direct = counterFields(value);
  if (direct.length > 0) return direct;
  const v = unwrapExpression(value);
  if (v && ts.isIdentifier(v)) {
    const init = localInitializer(v, v.text);
    if (init) return counterFields(init);
  }
  return [];
}

const propertyKey = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null);

/** Every write call in `sf`, with the `{ key, value }` pairs of each `$set` object literal in its arguments. */
function writesOf(sf) {
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !WRITE_METHODS.includes(n.expression.name.text)) return;
    const sets = [];
    for (const arg of n.arguments) {
      walkEveryNode(arg, (p) => {
        if (!ts.isPropertyAssignment(p) || propertyKey(p) !== '$set') return;
        const obj = unwrapExpression(p.initializer);
        if (!obj || !ts.isObjectLiteralExpression(obj)) return;
        for (const q of obj.properties) {
          if (ts.isPropertyAssignment(q) && propertyKey(q)) sets.push({ key: propertyKey(q), value: q.initializer });
          else if (ts.isShorthandPropertyAssignment(q)) sets.push({ key: q.name.text, value: q.name });
        }
      });
    }
    out.push({ call: n, sets });
  });
  return out;
}

/** The name a function is known by: its own, or the variable or property it is assigned to. */
function functionName(fn) {
  if (!fn) return '<module>';
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
  return '<anonymous>';
}

/** Function name -> the `$set` keys its writes take straight from its parameter at each index. */
function parameterWrites(files) {
  const index = new Map();
  for (const { sf } of files) {
    for (const { call, sets } of writesOf(sf)) {
      const fn = functionsAround(call).at(-1);
      if (!fn || !fn.parameters) continue;
      const params = fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : null));
      for (const { key, value } of sets) {
        const v = unwrapExpression(value);
        const at = v && ts.isIdentifier(v) ? params.indexOf(v.text) : -1;
        if (at < 0) continue;
        const name = functionName(fn);
        if (!index.has(name)) index.set(name, new Map());
        const byParam = index.get(name);
        if (!byParam.has(at)) byParam.set(at, new Set());
        byParam.get(at).add(lastSegment(key));
      }
    }
  }
  return index;
}

/**
 * Shape 2 over a set of sources (`[{ path, text }]`): every `$set` of a counter computed from a copy of the same field, as
 * `{ file, fn, field, line, via }` — `via` names the function whose write it reaches through a call argument, or is `null` for a
 * write in the same function.
 */
export function findCounterFromSnapshot(sources) {
  const files = sources.map(({ path, text }) => ({ path, sf: parseSource(path, text) }));
  const index = parameterWrites(files);
  const hits = [];
  const seen = new Set();
  const hit = (path, sf, node, field, via) => {
    const h = { file: path, fn: functionName(outermostFunctionOf(node)), field, line: lineOf(sf, node), via };
    const k = `${h.file}:${h.line}:${h.field}`;
    if (!seen.has(k)) { seen.add(k); hits.push(h); }
  };
  for (const { path, sf } of files) {
    for (const { call, sets } of writesOf(sf)) {
      for (const { key, value } of sets) {
        if (countedFields(value).includes(lastSegment(key))) hit(path, sf, call, lastSegment(key), null);
      }
    }
    walkEveryNode(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = unwrapExpression(n.expression);
      const name = callee && ts.isIdentifier(callee) ? callee.text : null;
      const byParam = name ? index.get(name) : null;
      if (!byParam) return;
      n.arguments.forEach((arg, at) => {
        const keys = byParam.get(at);
        if (!keys) return;
        for (const f of countedFields(arg)) if (keys.has(f)) hit(path, sf, n, f, name);
      });
    });
  }
  return hits;
}

/**
 * The sites that keep a counter `$set` from a snapshot ON PURPOSE, each with what makes the snapshot the only writer. A row is a
 * site (file, the function it is in, the field), and a row that matches no site is refused below.
 */
export const EXEMPT = [
  {
    file: 'server/src/files/finish-owed-moves.ts', fn: 'finishOwedMoves', field: 'attempts',
    why: 'the attempt count is written by the housekeeping pass that read the marker page, and the pass is single-flight; the move itself '
      + 'runs under its turn lock, so no second writer counts an attempt of the same move between the page read and recordMoveAttempt',
  },
  {
    file: 'server/src/brain/embed-queue.ts', fn: 'failEmbedJob', field: 'transientFailures',
    why: 'the count comes from the job this worker claimed, and the write is filtered by the claim token (claimedBy): a job whose claim '
      + 'was taken over matches nothing, so only the claim holder writes the count it read',
  },
  {
    file: 'server/src/brain/embed-queue.ts', fn: 'failEmbedJob', field: 'lostChildFailures',
    why: 'as transientFailures: read from the claimed job and written under its claim token, so only the claim holder writes it',
  },
];

const exemptionOf = (h) => EXEMPT.find(e => e.file === h.file && e.fn === h.fn && e.field === h.field);

/** The rows of `exempt` that match none of `hits`. */
export function unmatchedExemptions(hits, exempt = EXEMPT) {
  return exempt.filter(e => !hits.some(h => h.file === e.file && h.fn === e.fn && h.field === e.field));
}

function serverSources() {
  return trackedSources('server/src', { specs: false, floor: 100 }).map(path => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));
}

describe('no read-modify-write over a Mongo document', () => {
  const sources = serverSources();

  it('finds no read, await and write-back in the data layer', () => {
    const offenders = [];
    for (const { path, text } of sources) {
      for (const h of findReadModifyWrite(text)) {
        offenders.push(`${path.replace(/^server\/src\//, '')}:${h.readLine} → write at ${h.writeLine} (${h.awaits} await(s), '${h.variable}')`);
      }
    }
    assert.deepEqual(offenders, [], `a concurrent write can be clobbered here:\n  ${offenders.join('\n  ')}\n\n`
      + 'Use an atomic operator ($set of fresh values, $inc, $max, $addToSet), or re-read inside the write\n'
      + '(findOneAndUpdate / mutateConfig). The await between the read and the write is the window.');
  });

  it('finds no counter $set from a snapshot, except a reasoned exemption', () => {
    const offenders = findCounterFromSnapshot(sources).filter(h => !exemptionOf(h))
      .map(h => `${h.file}:${h.line} (${h.fn}) $set ${h.field} from a copy of ${h.field}${h.via ? `, through ${h.via}()` : ''}`);
    assert.deepEqual(offenders, [], `two writers each add to the same number here:\n  ${offenders.join('\n  ')}\n\n`
      + 'Count with $inc (and flip a status with a second conditional write whose filter carries the threshold), or add a row to\n'
      + 'EXEMPT saying what makes this copy the only writer.');
  });

  it('every exemption matches a site: a row outliving its site would excuse the next one written there', () => {
    const stale = unmatchedExemptions(findCounterFromSnapshot(sources));
    assert.deepEqual(stale.map(e => `${e.file} ${e.fn} ${e.field}`), [], 'exemption rows that match no site');
  });

  it('scans a meaningful number of files — the scan itself still works', () => {
    // trackedSources asserts its own floor; this is the gate's: a listing of the server that lost most of it would still pass that.
    assert.ok(sources.length > 300, `only ${sources.length} server sources listed`);
  });

  // ── The detectors must be able to fail ───────────────────────────────────────────────────────────────────────────────
  it('shape 1 DETECTS the read, await, write-back it exists for, by updateOne and by updateMany', () => {
    for (const method of ['updateOne', 'updateMany']) {
      const bad = `
        export async function bad(id) {
          const doc = await col('files').findOne(asFilter({ _id: id }));
          if (!doc) return;
          await somethingSlow();
          await col('files').${method}(asFilter({ _id: id }), { $set: { tags: [...doc.tags, 'x'] } });
        }`;
      const hits = findReadModifyWrite(bad);
      assert.equal(hits.length, 1, `the planted defect (${method}) must be found`);
      assert.equal(hits[0].variable, 'doc');
      assert.ok(hits[0].awaits >= 1);
    }
  });

  it('shape 1 does NOT flag a write with no await in the window', () => {
    const fine = `
      export async function fine(id) {
        const doc = await col('files').findOne(asFilter({ _id: id }));
        await col('files').updateOne(asFilter({ _id: id }), { $set: { seen: doc.seen + 1 } });
      }`;
    assert.deepEqual(findReadModifyWrite(fine), []);
  });

  it('shape 1 does NOT flag a write that ignores what was read', () => {
    const fine = `
      export async function fine(id) {
        const existing = await col('files').findOne(asFilter({ _id: id }));
        if (!existing) return;
        await recomputeSomething();
        await col('files').updateOne(asFilter({ _id: id }), { $inc: { hits: 1 } });
      }`;
    assert.deepEqual(findReadModifyWrite(fine), []);
  });

  it('shape 1 does not attribute a write in a sibling block to an earlier read', () => {
    const fine = `
      export async function fine(id) {
        if (a) {
          const doc = await col('files').findOne(asFilter({ _id: id }));
          if (!doc) return;
        }
        await other();
        await col('files').updateOne(asFilter({ _id: id }), { $set: { doc: 1 } });
      }`;
    assert.deepEqual(findReadModifyWrite(fine), []);
  });

  it('shape 1 is not fooled by the shape appearing inside a comment', () => {
    const fine = `
      // const doc = await col('files').findOne(...);
      // await slow();
      // await col('files').updateOne(..., { $set: { x: doc.x } });
      export async function fine() { return 1; }`;
    assert.deepEqual(findReadModifyWrite(fine), []);
  });

  const one = (text, path = 'server/src/x/planted.ts') => findCounterFromSnapshot([{ path, text }]);

  it('shape 2 DETECTS a count read from a cached array with no await between the read and the write', () => {
    const hits = one(`
      export async function markFailure(id: string): Promise<void> {
        const sub = (await ensureCache()).find(s => s.id === id);
        if (!sub) return;
        await col('hooks').updateOne({ id }, { $set: { failures: (sub.failures ?? 0) + 1 } });
      }`);
    assert.deepEqual(hits.map(h => `${h.fn} ${h.field}`), ['markFailure failures']);
  });

  it('shape 2 DETECTS a count written through ONE local binding (the shape of markWebhookFailure)', () => {
    const hits = one(`
      export async function markFailure(id: string): Promise<void> {
        const subs = await ensureCache();
        const sub = subs.find(s => s.id === id);
        if (!sub) return;
        const failures = (sub.consecutiveFailures ?? 0) + 1;
        const status = failures >= 6 ? 'failing' : sub.status;
        await col('hooks').updateOne({ id } as Filter, { $set: { status, consecutiveFailures: failures } } as UpdateFilter);
      }`);
    assert.deepEqual(hits.map(h => `${h.fn} ${h.field}`), ['markFailure consecutiveFailures']);
  });

  it('shape 2 DETECTS a count passed as a call argument into another file\'s updateMany (the shape of finishOwedMoves)', () => {
    const hits = findCounterFromSnapshot([
      { path: 'server/src/x/pass.ts', text: `
        export async function pass(spaceId: string, markers: Marker[]): Promise<void> {
          await eachUnit(markers, async (m) => {
            const attempts = (m.attempts ?? 0) + 1;
            await recordAttempt(spaceId, m.from, attempts, 'later');
          });
        }` },
      { path: 'server/src/x/markers.ts', text: `
        export async function recordAttempt(spaceId: string, from: string, attempts: number, next: string): Promise<void> {
          await markers(spaceId).updateMany(asFilter({ from }), asUpdate({ $set: { 'move.attempts': attempts, 'move.next': next } }));
        }` },
    ]);
    assert.deepEqual(hits.map(h => `${h.file} ${h.fn} ${h.field} ${h.via}`), ['server/src/x/pass.ts pass attempts recordAttempt']);
  });

  it('shape 2 DETECTS a count $set by updateMany in the same function', () => {
    const hits = one(`
      export async function bump(rows: Row[]): Promise<void> {
        for (const r of rows) await col('rows').updateMany({ group: r.group }, { $set: { seen: r.seen + 1 } });
      }`);
    assert.deepEqual(hits.map(h => `${h.fn} ${h.field}`), ['bump seen']);
  });

  it('shape 2 does NOT flag $inc, a $set of a fresh value, a count of another field, or the shape inside a comment', () => {
    const hits = one(`
      export async function fine(id: string, sub: Sub): Promise<void> {
        await col('hooks').updateOne({ id }, { $inc: { failures: 1 } });
        await col('hooks').updateOne({ id }, { $set: { failures: 0, updatedAt: new Date().toISOString() } });
        await col('hooks').updateOne({ id }, { $set: { total: sub.failures + 1 } });
        // await col('hooks').updateOne({ id }, { $set: { failures: sub.failures + 1 } });
      }`);
    assert.deepEqual(hits, []);
  });

  it('an exemption that matches no site is refused', () => {
    const hits = one(`
      export async function markFailure(id: string, sub: Sub): Promise<void> {
        await col('hooks').updateOne({ id }, { $set: { failures: sub.failures + 1 } });
      }`);
    const rows = [
      { file: 'server/src/x/planted.ts', fn: 'markFailure', field: 'failures', why: 'planted' },
      { file: 'server/src/x/planted.ts', fn: 'gone', field: 'failures', why: 'its site was removed' },
    ];
    assert.deepEqual(unmatchedExemptions(hits, rows).map(e => e.fn), ['gone']);
  });
});
