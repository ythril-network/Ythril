/**
 * The brain write capabilities that judge an unknown top-level field, and what each door's handler READS.
 *
 * ## The question this answers, and why it is a module
 *
 * "Which REST route and which MCP tool are the two doors of one brain write, and which body keys does each of their
 * handlers actually read?" Three gates ask it (`a-route-reads-what-its-tool-declares`, `a-route-judges-before-it-checks-the-body`,
 * `the-at-least-one-sentence-has-one-spelling`). Each would otherwise carry its own pair table and its own reader, and a
 * reader that misses a spelling makes its gate report clean about a key it never saw — the defect this repo names most
 * (`CLAUDE.md`, "A gate concludes about MORE than it checks").
 *
 * ## What it refuses to do quietly, which is the half a hand-written copy drops
 *
 * A handler that hands the WHOLE body (`req.body`, or `a` in a tool) to a function not named in {@link HELPER_KEYS} is a
 * FAILURE of the read, never an empty one: a helper can read any key it likes, so a reader that skipped it would call the
 * handler's reads complete. The same goes for a spread, a computed key and an alias (`const body = req.body`). The
 * helper map is the one place a new helper is declared, with what it reads.
 *
 * Everything is read from comment-stripped source (`_strip-comments.mjs`), and string contents are masked before a token is
 * looked for, so a sentence in an error message that happens to contain `a` or `req.body` is not a read.
 */
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { balancedFrom, blockAfter } from './_structural-window.mjs';

/**
 * The pairs, NAMED — the same way `a-tool-and-its-route-take-the-same-parameters` names its subjects. The set is not
 * derivable from one registry (a route has no operation until the audit rules name it), so it is listed here ONCE and
 * checked against the registries by `a-route-reads-what-its-tool-declares` (every pair resolves to a registered route and
 * a registered tool, the tool's operation is the pair's, and no judged operation is missing from this list).
 *
 * `kind` is the record kind whose link classes bound what the connection helpers read.
 */
export const BRAIN_WRITE_PAIRS = Object.freeze([
  { op: 'fact.create', tool: 'save_fact', method: 'POST', route: '/api/brain/spaces/:spaceId/facts', kind: 'fact' },
  { op: 'fact.update', tool: 'update_fact', method: 'PATCH', route: '/api/brain/spaces/:spaceId/facts/:id', kind: 'fact' },
  { op: 'entity.create', tool: 'save_entity', method: 'POST', route: '/api/brain/spaces/:spaceId/entities', kind: 'entity' },
  { op: 'entity.update', tool: 'update_entity', method: 'PATCH', route: '/api/brain/spaces/:spaceId/entities/:id', kind: 'entity' },
  { op: 'entity.merge', tool: 'graph_merge', method: 'POST', route: '/api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId', kind: 'entity' },
  { op: 'edge.create', tool: 'save_edge', method: 'POST', route: '/api/brain/spaces/:spaceId/edges', kind: 'edge' },
  { op: 'edge.update', tool: 'update_edge', method: 'PATCH', route: '/api/brain/spaces/:spaceId/edges/:id', kind: 'edge' },
  { op: 'chrono.create', tool: 'save_chrono', method: 'POST', route: '/api/brain/spaces/:spaceId/chrono', kind: 'chrono' },
  { op: 'chrono.update', tool: 'update_chrono', method: 'PATCH', route: '/api/brain/spaces/:spaceId/chrono/:id', kind: 'chrono' },
  { op: 'link.create', tool: 'save_link', method: 'POST', route: '/api/brain/spaces/:spaceId/links', kind: 'link' },
  { op: 'file.meta.update', tool: 'update_file_meta', method: 'PATCH', route: '/api/brain/spaces/:spaceId/files', kind: 'file' },
  { op: 'bulk.write', tool: 'save_bulk', method: 'POST', route: '/api/brain/spaces/:spaceId/bulk', kind: 'bulk' },
]);

/** The pairs whose body is a single record's, which is every one but `bulk.write` (its items are judged per collection). */
export const RECORD_PAIRS = Object.freeze(BRAIN_WRITE_PAIRS.filter(p => p.op !== 'bulk.write'));

/**
 * What a function reads out of the body it is HANDED, by name. A name missing from here is a failure of the read.
 *
 * `keys` is an array of body keys it reads. `connection` marks the helpers that walk the link fields and `edges`: what
 * they read is the link classes the record kind holds and `edges`, which is what the tool's `connectionSchemas(kind)`
 * declares. `needsKind` marks the ones design-v3 2.4 bounds by a REQUIRED `kind` argument, so a call that passes none is a
 * defect of its own (it reads every class, including ones the kind cannot hold).
 */
export const HELPER_KEYS = Object.freeze({
  ttlDaysError: { keys: ['ttlDays'] },
  ttlDaysFromBody: { keys: ['ttlDays'] },
  ttlDaysFromArgs: { keys: ['ttlDays'] },
  // Reads the record tier as well (_shared.ts): suppressEmbeddings and superseded ride through it on every create.
  dupeCheckOptsFromBody: { keys: ['checkDuplicates', 'checkContradictions', 'dupeThreshold', 'suppressEmbeddings', 'superseded'] },
  parseRecordSuppression: { keys: ['suppressEmbeddings'] },
  parseRecordSuperseded: { keys: ['superseded'] },
  parseRecordFlags: { keys: ['suppressEmbeddings', 'superseded'] },
  // Validates the VALUES of fields the handler names itself, from a table; it reads no key the handler does not.
  shapeError: { keys: [] },
  // The judge reports on the body; it is not the write reading a field.
  answerUnknownWriteFields: { keys: [] },
  unknownFieldWarnings: { keys: [] },
  carriesAnyAcceptedField: { keys: [] },
  atLeastOneFieldRefusal: { keys: [] },
  desiredLinksFrom: { connection: 'links', needsKind: true },
  linkFieldsFrom: { connection: 'links', needsKind: true },
  linkInputError: { connection: 'links', needsKind: true },
  linkAuditSnapshots: { connection: 'links', needsKind: true },
  edgeInputsFrom: { connection: 'edges' },
  edgeInputError: { connection: 'edges' },
  connectionInputError: { connection: 'both' },
  connectionSubject: { connection: 'both' },
  assertConnections: { connection: 'both' },
  applyConnections: { connection: 'both' },
  connectionsOf: { connection: 'both' },
  // Reads the link classes the edit names, to snapshot them for the audit row (`brain/edit-audit.ts`).
  readEditAudit: { connection: 'links' },
});

/** The helper names that must be called with a record kind. */
export const KIND_BOUNDED_HELPERS = Object.freeze(Object.entries(HELPER_KEYS).filter(([, v]) => v.needsKind).map(([k]) => k));

/**
 * `src` with the CONTENT of every string and template literal blanked to spaces (length and newlines kept, so an offset in
 * the result is an offset in `src`). `${ … }` inside a template is code and is left alone.
 */
export function maskStrings(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') i = maskQuoted(src, i, blank);
    else if (c === '`') i = maskTemplate(src, i + 1, blank);
    else i++;
  }
  return out.join('');
}

/** Blank a quoted string whose opening quote is at `i`; returns the index after the closing quote. */
function maskQuoted(src, i, blank) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') blank(j++); blank(j++); }
  return j + 1;
}

/** Blank a template body from `i` (just past the backtick) to its closing backtick, returning the index after it. */
function maskTemplate(src, i, blank) {
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      // Code inside the substitution: walk to its matching brace, masking strings and nested templates in it.
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) { i++; break; } }
        else if (d === '`') { i = maskTemplate(src, i + 1, blank); continue; }
        else if (d === "'" || d === '"') { i = maskQuoted(src, i, blank); continue; }
        i++;
      }
      continue;
    }
    blank(i);
    i++;
  }
  return i;
}

/** The registered route a pair names, with its comment-stripped handler source; throws when none is registered. */
let routeRows;
export function restHandlerOf(pair, routes = (routeRows ??= mountedRoutesWithSource())) {
  const row = routes.find(r => r.method === pair.method && r.path === pair.route);
  if (!row) throw new Error(`${pair.op}: no registered route ${pair.method} ${pair.route}`);
  return row;
}

/** Every MCP tool source file, comment-stripped, keyed by path. */
let toolSources;
function toolFiles() {
  toolSources ??= new Map(trackedSources(['server/src/mcp/tools'], { floor: 10 })
    .map(f => [f, stripComments(readFileSync(f, 'utf8'))]));
  return toolSources;
}

/**
 * The tool's own source: `{ file, object, handle }`, where `handle` is the BODY of its `handle(ctx)` method. Bounded by
 * braces, so it holds the whole method however long it grows (and `object` holds its schema as well).
 */
export function toolHandlerOf(toolName) {
  const needle = new RegExp(`\\bname:\\s*'${toolName}'\\s*,`);
  const hits = [...toolFiles()].filter(([, s]) => needle.test(s));
  if (hits.length !== 1) throw new Error(`${toolName}: expected exactly one tool source declaring it, found ${hits.length}`);
  const [file, src] = hits[0];
  const at = src.search(needle);
  const open = src.lastIndexOf('= {', at);
  if (open < 0) throw new Error(`${toolName}: no object literal opens before its name`);
  const object = balancedFrom(src, open + 2, `${toolName}: the tool object`);
  const hm = /\bhandle\s*\(/.exec(object);
  if (!hm) throw new Error(`${toolName}: the tool declares no handle()`);
  const handle = blockAfter(object, object.indexOf(')', hm.index), `${toolName}: the handle body`);
  return { file, object, handle };
}

/** The identifier a tool handler binds the arguments to (`const { args: a, … } = ctx`), or null when it binds none. */
export function argsIdentifier(handleSrc) {
  const m = /\bargs:\s*([A-Za-z_$][\w$]*)/.exec(handleSrc) ?? /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.args\b/.exec(handleSrc);
  return m ? m[1] : null;
}

/** The innermost call that `at` is an argument of, skipping grouping parentheses; null when there is none. */
function enclosingCall(masked, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) { depth--; continue; }
      if (c !== '(') return null;
      let j = i - 1;
      while (j >= 0 && /\s/.test(masked[j])) j--;
      const end = j + 1;
      while (j >= 0 && /[\w$.]/.test(masked[j])) j--;
      const callee = masked.slice(j + 1, end).replace(/^\.+/, ''); // `...spread(` is a call to `spread`
      // A grouping paren — `(req.body ?? {}) as X`, `(a) =>` — has no callee of its own; look one level further out.
      if (callee === '' || /^(if|while|for|switch|return|await|typeof|void)$/.test(callee)) continue;
      return { callee, open: i };
    }
  }
  return null;
}

/**
 * Every body key a handler reads, from `subject` (`req.body`, or the identifier a tool binds its arguments to).
 *
 * @returns {{ keys: Set<string>, handed: {callee: string, args: string[]}[], problems: string[] }}
 *   `problems` are reads the reader cannot attribute to a key (an alias, a spread, a computed key, a rest element): each
 *   one is a reason the handler's reads are NOT known, and a caller must fail on it, never treat it as "reads nothing".
 */
export function readsOf(src, subject) {
  const masked = maskStrings(src);
  const keys = new Set();
  const handed = [];
  const problems = [];
  const re = subject === 'req.body'
    ? /\breq\.body\b/g
    : new RegExp(`(?<![\\w$.'"])${subject.replace(/[$.]/g, '\\$&')}(?![\\w$])`, 'g');
  const near = (at, end) => src.slice(Math.max(0, at - 30), end + 20).replace(/\s+/g, ' ');
  for (const m of masked.matchAll(re)) {
    const at = m.index;
    const end = at + m[0].length;
    const before = masked.slice(Math.max(0, at - 24), at);
    // The binding itself: `args: a`.
    if (/\bargs\s*:\s*$/.test(before)) continue;
    const rest = src.slice(end);
    let km;
    if ((km = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(rest))) { keys.add(km[1]); continue; }
    if ((km = /^\s*\??\.?\s*\[\s*(['"])([^'"]+)\1\s*\]/.exec(rest))) { keys.add(km[2]); continue; }
    if (/^\s*\??\.?\s*\[/.test(rest)) { problems.push(`a computed key read near \`${near(at, end)}\``); continue; }
    // A GUARD is not a read: `typeof req.body`, `!!req.body`, `req.body != null`, `req.body === 'object'`.
    if (/\btypeof\s+$|!!\s*$/.test(before) || /^\s*(?:!==?|===?)\s*(?:null\b|undefined\b|['"]object['"])/.test(src.slice(end, end + 30))) continue;
    // `'ttlDays' in req.body`
    if ((km = /(['"])([\w$]+)\1\s+in\s*\(?\s*$/.exec(src.slice(Math.max(0, at - 40), at)))) { keys.add(km[2]); continue; }
    // Destructure: `const { a, b = 1, c: d } = req.body ?? {}`
    const dm = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*(?::[^=]+)?=\s*\(?\s*$/.exec(src.slice(Math.max(0, at - 600), at));
    if (dm) {
      for (const part of splitTop(dm[1])) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith('...')) { problems.push(`a rest element \`${p}\` in a destructure of the body`); continue; }
        keys.add(p.split(/[:=]/)[0].trim());
      }
      continue;
    }
    if (/\.\.\.\s*$/.test(before)) { problems.push(`the body is spread near \`${near(at, end)}\``); continue; }
    const call = enclosingCall(masked, at);
    if (!call) { problems.push(`the body is aliased or used outside a call near \`${near(at, end)}\``); continue; }
    const list = balancedFrom(src, call.open);
    handed.push({ callee: call.callee, args: splitTop(list.slice(1, -1)).map(s => s.trim()) });
  }
  return { keys, handed, problems };
}

/** Split at the commas of the top level (not inside brackets or strings). */
export function splitTop(s) {
  const out = [];
  let depth = 0;
  let from = 0;
  const masked = maskStrings(s);
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out;
}