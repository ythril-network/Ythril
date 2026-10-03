/**
 * Which functions WRITE A SPACE — derived from the writes themselves, through whatever alias reaches them.
 *
 * ## The question, and why a spelling is not enough to answer it
 *
 * `Q-97` wanted a gate over *"a read door never writes a space"*, and the first thing it needed was the set
 * of writers. The obvious derivation reads `col(…).updateOne(` and stops — and on the tree it was written
 * against that spelling matched about a third of the real sites: the rest wrote through a const alias
 * (`const coll = col(…)`, `await coll.updateOne(…)`), a helper that returns a collection, or
 * `db.collection(…)`. A writer set that sees a third of the writers passes a floor set above zero and
 * concludes about all of them.
 *
 * So the receiver of every mutator is resolved back to the collection it names, through:
 *
 * - `col(name)` and `….collection(name)` — the two ways a collection is opened;
 * - a local or module-level binding of either (`const c = col(…)`), followed as far as it goes;
 * - a helper that RETURNS one (`jobs(spaceId).updateOne(…)`, `function jobs(s) { return col(…) }`), in the
 *   helper's own file, through the call graph's import resolution.
 *
 * ## What "a space" means here, which is the judgement the module holds so a gate does not
 *
 * - **space**: a name built by `spaceCollection(…)` or as `` `${id}_…` `` — the per-space collections — and
 *   `ythril_counters`, whose rows are keyed by space id: it is the space's sequence counter (`nextSeq`,
 *   `bumpSeq`), and advancing it is a write every peer's sync position depends on.
 * - **files**: a filesystem mutation (write, rename, remove, mkdir…) inside `server/src/files/`, or in a body
 *   that addresses the space's file tree (`spaceRoot(…)`, `resolveSafePath`, a `'files'` or `'.chunks'`
 *   segment); and a call from `files/` into a `util/` filesystem primitive (`mkdirPrivate`, `harden…`).
 * - **global** / **local**: an instance-level collection (audit, metrics, rate limits, the spill store,
 *   webhooks) or a filesystem write outside the space tree (config, logs, backups). Recorded, not a writer:
 *   a read that writes its own audit line or a local cache has not written the space.
 * - **unknown**: a receiver that resolves to neither — a parameter, a loop variable, `this.x`. **Counted as
 *   a writer**, deliberately: the safe direction for a gate is a finding a person reads, not a pass.
 *
 * ## The guards a hand-written copy drops
 *
 * **The floors.** Each kind is asserted to hold at least as many sites as it had when this was written, and
 * the alias-resolved sites separately — because the alias path is the one that silently stops working when
 * a regex is edited, and it is two thirds of the set.
 *
 * **The orphans.** A mutator the index cannot attribute to ANY function — one in a class method, or in a
 * shape the parser does not read — is a writer no walk can reach, so a gate built on this would pass over
 * it. `spaceWriters` returns them, and a gate asserts there are none on a space.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argumentsOf } from './_structural-window.mjs';
import { callSitesIn } from './_call-graph.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { SPACE_COLLECTIONS } from '../../server/dist/db/space-collection.js';

/** Every MongoDB driver method that changes a document. */
export const MUTATORS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate',
  'findOneAndReplace', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'bulkWrite'];

/** Every `node:fs` method that changes the filesystem. `open` counts only with a writing flag. */
const FS_MUTATORS = ['writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'mkdir', 'copyFile', 'cp',
  'utimes', 'truncate', 'createWriteStream', 'symlink', 'link', 'chmod', 'mkdtemp',
  'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'mkdirSync',
  'copyFileSync', 'cpSync', 'chmodSync', 'utimesSync', 'truncateSync', 'symlinkSync', 'mkdtempSync'];

const MUTATOR_CALL = new RegExp(`\\.\\s*(${MUTATORS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');

/** The kinds a gate must treat as a write into a space. */
export const SPACE_KINDS = new Set(['space', 'files', 'unknown']);

const SPACE_COUNTERS = 'ythril_counters';

/**
 * Every write site in the index, classified, and the ones no function owns.
 *
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} index  after any synthetic door bodies are
 *   registered, so a write inside an inline route handler is attributed to that route.
 * @param {{floors?: Record<string, number>}} [opts]  the fewest sites of each kind, and of alias-resolved
 *   space sites (`alias`), that may be found before this throws. Raise them as the tree grows; never lower
 *   one to make a run pass.
 * @returns {{ sites: object[], byKey: Map<string, object[]>, orphans: object[] }}
 */
export function spaceWriters(index, { floors = {} } = {}) {
  const sites = [];
  const byKey = new Map();
  const add = (key, site) => {
    sites.push(site);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(site);
  };

  for (const [key, entry] of index.bodies) {
    if (entry.alias) continue;
    const scope = { file: entry.file, body: entry.body, src: index.sources.get(entry.file) };
    for (const m of entry.body.matchAll(MUTATOR_CALL)) {
      const receiver = receiverBefore(entry.body, m.index);
      const verdict = classifyReceiver(index, receiver, scope, 0);
      add(key, { key, file: entry.file, line: siteLine(index, entry, m.index + m[0].length), op: m[1],
        receiver: receiver.replace(/\s+/g, ' ').slice(0, 90), ...verdict });
    }
    for (const w of fsWritesIn(entry.body, scope.src)) {
      const files = entry.file.startsWith('server/src/files/') || FILE_TREE.test(entry.body);
      add(key, { key, file: entry.file, line: siteLine(index, entry, w.at + w.op.length + 1), op: w.op, receiver: w.receiver,
        kind: files ? 'files' : 'local', alias: false,
        why: files ? 'a filesystem write on the space file tree' : 'a filesystem write outside the space file tree' });
    }
  }

  // A `files/` body that hands its path to a `util/` filesystem primitive writes the file tree through it.
  const fsPrimitives = new Set([...byKey].filter(([k, list]) => k.startsWith('server/src/util/')
    && list.some(s => s.kind === 'local')).map(([k]) => k));
  for (const [key, entry] of index.bodies) {
    if (!entry.file.startsWith('server/src/files/') || entry.alias) continue;
    // The call graph's own positioned scan: a hand-written `(^|[^.\w$])name\(` here consumed the `(` a call
    // nested as an argument needs, the same defect `Q-309` fixed in `_call-graph.mjs`.
    for (const call of callSitesIn(entry.body, { closures: true })) {
      const target = index.resolve(entry.file, call.name);
      if (!target || !fsPrimitives.has(target)) continue;
      add(key, { key, file: entry.file, line: siteLine(index, entry, call.paren + 1), op: call.name,
        receiver: target, kind: 'files', alias: false, why: `a util filesystem primitive called from files/` });
    }
  }

  // An alias (`handle: handleRecall`) writes whatever its target writes; the walk may reach either key.
  for (const [key, entry] of index.bodies) if (entry.alias && byKey.has(entry.alias)) byKey.set(key, byKey.get(entry.alias));

  const orphans = [];
  const spans = new Map();
  for (const entry of index.bodies.values()) {
    if (!spans.has(entry.file)) spans.set(entry.file, []);
    spans.get(entry.file).push([entry.start, entry.end]);
  }
  for (const [file, src] of index.sources) {
    const own = spans.get(file) ?? [];
    for (const m of src.matchAll(MUTATOR_CALL)) {
      if (own.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const verdict = classifyReceiver(index, receiverBefore(src, m.index), { file, body: '', src }, 0);
      orphans.push({ file, line: lineOf(file, src, m.index), op: m[1], ...verdict });
    }
  }

  const count = kind => sites.filter(s => s.kind === kind).length;
  const found = { space: count('space'), files: count('files'), global: count('global'), unknown: count('unknown'),
    alias: sites.filter(s => s.kind === 'space' && s.alias).length };
  for (const [kind, floor] of Object.entries(floors)) {
    // THROWS rather than returning a thin set: a writer set that stopped matching makes every door clean.
    assert.ok(found[kind] >= floor,
      `the writer derivation found ${found[kind]} '${kind}' site(s), below the floor of ${floor} `
      + `(found: ${JSON.stringify(found)}). The derivation is broken, not the code — a thin writer set makes `
      + 'every read door report clean about writes it never saw.');
  }
  return { sites, byKey, orphans, found };
}

/** A body that addresses the space file tree by one of its roots. */
const FILE_TREE = /\bspaceRoot\s*\(|\bresolveSafePath\w*\s*\(|['"]files['"]|['"]\.chunks['"]/;

/**
 * The line in the RAW file of the site at `idx` in `entry.body` — the index reads comment-stripped source,
 * whose line numbers are not the ones a reader opens. A door's synthetic body is its arguments re-joined,
 * so the site is found again in the source by the text just before it rather than by offset.
 */
function siteLine(index, entry, idx) {
  const src = index.sources.get(entry.file);
  const from = Math.max(entry.body.lastIndexOf('\n', idx - 1) + 1, idx - 40);
  const snippet = entry.body.slice(from, idx);
  const at = snippet.trim() ? src.indexOf(snippet, entry.start) : -1;
  return lineOf(entry.file, src, at >= 0 ? at + snippet.length - 1 : entry.start + idx - 1);
}

const RAW = new Map();

function lineOf(file, src, at) {
  let n = 1;
  let lineStart = 0;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === '\n') { n++; lineStart = i + 1; }
  const end = src.indexOf('\n', lineStart);
  const text = src.slice(lineStart, end < 0 ? src.length : end).trim();
  if (!RAW.has(file)) RAW.set(file, readFileSync(join(REPO_ROOT, file), 'utf8').split(/\r?\n/));
  const raw = RAW.get(file);
  // Stripping only removes lines, so the raw line is at or after the stripped one.
  for (let i = n - 1; text && i < raw.length; i++) if (raw[i].includes(text)) return i + 1;
  return n;
}

/**
 * The receiver expression ending just before the `.` at `dot` — `col<T>(spaceCollection(id, 'facts'))`,
 * `coll`, `getDb().collection(name)`, `jobs(spaceId)` — walked backwards over balanced brackets and dots.
 */
export function receiverBefore(text, dot) {
  let i = dot - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  const end = i + 1;
  for (;;) {
    if (text[i] === ')') {
      i = openerBefore(text, i, '(', ')');
      if (i < 0) break;
      i--;
      while (i >= 0 && /\s/.test(text[i])) i--;
      if (text[i] === '>') { i = openerBefore(text, i, '<', '>'); if (i < 0) break; i--; }
      while (i >= 0 && /\s/.test(text[i])) i--;
    }
    if (text[i] === ']') { i = openerBefore(text, i, '[', ']'); if (i < 0) break; i--; }
    let j = i;
    while (j >= 0 && /[\w$]/.test(text[j])) j--;
    i = j;
    let k = i;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (text[k] === '.' || (text[k] === '.' && text[k - 1] === '?')) {
      i = k - 1;
      if (text[i] === '?') i--;
      while (i >= 0 && /\s/.test(text[i])) i--;
      continue;
    }
    break;
  }
  return text.slice(i + 1, end).trim();
}

function openerBefore(text, close, open, shut) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (text[i] === shut) depth++;
    else if (text[i] === open) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `{ kind, why, alias }` for the collection a receiver expression names. */
function classifyReceiver(index, raw, scope, depth) {
  const recv = raw.replace(/^\(?\s*await\s+/, '').replace(/^\((.*)\)$/s, '$1').trim();
  if (depth > 8) return { kind: 'unknown', alias: depth > 0, why: `gave up resolving ${recv} after ${depth} hops` };
  const call = tailCall(recv);
  if (call) {
    if (isOpen(index, scope.file, call.callee)) {
      const v = classifyName(index, call.args[0] ?? '', scope, depth);
      return { ...v, alias: depth > 0 };
    }
    if (/^[A-Za-z_$][\w$]*$/.test(call.callee)) {
      const v = classifyHelper(index, call.callee, scope, depth + 1);
      if (v) return { ...v, alias: true };
    }
    return { kind: 'unknown', alias: depth > 0, why: `a receiver opened by ${call.callee}(…), which does not resolve to a collection` };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(recv)) {
    const bound = bindingOf(index, recv, scope);
    if (bound) {
      const v = classifyReceiver(index, bound.expr, bound.scope, depth + 1);
      return { ...v, alias: true };
    }
    return { kind: 'unknown', alias: true, why: `\`${recv}\` is a parameter or an unbound name` };
  }
  return { kind: 'unknown', alias: depth > 0, why: `the receiver \`${recv.slice(0, 60)}\` is not an open, an alias or a helper` };
}

/** `{ kind, why }` for the NAME expression handed to `col(…)` / `.collection(…)`. */
function classifyName(index, raw, scope, depth) {
  const expr = raw.trim();
  // `collection` is the suffix a space collection is stored under (`file_hashes`), so a caller can tell one
  // space collection from another without re-reading the site — `null` when the name is computed.
  const part = /\bspaceCollection\s*\([^,]*,\s*['"](\w+)['"]\s*\)/.exec(expr);
  if (/\bspaceCollection\s*\(/.test(expr)) {
    return { kind: 'space', why: `spaceCollection(…, ${part ? `'${part[1]}'` : '…'})`, collection: part ? SPACE_COLLECTIONS[part[1]] ?? null : null };
  }
  const suffix = /`[^`]*\$\{[^}]*\}_(\w*)`/.exec(expr);
  if (/`[^`]*\$\{[^}]*\}_/.test(expr)) return { kind: 'space', why: 'a `${id}_…` name', collection: suffix && suffix[1] ? suffix[1] : null };
  const literal = /^(['"`])([^'"`$]*)\1$/.exec(expr);
  if (literal) {
    return literal[2] === SPACE_COUNTERS
      ? { kind: 'space', why: `${SPACE_COUNTERS}, the per-space sequence counter` }
      : { kind: 'global', why: `the instance collection '${literal[2]}'` };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr) && depth < 8) {
    const bound = bindingOf(index, expr, scope);
    if (bound) return classifyName(index, bound.expr, bound.scope, depth + 1);
    return { kind: 'unknown', why: `the collection name \`${expr}\` is a parameter or an unbound name` };
  }
  return { kind: 'unknown', why: `the collection name \`${expr.slice(0, 60)}\` is not a literal, a template or spaceCollection` };
}

/** The verdict for a helper that returns a collection, read from its `return`s, or null if it is not one. */
function classifyHelper(index, name, scope, depth) {
  const key = index.resolve(scope.file, name);
  let returns = [];
  let helperScope;
  if (key) {
    const entry = index.bodies.get(key);
    helperScope = { file: entry.file, body: entry.body, src: index.sources.get(entry.file) };
    returns = [...entry.body.matchAll(/\breturn\s+/g)].map(m => expressionFrom(entry.body, m.index + m[0].length));
  } else {
    // A concise arrow is not a top-level function the index holds: `const jobs = (s) => col(…)`.
    const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:const|let)\\s+${name}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]*?)?=>\\s*(?!\\{)`).exec(scope.src);
    if (!m) return null;
    helperScope = { file: scope.file, body: '', src: scope.src };
    returns = [expressionFrom(scope.src, m.index + m[0].length)];
  }
  const verdicts = returns.filter(r => r.length > 0).map(r => classifyReceiver(index, r, helperScope, depth));
  if (verdicts.length === 0) return null;
  const hit = verdicts.find(v => v.kind === 'space') ?? verdicts.find(v => v.kind === 'unknown');
  if (hit) return { kind: hit.kind, why: `${name}(…) returns ${hit.why}`, collection: hit.collection ?? null };
  return { kind: 'global', why: `${name}(…) returns ${verdicts[0].why}` };
}

/** `recv` as `{ callee, args }` when it ends in a call, else null. */
function tailCall(recv) {
  if (!recv.endsWith(')')) return null;
  const open = openerBefore(recv, recv.length - 1, '(', ')');
  if (open <= 0) return null;
  let callee = recv.slice(0, open).trim();
  if (callee.endsWith('>')) {
    const lt = openerBefore(callee, callee.length - 1, '<', '>');
    if (lt > 0) callee = callee.slice(0, lt).trim();
  }
  let args = [];
  try { args = argumentsOf(recv, open, 'a receiver call'); } catch { args = []; }
  return { callee, args };
}

/**
 * The expression bound to `name` — in the enclosing body first (the nearest binding), then at module level.
 * Only `const`/`let`/`var` with an initializer; a parameter or a `for (const x of …)` has none, and that is
 * what makes it `unknown` rather than guessed.
 */
function bindingOf(index, name, scope) {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=;]+?)?=(?![=>])`, 'g');
  for (const text of [scope.body, scope.src]) {
    if (!text) continue;
    const all = [...text.matchAll(pattern)];
    if (all.length === 0) continue;
    const m = all[all.length - 1];
    const expr = expressionFrom(text, m.index + m[0].length);
    if (expr) return { expr, scope: { ...scope, body: text === scope.body ? scope.body : '' } };
  }
  // An imported constant (`import { AUDIT_COLLECTION } from './x.js'`) is bound in the file it came from.
  const imported = index.imports.get(scope.file)?.get(name);
  if (imported && imported.file !== scope.file) {
    const there = { file: imported.file, body: '', src: index.sources.get(imported.file) };
    if (there.src) return bindingOf(index, imported.exported, there);
  }
  return null;
}

/**
 * Is `callee` a collection OPEN — the `col` of `db/mongo.ts`, or a `.collection` method — rather than a
 * local helper that shares the spelling? `audit.ts` declares its own `col()` returning the audit
 * collection, and reading that as the open would ask which collection the empty string names.
 */
function isOpen(index, file, callee) {
  if (/\.\s*collection$/.test(callee)) return true;
  if (callee !== 'col') return false;
  const key = index.resolve(file, 'col');
  return key === null || key === 'server/src/db/mongo.ts:col';
}

/** The expression starting at `at`, up to the `;` or statement-ending newline at its own depth. */
function expressionFrom(text, at) {
  let depth = 0;
  let i = at;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === '\n') {
      const before = text.slice(at, i).trimEnd();
      const after = text.slice(i).trimStart();
      if (!/[=(,?:|&+\-*/<>.]$/.test(before) && !/^[.?:|&+\-*/]/.test(after)) break;
    }
    i++;
  }
  return text.slice(at, i).trim();
}

/**
 * Every filesystem mutation in a body, through the names this FILE imported `node:fs` under — a default or
 * namespace import (`fs.rm(…)`, `fs.promises.rm(…)`), `promises as fsp`, or a named mutator (`rm(…)`).
 */
function fsWritesIn(body, src) {
  const objects = new Set();
  const named = new Map();
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) objects.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) {
    for (const part of m[1].split(',')) {
      const p = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (!p) continue;
      if (p[1] === 'promises') objects.add(p[2] ?? p[1]);
      else if (FS_MUTATORS.includes(p[1]) || p[1] === 'open') named.set(p[2] ?? p[1], p[1]);
    }
  }
  const out = [];
  const opens = ['open', 'openSync'];
  if (objects.size > 0) {
    // Lookbehind, not a consumed prefix character: `x(fs.rm(…))` must not lose the inner call (`Q-309`). Not
    // `memberCallSitesIn`, which reads `obj.prop(` only — `fs.promises.rm(` is one hop longer.
    const re = new RegExp(`(?<![.\\w$])(${[...objects].join('|')})\\s*(?:\\.\\s*promises\\s*)?\\.\\s*(${[...FS_MUTATORS, ...opens].join('|')})\\s*\\(`, 'g');
    for (const m of body.matchAll(re)) {
      if (opens.includes(m[2]) && !writingFlag(body, m.index + m[0].length - 1)) continue;
      out.push({ at: m.index, op: m[2], receiver: m[1] });
    }
  }
  if (named.size > 0) {
    for (const call of callSitesIn(body, { closures: true })) {
      const exported = named.get(call.name);
      if (!exported) continue;
      if (opens.includes(exported) && !writingFlag(body, call.paren)) continue;
      out.push({ at: call.at, op: exported, receiver: 'node:fs' });
    }
  }
  return out;
}

/** Does the `open(…)` whose paren is at `paren` pass a flag that writes? */
function writingFlag(body, paren) {
  let args = [];
  try { args = argumentsOf(body, paren, 'an fs open'); } catch { return true; }
  const flag = args[1] ?? '';
  return !/^['"]r['"]$/.test(flag.trim()) && flag.trim() !== '';
}
