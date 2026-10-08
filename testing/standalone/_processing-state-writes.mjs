/**
 * Which writes to a space's FILES collection touch a field of a file's LOCAL PROCESSING STATE, and which fields each
 * one sets — the one answer for every gate that asks it (`Q-240`).
 *
 * ## The question, and why a spelling is not enough
 *
 * A file's `embeddingStatus` (and `mediaJobError`, `mediaType`, `chunkCount`, `convertedFileId`, `conversionError`)
 * records what THIS instance did with the bytes. It is neither hashed nor replicated, so a write that moves it must not
 * stamp `updatedAt`, which IS: the stamp makes two instances that agree about everything anybody wrote report a
 * `MERKLE_DIVERGENCE` over a status mark each of them made on its own. Nine writers did exactly that, each saying
 * `{ $set: { embeddingStatus, updatedAt: now } }` in its own place, because nothing made the one-line `updatedAt` the
 * thing a writer could not add.
 *
 * So the rule a gate states is "every write that touches these fields lives in one module", and asking it needs the
 * KEYS of each write — which `_record-writes.mjs` does not carry: it says a site writes the files collection, not what
 * it writes. This module resolves the keys of the update document of every such site.
 *
 * ## What it resolves, and what it refuses to guess
 *
 * - **An inline `$set` / `$unset` block** — the keys of the object literal, shorthand and quoted keys included.
 * - **A named update** — `$set: update` or `$set: metaUpdate`: the keys of the literal the name is declared with in
 *   the same function, plus every `name['key'] = …` / `name.key = …` assignment after it.
 * - **A spread** (`...x`) or a name it cannot find is UNRESOLVED, and an unresolved write is not read as clean: it
 *   counts as touching a processing field when the function it sits in names one anywhere outside a comment. The safe
 *   direction for a gate is a finding a person reads; a write the parser cannot read is a write nothing checks.
 * - **The processing fields are NOT listed here as a second copy of the answer** — they are the fields
 *   `files/processing-state.ts` types (`setFileProcessingState`), read from that module's own source once it exists,
 *   and the documented set until then. Both are asserted to be real `FileMetaDoc` fields that the divergence hash does
 *   NOT see (`FILE_HASH_PROJECTION` in `brain/merkle.ts`), so a field renamed or promoted into the hash fails here
 *   rather than being quietly dropped from the rule.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The pairing is asserted.** Sites come from `recordWrites` (aliases and helper-returned collections resolved);
 *   their line numbers are not trustworthy when one function holds several writes through the same spelling, so each
 *   is paired with the mutator call it came from in the function's own body, in order, and an op that disagrees throws.
 * - **A thin set throws.** `fileRowWrites` asserts a floor, because a predicate edited to match nothing makes every
 *   writer clean.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argumentsOf, balancedFrom } from './_structural-window.mjs';
import { MUTATORS, receiverBefore } from './_space-writers.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MERKLE = 'server/src/brain/merkle.ts';
const TYPES = 'server/src/config/types.ts';
const PROCESSING_STATE = 'server/src/files/processing-state.ts';

/**
 * The local processing state of a file row, until `processing-state.ts` states it itself.
 *
 * What the nine writers of `Q-240` write (plus the pointer the conversion records), and the fields the hash must never
 * see move with them. Once the module exists, `processingFields()` reads its typed argument instead and this is only
 * the floor the read is held to.
 */
const DOCUMENTED = Object.freeze(['embeddingStatus', 'mediaJobError', 'mediaType', 'chunkCount', 'convertedFileId', 'conversionError']);

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The fields of `FileMetaDoc`, in declaration order, read from the interface. */
export function fileMetaDocFields() {
  const src = read(TYPES);
  const at = src.indexOf('export interface FileMetaDoc');
  assert.ok(at > -1, `${TYPES}: no FileMetaDoc — re-anchor`);
  const body = src.slice(at, src.indexOf('\n}', at));
  const fields = [...body.matchAll(/^ {2}([a-zA-Z_]\w*)\??:/gm)].map(m => m[1]);
  assert.ok(fields.length >= 25, `only ${fields.length} FileMetaDoc field(s) read — the interface moved; re-anchor`);
  return fields;
}

/** The fields the divergence hash SEES for a file: `FILE_HASH_PROJECTION`, an inclusion list, read from `merkle.ts`. */
export function hashedFileFields() {
  const m = read(MERKLE).match(/const FILE_HASH_PROJECTION = \{([\s\S]*?)\}\s*as const;/);
  assert.ok(m, `${MERKLE}: no FILE_HASH_PROJECTION — re-anchor`);
  const hashed = [...m[1].matchAll(/([a-zA-Z_]\w*)\s*:\s*1/g)].map(x => x[1]);
  assert.ok(hashed.length >= 8 && hashed.includes('updatedAt') && hashed.includes('seq'),
    `FILE_HASH_PROJECTION read as ${JSON.stringify(hashed)} — re-anchor`);
  return hashed;
}

/** FileMetaDoc fields the hash does not see: what a local write may move without stamping anything authored. */
export function localOnlyFileFields() {
  const hashed = new Set(hashedFileFields());
  return fileMetaDocFields().filter(f => !hashed.has(f));
}

/**
 * The processing-state fields: the keys of the typed argument of `setFileProcessingState` once its module exists,
 * the documented set before. Each is asserted a real, local-only `FileMetaDoc` field.
 */
export function processingFields() {
  let fields = [...DOCUMENTED];
  try {
    const src = stripComments(read(PROCESSING_STATE));
    const typed = src.match(/export (?:interface|type) \w*ProcessingState\w*\s*=?\s*\{([\s\S]*?)\n\}/);
    const read1 = typed ? [...typed[1].matchAll(/^\s*([a-zA-Z_]\w*)\??:/gm)].map(m => m[1]) : [];
    if (read1.length >= DOCUMENTED.length) fields = read1;
  } catch { /* the module does not exist yet: the documented set stands */ }
  const real = new Set(fileMetaDocFields());
  const local = new Set(localOnlyFileFields());
  for (const f of fields) {
    assert.ok(real.has(f), `processing field '${f}' is not a FileMetaDoc field — the rule names a field that does not exist`);
    assert.ok(local.has(f), `processing field '${f}' is HASHED (FILE_HASH_PROJECTION): a status mark that replicates is not local state`);
  }
  return fields;
}

/** The driver methods that take an update DOCUMENT (operators), as against a replacement or a delete. */
const UPDATE_OPS = new Set(['updateOne', 'updateMany', 'findOneAndUpdate']);

/**
 * Writes that touch a processing field and are NOT the pipeline recording what it did, with the reason. Keyed by a
 * write's `name` (`file:function op #n`).
 *
 * Here, not in a gate, because two gates ask "which writers record processing state" — the one that holds them to one
 * module and the -db one that drives every one of them — and a second copy of this table is the defect they exist to
 * prevent. A gate asserts each entry still matches a write that touches a processing field, so a row cannot outlive
 * what it excuses.
 */
export const NOT_A_PROCESSING_MARK = Object.freeze({
  'files/move-cascade.ts:relocateDerivedFileMeta updateMany #3':
    'a move rewrites the `convertedFileId` POINTER on a parent to its sibling\'s new path, so the path stays true; '
    + 'it records nothing the pipeline did, stamps nothing, and is a rename of a reference rather than a status mark',
});

const MUTATOR_CALL = new RegExp(`\\.\\s*(${MUTATORS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');

/** Top-level keys of an object literal's text (`{ a: 1, 'b': 2, c, ...d }`) and whether a spread hides some. */
function literalKeys(block) {
  const inner = block.slice(1, -1);
  const keys = new Set();
  let spread = false;
  let depth = 0;
  let start = 0;
  const flush = (end) => {
    const part = inner.slice(start, end).trim();
    if (!part) return;
    if (part.startsWith('...')) { spread = true; return; }
    const k = part.match(/^(?:\[\s*)?(?:'([^']+)'|"([^"]+)"|([a-zA-Z_$][\w$]*))\s*\]?\s*(?::|$|\()/);
    if (k) keys.add(k[1] ?? k[2] ?? k[3]);
    else spread = true;
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { flush(i); start = i + 1; }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < inner.length && inner[i] !== q; i++) if (inner[i] === '\\') i++;
    }
  }
  flush(inner.length);
  return { keys, spread };
}

/** The keys a named update object gathers in `body`: its declaration literal plus every later `name['k'] =` / `name.k =`. */
function namedKeys(body, name) {
  const decl = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=]*=\\s*`).exec(body);
  if (!decl) return null;
  const at = decl.index + decl[0].length;
  const keys = new Set();
  let spread = false;
  if (body[at] === '{') {
    const lit = literalKeys(balancedFrom(body, at));
    lit.keys.forEach(k => keys.add(k));
    spread = lit.spread;
  } else spread = true;
  const esc = name.replace(/\$/g, '\\$');
  for (const m of body.matchAll(new RegExp(`${esc}\\s*\\[\\s*'([^']+)'\\s*\\]\\s*=|${esc}\\.([a-zA-Z_]\\w*)\\s*=[^=]`, 'g'))) keys.add(m[1] ?? m[2]);
  if (new RegExp(`Object\\.assign\\(\\s*${esc}\\b|\\.\\.\\.${esc}\\b`).test(body.slice(at))) spread = true;
  return { keys, spread };
}

/**
 * The keys of every `$set` / `$unset` / `$setOnInsert` in the text of one call's arguments.
 *
 * @param {string} argsText the whole argument list, as written
 * @param {string} body     the enclosing function's body, where a named update is declared
 * @returns {{ keys: Set<string>, unresolved: string[], hasUpdateOperator: boolean }}
 */
export function updateKeys(argsText, body) {
  const keys = new Set();
  const unresolved = [];
  let hasUpdateOperator = false;
  for (const m of argsText.matchAll(/\$(set|unset|setOnInsert)\s*:\s*/g)) {
    hasUpdateOperator = true;
    const at = m.index + m[0].length;
    if (argsText[at] === '{') {
      const lit = literalKeys(balancedFrom(argsText, at));
      lit.keys.forEach(k => keys.add(k));
      if (lit.spread) unresolved.push(`a spread inside $${m[1]}`);
      continue;
    }
    const name = argsText.slice(at).match(/^([a-zA-Z_$][\w$]*)/)?.[1];
    const named = name ? namedKeys(body, name) : null;
    if (!named) { unresolved.push(`$${m[1]}: ${name ?? argsText.slice(at, at + 20)} is not declared in this function`); continue; }
    named.keys.forEach(k => keys.add(k));
    if (named.spread) unresolved.push(`${name} is built with a spread or a call`);
  }
  return { keys, unresolved, hasUpdateOperator };
}

/**
 * Every write the index attributes to a space's FILES collection, with the keys it sets and unsets.
 *
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} index
 * @param {ReturnType<import('./_record-writes.mjs').recordWrites>} records  the record-collection writes of the same index
 * @param {{floor?: number}} [opts]  the fewest file-collection writes that may be found before this throws
 * @returns {Array<{ key: string, file: string, fn: string, op: string, ordinal: number, name: string, collection: string,
 *   keys: Set<string>, unresolved: string[], hasUpdateOperator: boolean, args: string, bodyMentions: string[] }>}
 */
export function fileRowWrites(index, records, { floor = 30, includeComputed = false } = {}) {
  const processing = processingFields();
  const out = [];
  // `includeComputed`: a space collection whose name is built at run time (`${spaceId}_${COLLECTION[recordType]}`, which
  // `brain/embed-record.ts` writes through for every record kind, the file among them) MAY be the files collection, so a
  // gate that asks about the files collection holds it to the rule rather than guessing it away (the rule `_record-writes.mjs`
  // already applies to record collections). Off by default: the processing-state gate predates it and reads exactly what it did.
  const isFilesSite = (s) => s.kind === 'space' && (s.collection === 'files' || (includeComputed && s.collection == null));
  for (const [key, entry] of index.bodies) {
    if (entry.alias) continue;
    const sites = (records.writers.byKey.get(key) ?? []).filter(s => MUTATORS.includes(s.op));
    if (!sites.some(isFilesSite)) continue;
    const body = entry.body;
    const matches = [...body.matchAll(MUTATOR_CALL)];
    assert.ok(matches.length >= sites.length,
      `${key}: the index holds ${sites.length} mutator site(s) and the body only ${matches.length} call(s) — the pairing is broken`);
    matches.forEach((m, i) => {
      const site = sites[i];
      if (!site) return;
      assert.equal(site.op, m[1],
        `${key}: mutator #${i + 1} of the body is '${m[1]}' and the index says '${site.op}' — the pairing is broken`);
      if (!isFilesSite(site)) return;
      const at = m.index + m[0].length - 1;
      const args = argumentsOf(body, at, `${key} ${m[1]}`);
      const argsText = args.join(', ');
      const resolved = updateKeys(argsText, body);
      // An UPDATE whose operator block is not written inline (`updateOne(filter, update)`) has keys nobody can read here.
      if (UPDATE_OPS.has(m[1]) && !resolved.hasUpdateOperator) resolved.unresolved.push('the update is not an inline operator literal');
      const fn = key.split(':').slice(1).join(':');
      out.push({
        key, file: entry.file, fn, op: m[1], ordinal: i + 1, name: `${entry.file.replace('server/src/', '')}:${fn} ${m[1]} #${i + 1}`,
        collection: 'files', keys: resolved.keys, unresolved: resolved.unresolved, hasUpdateOperator: resolved.hasUpdateOperator,
        args: argsText, filter: args[0] ?? '', receiver: receiverBefore(body, m.index).replace(/\s+/g, ' '),
        // What the function names anywhere, for a write whose keys cannot be read.
        bodyMentions: processing.filter(f => new RegExp(`\\b${f}\\b`).test(body)),
      });
    });
  }
  assert.ok(out.length >= floor,
    `only ${out.length} write(s) to a files collection found, below the floor of ${floor}. The derivation is broken, not the code.`);
  return out;
}

/**
 * The processing fields a write touches: the ones it sets or unsets, or — when its keys cannot be read — the ones its
 * function names. `readable` says which.
 */
export function processingTouched(write) {
  const processing = new Set(processingFields());
  const direct = [...write.keys].filter(k => processing.has(k));
  if (write.unresolved.length === 0) return { fields: direct, readable: true };
  return { fields: [...new Set([...direct, ...write.bodyMentions])], readable: false };
}
