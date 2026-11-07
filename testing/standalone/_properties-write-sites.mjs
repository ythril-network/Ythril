/**
 * Every place the server writes a `properties` bag to a store, judged ONE SITE AT A TIME (bundle-62, Q-197).
 *
 * ## The question it answers, and what it prevents
 *
 * "Does this site store the bag a caller sent, or the stored bag with the caller's keys laid over it?" The old gates asked it per FILE
 * (`/\bmergeProperties(?:OrKeep)?\(/` anywhere in a module that assigns a bag), so one merge call in `files/file-meta.ts` kept the gate green
 * while `upsertFileMeta`'s own line replaced the bag outright: a rewrite destroyed every key the caller never named. A per-file match is
 * satisfied by any other line of the file; a site is satisfied only by its own right-hand side.
 *
 * ## What a site is
 *
 *  - an ASSIGNMENT `<name>['properties'] = <rhs>` (any name; `$unset[...]` is a removal and is not a write of a bag);
 *  - an OBJECT-LITERAL key `properties: <rhs>` (or the shorthand `properties`) whose enclosing statement is headed for a store write
 *    (`insertOne`, `updateOne`, `replaceOne`, `bulkWrite`, ..., or a `$set` / `$setOnInsert`).
 *
 * ## What satisfies one
 *
 *  - a merge call: `mergeProperties(` / `mergePropertiesOrKeep(` (`brain/merge-fields.ts`);
 *  - the database spelling of the same rule, `mergePropertiesStage(`, but ONLY as an object-literal key of a pipeline `$set`. As an
 *    ASSIGNMENT into a `$set` that the same function maps through `$literal` it would be stored as TEXT (the stage's own operators
 *    written as a field's value);
 *  - a bare variable, when EVERY assignment of that variable in the same function is itself satisfied. Checked at each assignment, not
 *    only at the declaration: `newProps = merged['properties']` after a `const newProps = mergeProperties(...)` is a raw bag.
 *
 * ## Exceptions
 *
 * One list ({@link PROPERTIES_WRITE_EXCEPTIONS}), each with its reason and the date it was last reviewed. An entry that matches no site is
 * itself a failure, so the list cannot outlive the code it excuses; the gates report how many there are.
 *
 * ## What it does not see
 *
 * A bag carried in a spread (`...plan.set`) or assembled in a variable literal and handed to the store later (`const doc = { properties }`
 * then `insertOne(doc)`) has no site here. The set it reads is the symptom (a statement that names `properties` beside a store write),
 * not every route a value can take; the planted cases in the gates' own tests say which shapes it does catch.
 */
import { stripComments } from './_strip-comments.mjs';

/** A statement is "headed for a store write" when it names one of these. */
const STORE_WRITE = /\b(?:insertOne|insertMany|replaceOne|updateOne|updateMany|bulkWrite|findOneAndUpdate|findOneAndReplace)\b|\$set(?:OnInsert)?\b/;

/** A call that IS the merge rule. */
const MERGE_CALL = /\bmergeProperties(?:OrKeep)?\s*\(|\bmergeTagsAndProperties\s*\(/;
/** The database spelling of the same rule. */
const STAGE_CALL = /\bmergePropertiesStage\s*\(/;

const REVIEWED = '2026-11-07';

/**
 * Sites that are deliberately not a merge. `file` is a repo-relative path; `statement` is matched as a substring of the site's
 * whitespace-collapsed statement (never a line number, which moves); `reviewed` is when the reason was last checked against the code.
 *
 * @type {ReadonlyArray<{ file: string, statement: string, reason: string, reviewed: string }>}
 */
export const PROPERTIES_WRITE_EXCEPTIONS = Object.freeze([
  // Synced arrivals: the record is the SENDER's, converged by seq, never merged with this instance's copy.
  { file: 'server/src/sync/fill-file-meta.ts', statement: "set['properties'] = { $ifNull: ['$properties'", reviewed: REVIEWED,
    reason: 'a synced arrival fills the field only when this instance has none; the sender\'s record decides, not a merge' },
  // Response and input shapes: not a store write at all.
  { file: 'server/src/brain/recall-graph.ts', statement: "rec['properties'] = ent.properties", reviewed: REVIEWED, reason: 'builds a recall answer, writes no store' },
  { file: 'server/src/mcp/tools/shared.ts', statement: "common['properties'] = r.properties", reviewed: REVIEWED, reason: 'builds a tool answer, writes no store' },
  { file: 'server/src/mcp/tools/chrono.ts', statement: "updates['properties'] = a['properties']", reviewed: REVIEWED, reason: 'collects the tool\'s arguments; the store function it calls merges' },
  // The deleteFields path: the bag is re-read from the merged copy AFTER the merge, with the deleted keys already removed from it.
  { file: 'server/src/brain/entities.ts', statement: "newProps = merged['properties']", reviewed: REVIEWED, reason: 'deleteFields re-assignment: `merged` is the merge result with the deleted paths removed' },
  { file: 'server/src/brain/entities.ts', statement: 'newProps = {}', reviewed: REVIEWED, reason: 'deleteFields removed the whole bag (the `$unset` beside it)' },
  { file: 'server/src/brain/edges.ts', statement: "newProps = merged['properties']", reviewed: REVIEWED, reason: 'deleteFields re-assignment: `merged` is the merge result with the deleted paths removed' },
  { file: 'server/src/brain/edges.ts', statement: 'newProps = undefined', reviewed: REVIEWED, reason: 'deleteFields removed the whole bag (the `$unset` beside it)' },
]);

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** From `at`, the expression up to the `,` `;` or closing bracket that ends it at its own depth. Strings are skipped. */
function expressionFrom(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return src.slice(at, i); depth--; }
    else if ((c === ',' || c === ';') && depth === 0) return src.slice(at, i);
  }
  return src.slice(at);
}

/** The text of the declaration that contains `at`: from the nearest column-0 declaration before it to the next one. */
function enclosingFunction(src, at) {
  const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|const\b|let\b|class\b)/gm;
  let start = 0;
  let end = src.length;
  for (let m; (m = decl.exec(src));) {
    if (m.index <= at) start = m.index;
    else { end = m.index; break; }
  }
  return src.slice(start, end);
}

/** The statement containing `at`, coarsely: back to the previous `;` (or the `{` of a block) at the same depth, forward to the end of the expression. */
function statementWindow(src, at) {
  let s = at;
  let depth = 0;
  for (; s > 0; s--) {
    const c = src[s - 1];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) depth--;
      // A `{` after `(` `,` `:` `=` `[` `?` or `return` opens an object literal, part of the statement; any other `{` opens a block, which ends the search.
      else if (c === '{' && !/(?:[(,:=[?]|\breturn|\.\.\.)\s*$/.test(src.slice(Math.max(0, s - 20), s - 1))) break;
    } else if (c === ';' && depth === 0) break;
  }
  return src.slice(s, at + expressionFrom(src, at).length);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The bare variable a right-hand side names, once a cast (`x as T`) and parentheses are removed; null when it is anything else. */
function bareVariable(rhs) {
  const t = collapse(rhs).replace(/\s+as\s+[\w<>,\s|'"[\]{}.:]+$/, '').replace(/^\((.*)\)$/, '$1').trim()
    .replace(/^([A-Za-z_$][\w$]*)\.properties$/, '$1');   // `merged.properties`: the bag of a merge result `merged`
  return IDENT.test(t) ? t : null;
}

/** Whether a right-hand side stores the merge of the stored bag and the incoming one. `how.literal`: the site is an object-literal key. */
function satisfies(rhs, fn, how, seen = new Set()) {
  if (MERGE_CALL.test(rhs)) return { ok: true };
  if (STAGE_CALL.test(rhs)) {
    if (how.literal) return { ok: true };
    return { ok: false, why: 'the stage `mergePropertiesStage(` is assigned into a plain `$set` bag; only an object-literal key of a pipeline `$set` can hold it' };
  }
  const v = bareVariable(rhs);
  if (!v) return { ok: false, why: `the right-hand side \`${collapse(rhs)}\` is neither a merge call nor a variable bound from one` };
  if (seen.has(v)) return { ok: true };
  seen.add(v);
  const assigns = [];
  const re = new RegExp(`(?<![\\w$.\\]])${v.replace(/\$/g, '\\$')}\\s*(?::\\s*[^=;(]+?)?\\s*=(?![=>])\\s*`, 'g');
  for (let m; (m = re.exec(fn));) {
    const r = expressionFrom(fn, m.index + m[0].length);
    assigns.push({ rhs: r, text: collapse(m[0] + r) });
  }
  if (assigns.length === 0) return { ok: false, why: `\`${v}\` is assigned nowhere in the function (a parameter or an import), so what it holds is not shown to be a merge` };
  const bad = [];
  for (const a of assigns) {
    const r = satisfies(a.rhs, fn, how, seen);
    if (!r.ok) bad.push({ text: a.text, why: r.why });
  }
  if (bad.length === 0) return { ok: true };
  return { ok: false, why: bad.map(b => `\`${v}\` is assigned \`${b.text}\`: ${b.why}`).join('; '), assignments: bad.map(b => b.text) };
}

/**
 * Every properties-write site in the given sources, with its verdict.
 *
 * @param {ReadonlyArray<{ file: string, text: string }>} files  `text` is the raw source (comments are stripped here)
 * @returns {Array<{ file: string, kind: 'assign' | 'literal', statement: string, ok: boolean, why?: string, assignment?: string }>}
 */
export function propertiesWriteSites(files) {
  const sites = [];
  const verdictOf = (v) => (v.ok ? { ok: true } : { ok: false, why: v.why, ...(v.assignments ? { assignments: v.assignments } : {}) });
  for (const { file, text: raw } of files) {
    const src = stripComments(raw);
    const assign = /(\$?[A-Za-z_][\w$]*)\s*\[\s*['"]properties['"]\s*\]\s*=(?![=>])\s*/g;
    for (let m; (m = assign.exec(src));) {
      if (m[1] === '$unset') continue;
      const rhs = expressionFrom(src, m.index + m[0].length);
      const fn = enclosingFunction(src, m.index);
      sites.push({ file, kind: 'assign', statement: collapse(m[0] + rhs), ...verdictOf(satisfies(rhs, fn, { literal: false })) });
    }
    // The store helper that sets a field unless `deleteFields` removed it (`brain/delete-fields.ts`): `setUnlessDeleted($set, $unset, 'properties', <rhs>, ...)`.
    const helper = /\bsetUnlessDeleted\(\s*[^,()]+,\s*[^,()]+,\s*['"]properties['"]\s*,\s*/g;
    for (let m; (m = helper.exec(src));) {
      const rhs = expressionFrom(src, m.index + m[0].length);
      sites.push({ file, kind: 'assign', statement: collapse(`$set['properties'] = ${rhs}`),
        ...verdictOf(satisfies(rhs, enclosingFunction(src, m.index), { literal: false })) });
    }
    const literal = /(?<![\w$.'"\]])properties(?:\s*:\s*|(?=\s*[,}]))/g;
    for (let m; (m = literal.exec(src));) {
      const valueForm = /:\s*$/.test(m[0]);
      if (!STORE_WRITE.test(statementWindow(src, m.index))) continue;
      const rhs = valueForm ? expressionFrom(src, m.index + m[0].length) : 'properties';
      // A type annotation or a schema (`properties: Record<...>`, `properties: { type: ...`) is not a value.
      if (valueForm && /^(?:Record<|\{\s*type\s*:|\{\s*\$ref)/.test(collapse(rhs))) continue;
      const fn = enclosingFunction(src, m.index);
      const verdict = valueForm ? satisfies(rhs, fn, { literal: true }) : { ok: false, why: 'the shorthand `properties` stores the bag as it came' };
      sites.push({ file, kind: 'literal', statement: collapse(`properties: ${rhs}`), ...verdictOf(verdict) });
    }
  }
  return sites;
}

/**
 * The sites that store a bag without merging and are not named exceptions, plus any exception that excuses nothing.
 *
 * @returns {string[]} one message per problem; empty means every site merges
 */
export function unmergedPropertiesWrites(files, exceptions = PROPERTIES_WRITE_EXCEPTIONS) {
  const sites = propertiesWriteSites(files);
  const problems = [];
  const used = new Set();
  for (const s of sites) {
    if (s.ok) continue;
    // A site fed by a variable is excused assignment by assignment: every raw assignment needs its own named exception.
    const whole = exceptions.findIndex(e => e.file === s.file && s.statement.includes(e.statement));
    if (whole >= 0) { used.add(whole); continue; }
    const needs = s.assignments ?? [s.statement];
    const matched = needs.map(n => exceptions.findIndex(e => e.file === s.file && n.includes(e.statement)));
    matched.filter(i => i >= 0).forEach(i => used.add(i));
    if (!matched.includes(-1)) continue;
    problems.push(`${s.file}: \`${s.statement}\` stores a properties bag without merging it (${s.why}) — replacing it destroys keys the caller never named`);
  }
  // Checked only for files the run read: a planted-case run passes its own list and a few sources.
  exceptions.forEach((e, i) => {
    if (!used.has(i) && files.some(f => f.file === e.file)) {
      problems.push(`exception for ${e.file} (\`${e.statement}\`: ${e.reason}) excuses no site any more — remove it`);
    }
  });
  return problems;
}
