/**
 * A stored record is read BY ID through one reader — `readStoredById` in `db/read-by-id.ts` — and nowhere else.
 *
 * ## The rule (Q-211)
 *
 * An `_id: { $in: ids }` read is the shape that goes wrong quietly. The copy that forgets the CHUNK sends one query
 * holding every id of a 50 000-record import; the copy that forgets the PROJECTION fetches a vector to compare a seq;
 * the copy that SPREADS a caller's filter beside `_id` lets the caller's own `_id` clause replace the restriction
 * instead of narrowing it. Each of the hand-written reads on the base is correct today for the ids it is handed and
 * wrong in one of those ways for an id list nobody has handed it yet. One reader carries all three guards, so a site
 * cannot drop one.
 *
 * ## How the set is found — derived, never listed
 *
 * - **The read methods come from `db/record-write-observer.ts` `COLLECTION_METHOD_EFFECT`** (every method it
 *   classifies `'read'`), the same table `_record-writes.mjs` derives the WRITE methods from. A read method the
 *   observer knows and this gate did not would be a door the gate is blind to.
 * - **Every `_id: { $in` in tracked `server/src`** — quoted or bare, on one line or several, comments BLANKED so a
 *   reported line is the real line and a sentence explaining the fix is not a site — is classified by WHAT IT IS
 *   HANDED TO, walking outward through the brackets that hold it: through a wrapper call (`asFilter<T>(…)`,
 *   `andPredicates(…)`), an object, an array (an aggregate pipeline's `$match` stage, a `$vectorSearch.filter`), up
 *   to the collection method that takes it. A filter built into a variable first is followed to every use of the
 *   variable. A filter RETURNED is a filter builder: a site of its own, because whatever consumes it reads by id.
 * - Anything the walk cannot resolve is a FINDING, not a pass. The safe direction is a line a person reads.
 *
 * ## The allowlist is keyed to the DEFINING site, each with its reason
 *
 * A row names `file:function`, so a new read written into the same file is still a finding. A row nothing matches
 * fails as stale.
 *
 * ## Seen red
 *
 * On the base (0b066822): the 17 hand-written `.find` reads, `recall.ts`'s two by-id `$match` pipelines and
 * `walk-reads.ts`'s second reader are reported. The scanner's own spellings are pinned below against fixtures, so a
 * matcher edited to see less fails here rather than reporting the tree clean.
 *
 * Run: node --test testing/standalone/a-record-is-read-by-id-through-one-reader.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { bracketsOpenAt, balancedFrom } from './_structural-window.mjs';
import { topLevelFunctionSpans, topLevelObjects } from './_call-graph.mjs';

const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');

/** The observer's read methods and write methods — never a list written here. */
const READ_METHODS = new Set(Object.entries(COLLECTION_METHOD_EFFECT).filter(([, e]) => e === 'read').map(([m]) => m));
const WRITE_METHODS = new Set(Object.entries(COLLECTION_METHOD_EFFECT).filter(([, e]) => e !== 'read').map(([m]) => m));

/** The one reader. Every by-id read inside it is the point of it. */
const READER = 'server/src/db/read-by-id.ts';

/**
 * The by-id `$in` reads that answer a DIFFERENT question than "the stored copy of each of these ids", keyed to the
 * function that defines them.
 */
const ALLOWED = new Map([
  ['server/src/brain/predicate-recall.ts:indexIsBehind',
    'an existence PROBE (`findOne`, one row or none) over the ids a vector batch did not return, ANDed with a vector-'
    + 'presence and freshness predicate; the caller chunks the ids by ID_CHUNK. It asks "is any of these missing from '
    + 'the index", not for the stored copies.'],
  ['server/src/brain/predicate-recall.ts:stageTwo',
    'a `$vectorSearch.filter` restricting exact SCORING to one batch of candidate ids — the index evaluates it, it is '
    + 'not a read of stored copies by id.'],
  ['server/src/brain/recall.ts:introduceLexicalOnly',
    'the ids are ANDed with the caller\'s eligibility predicate inside a scoring pipeline (`andPredicates`, so a '
    + 'caller\'s own `_id` clause narrows it); it reads candidates for ranking, not stored copies.'],
  ['server/src/brain/entity-name-scope.ts:attachedToEntityNamed',
    'a filter BUILDER: it returns a predicate the filter tool ANDs into a caller\'s query, never reads by id itself.'],
]);

/** `_id` (bare or quoted) keyed to an object whose first key is `$in` (bare or quoted), across lines. The capture is
 * the `{` of the `$in` object — real code, so the bracket walk can stand on it even when the key is a string. */
const byIdIn = () => /(?<![\w$])\[?['"]?_id['"]?\]?\s*:\s*(\{)\s*['"]?\$in['"]?\s*:/g;

/** The identifier a call bracket at `paren` is the call of, generics skipped: `{ member, name }` or null. */
function calleeBefore(code, paren) {
  let j = paren - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === '>' && code[j - 1] !== '=') {
    let depth = 0;
    for (; j >= 0; j--) {
      if (code[j] === '>') depth++;
      else if (code[j] === '<') { depth--; if (depth === 0) { j--; break; } }
    }
    while (j >= 0 && /\s/.test(code[j])) j--;
  }
  // The identifier ending at `j`, walked back character by character: bounded by the identifier itself.
  let k = j;
  while (k >= 0 && /[\w$]/.test(code[k])) k--;
  const name = code.slice(k + 1, j + 1);
  if (!/^[A-Za-z_$]/.test(name)) return null;
  while (k >= 0 && /\s/.test(code[k])) k--;
  return { name, member: code[k] === '.' || (code[k] === '?' && code[k + 1] === '.') };
}

/** What precedes `at` on its line — or, when nothing does, on the last non-blank line before it. */
function leadIn(code, at) {
  let end = at;
  for (;;) {
    const start = code.lastIndexOf('\n', end - 1) + 1;
    const text = code.slice(start, end).trimEnd();
    if (text.trim() !== '' || start === 0) return text;
    end = start - 1;
  }
}

/** Is the `{` at `brace` a BLOCK (function body, if, try…) rather than an object literal? */
function isBlock(code, brace) {
  const before = leadIn(code, brace);
  if (/(?:=>|\)|\belse|\btry|\bfinally|\bdo)$/.test(before)) return true;
  if (/(?:^|[^\w$])(?:class|interface)\s+[\w$<>, ]+$/.test(before)) return true;
  // A function's return-type annotation ends in `>` or a type name, then the body: `): Promise<X> {`.
  const line = code.slice(code.lastIndexOf('\n', brace) + 1, brace);
  return /\)\s*:\s*[^=(]*$/.test(line) && !/[,:(=[?]\s*$/.test(before);
}

/**
 * What an expression at `at` is handed to. Returns `{ kind: 'read'|'write'|'builder'|'unresolved', method?, via? }`.
 * `seen` stops a variable that feeds itself.
 */
function classify(code, at, seen = new Set()) {
  const stack = bracketsOpenAt(code, at);
  if (!stack) return null;
  let outermostExpr = null;
  let blockOpen = -1;
  for (let s = stack.length - 1; s >= 0; s--) {
    const { c, i } = stack[s];
    if (c === '{' && isBlock(code, i)) { blockOpen = i; break; }
    outermostExpr = i;
    if (c !== '(') continue;
    const callee = calleeBefore(code, i);
    if (callee?.member && READ_METHODS.has(callee.name)) return { kind: 'read', method: callee.name };
    if (callee?.member && WRITE_METHODS.has(callee.name)) return { kind: 'write', method: callee.name };
    if (/=>$/.test(leadIn(code, i))) return { kind: 'builder', via: 'arrow' };
    if (callee && /^(?:if|for|while|switch|catch)$/.test(callee.name)) { blockOpen = i; break; }
  }
  // Not inside a collection call: what does the statement DO with the expression?
  const exprStart = outermostExpr ?? at;
  let head = code.slice(blockOpen + 1, exprStart);
  head = head.slice(Math.max(head.lastIndexOf(';'), head.lastIndexOf('}'), head.lastIndexOf('{')) + 1);
  // A wrapper call around the literal (`asFilter<T>(`) is part of the expression, not the statement.
  head = head.replace(/(?:await\s+)?[A-Za-z_$][\w$.]*\s*(?:<[^=;]*>)?\s*$/, m => (/^(?:return|await)$/.test(m.trim()) ? m : ''));
  if (/\breturn\s*$/.test(head) || /=>\s*$/.test(head)) return { kind: 'builder', via: 'return' };
  const decl = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/.exec(head);
  if (!decl || seen.has(decl[1])) return { kind: 'unresolved', via: head.trim().slice(-60) };
  const name = decl[1];
  const scopeStart = blockOpen >= 0 ? blockOpen : 0;
  const scope = blockOpen >= 0 ? balancedFrom(code, blockOpen) : code;
  const uses = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  for (let m; (m = re.exec(scope));) {
    const pos = scopeStart + m.index;
    if (pos < exprStart) continue;
    // A (re)declaration or assignment of the name, not a use: anchored at the name, bounded by the line.
    if (/^\s*(?::[^=;\n]*)?=(?![=>])/.test(scope.slice(m.index + name.length))) continue;
    const verdict = classify(code, pos, new Set([...seen, name]));
    if (verdict) uses.push(verdict);
  }
  const kinds = new Set(uses.map(u => u.kind));
  for (const k of ['read', 'builder', 'unresolved']) {
    if (kinds.has(k)) return { ...uses.find(u => u.kind === k), via: `variable ${name}` };
  }
  if (kinds.has('write')) return { kind: 'write', via: `variable ${name}` };
  return { kind: 'unresolved', via: `variable ${name} with no use found` };
}

/** The function that DEFINES offset `at`: `file:function`, `file:Object.method`, or `file:<module>`. */
function definingSite(file, code, at) {
  for (const [name, { start, body }] of topLevelFunctionSpans(code)) {
    if (at >= start && at < start + body.length) return `${file}:${name}`;
  }
  for (const [obj, { methods }] of topLevelObjects(code)) {
    for (const [prop, { start, body }] of methods) {
      if (at >= start && at < start + body.length) return `${file}:${obj}.${prop}`;
    }
  }
  return `${file}:<module>`;
}

/** Every by-id `$in` in one source, classified. */
function scan(file, code) {
  const out = [];
  const re = byIdIn();
  for (let m; (m = re.exec(code));) {
    const brace = m.index + m[0].indexOf('{', m[0].indexOf(':'));
    const verdict = classify(code, brace);
    if (!verdict) continue; // inside a string or template: a message, not a filter
    const line = code.slice(0, brace).split('\n').length;
    out.push({ file, line, site: definingSite(file, code, brace), ...verdict });
  }
  return out;
}

const SOURCES = readTrackedSources('server/src', { floor: 100, specs: false, untracked: true })
  .map(s => ({ file: s.file, code: blankComments(s.text) }));
const FOUND = SOURCES.flatMap(s => scan(s.file, s.code));
const READS = FOUND.filter(f => f.kind !== 'write');

describe('the scanner sees every spelling of a by-id read (fixtures)', () => {
  const one = (src) => scan('fixture.ts', blankComments(src));

  it('an asFilter-wrapped filter in a .find is a read', () => {
    const [f] = one(`async function a(ids) { return coll.find(asFilter<X>({ _id: { $in: ids } })).toArray(); }`);
    assert.equal(f?.kind, 'read');
    assert.equal(f.method, 'find');
  });
  it('a filter spread over several lines, the key quoted, is a read', () => {
    const [f] = one(`async function a(ids) {\n  return coll.findOne(\n    { '_id':\n      {\n        '$in': ids } },\n  );\n}`);
    assert.equal(f?.kind, 'read');
  });
  it('a $match stage inside an aggregate pipeline is a read', () => {
    const [f] = one(`async function a(ids) {\n  return coll.aggregate<Record<string, unknown>>([\n    { $match: { _id: { $in: ids } } },\n    { $project: { x: 1 } },\n  ]).toArray();\n}`);
    assert.equal(f?.kind, 'read');
    assert.equal(f.method, 'aggregate');
  });
  it('a filter built into a variable first is followed to the read it is handed to', () => {
    const [f] = one(`async function a(ids) {\n  const filter = asFilter<X>({ _id: { $in: ids }, spaceId });\n  const rows = await coll.find(filter, { projection: { _id: 1 } }).toArray();\n  return rows;\n}`);
    assert.equal(f?.kind, 'read');
    assert.match(f.via, /variable filter/);
  });
  it('a filter returned from a function is a builder', () => {
    const [f] = one(`export function scope(ids) {\n  if (!ids.length) {\n    return { _id: { $in: [] } };\n  }\n  return { x: 1 };\n}`);
    assert.equal(f?.kind, 'builder');
    assert.equal(f.site, 'fixture.ts:scope');
  });
  it('a filter an arrow function returns concisely is a builder', () => {
    const [f] = one(`export const scope = (ids: string[]) =>\n  ({ _id: { $in: ids } });`);
    assert.equal(f?.kind, 'builder');
  });
  it('a delete or update by id is a write, not a read', () => {
    const found = one(`async function a(ids) {\n  await coll.deleteMany(asFilter<X>({ _id: { $in: ids } }));\n  await coll.updateMany(\n    { _id: { $in: ids } },\n    { $set: { a: 1 } });\n}`);
    assert.deepEqual(found.map(f => f.kind), ['write', 'write']);
  });
  it('a mention in a comment or a string is not a site', () => {
    assert.deepEqual(one(`// coll.find({ _id: { $in: ids } })\nconst s = 'coll.find({ _id: { $in: ids } })';\n/* { _id: { $in: x } } */`), []);
  });
  it('a filter handed to a function the walk cannot see into is a finding, not a pass', () => {
    const [f] = one(`async function a(ids) {\n  await somebodyElse(coll, { _id: { $in: ids } });\n}`);
    assert.equal(f?.kind, 'unresolved');
  });
  it('the read methods are the observer\'s, and include every way a filter is read', () => {
    for (const m of ['find', 'findOne', 'aggregate', 'countDocuments', 'distinct']) assert.ok(READ_METHODS.has(m), m);
    for (const m of ['deleteMany', 'updateMany', 'bulkWrite', 'findOneAndUpdate']) assert.ok(WRITE_METHODS.has(m), m);
  });
});

describe('a record is read by id through one reader', () => {
  it('the scan read the tree (floors, and the reader itself is found)', () => {
    assert.ok(FOUND.length >= 30, `only ${FOUND.length} \`_id: { $in\` filters found in server/src — the matcher is broken`);
    assert.ok(FOUND.filter(f => f.kind === 'write').length >= 10,
      'fewer than 10 by-id WRITES classified — the walk is not reaching the collection method');
    assert.ok(READS.some(f => f.file === READER),
      `the reader ${READER} was not seen reading by id — the scan cannot see the one site it is built around`);
  });

  it('every allowlisted defining site still reads by id (no stale rows)', () => {
    const stale = [...ALLOWED.keys()].filter(k => !READS.some(f => f.site === k));
    assert.deepEqual(stale, [], `allowlisted sites that no longer read by id — delete their rows:\n  ${stale.join('\n  ')}`);
  });

  it('no by-id read outside readStoredById, unless its defining site is allowlisted with a reason', () => {
    const raw = READS.filter(f => f.file !== READER && !ALLOWED.has(f.site));
    assert.deepEqual(raw.map(f => `${f.file}:${f.line} [${f.site.split(':')[1]}] ${f.kind}${f.method ? ` .${f.method}` : ''}${f.via ? ` (${f.via})` : ''}`), [],
      `${raw.length} by-id read(s) bypass the one reader. Move each onto readStoredById(coll, ids, { fields | filter | `
      + 'session | timeLeft }) — its predicate goes in `filter`, ANDed, never spread — or, if it answers a different '
      + 'question than "the stored copy of each id", allowlist its DEFINING function with the reason.');
  });
});
