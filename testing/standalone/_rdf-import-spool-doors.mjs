/**
 * How the import spool's and the import index's tests reach the two modules, make a folder for them and build quads (bundle-270, slice S5).
 *
 * ## The contract it encodes, written before the modules
 *
 * `server/src/rdf/import-spool.ts`:
 * - `openImportFolder(dir)` makes (or opens) the folder every file of one import lives in, and answers `{ dir, remove() }`;
 *   `removeImportFolder(dir)` is the same removal without a handle (a crash left the files and the process that wrote them is gone).
 *   It removes only the files the module writes, and refuses a folder that holds anything else, so a wrong path never loses a caller's files.
 * - `sortedSpool(quads, folder, { names, bounds? })` reads the quads once, counts them, their distinct subjects and the quads and characters of
 *   the largest subject against `bounds` (`maxQuads`, `maxSubjects`, `maxSubjectQuads`, `maxSubjectChars`, `runBytes`), and sorts them on disk
 *   by graph and subject; over a bound it throws `RdfImportBoundExceeded` (`code: 'rdf_bound_exceeded'`, `bound`: the constant's name, `limit`)
 *   before it returns, having removed what it wrote. It answers `{ quads, subjects, largestSubjectQuads, groups() }`; `groups()` yields
 *   `{ key, graph?, subject, quads }`, one per subject and graph, a record's parts delivered with it: `names` is the reverse addressing's
 *   `addressNames(...)`, and an address it reads as a record part (a chrono's `#start` and `#end`) is grouped under its record.
 *   A subject's characters are counted by {@link termChars} over each quad's subject, predicate, object and graph.
 * - `quadGroupKey(subject, graph?)` is the key a group carries and the index is keyed by.
 * - `openOperationSpool(folder)` answers `{ append(kind, op), close(), read(order) }`: one file per kind, read back kind by kind in `order`.
 *
 * `server/src/rdf/import-index.ts`: `new ImportIndex({ maxRecords? })` with `set(key, { kind, id, stored })`, `get(key)`, `has(key)`, `size`,
 * `write(folder)` and `ImportIndex.read(folder, options?)`; over `maxRecords` it throws `RdfImportBoundExceeded` naming `RDF_IMPORT_MAX_RECORDS`.
 *
 * What the helpers decide once: every folder is made under the runner's temporary folder (`os.tmpdir()`), never the checkout, and removed after.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importOrFail } from '../_shared/import-or-fail.mjs';

/** The spool module, or a failed case naming it. */
export const spoolModule = () => importOrFail('server/dist/rdf/import-spool.js', 'the import\'s sorted spool (bundle-270 S5)');
/** The index module, or a failed case naming it. */
export const indexModule = () => importOrFail('server/dist/rdf/import-index.js', 'the import\'s index of subjects (bundle-270 S5)');
/** The reverse addressing (slice S2), for `recordPartOwner`. */
export const reverseModule = () => importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing (bundle-270 S2)');

const made = [];
/** A fresh, empty folder under the runner's temporary folder; `cleanupFolders` removes every one made. */
export function tempFolder(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-b270-s5-${label}-`));
  made.push(dir);
  return dir;
}
/** Remove every folder `tempFolder` made (an `after` hook). */
export function cleanupFolders() {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The names in `dir`, sorted; an absent folder lists nothing. */
export function namesIn(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
}

/** The bytes of every file in `dir`, joined: a search for a value written in plain. */
export function bytesIn(dir) {
  return Buffer.concat(namesIn(dir).map(n => fs.readFileSync(path.join(dir, n))));
}

export const iri = (value) => ({ kind: 'iri', value });
export const blank = (id) => ({ kind: 'blank', id });
export const lit = (value, extra = {}) => ({ kind: 'literal', value, ...extra });
export const q = (subject, predicate, object, graph) => (graph ? { subject, predicate, object, graph } : { subject, predicate, object });

/** The characters a term counts toward its subject's bound: every string it carries (a triple term's three terms). */
export function termChars(term) {
  if (!term) return 0;
  switch (term.kind) {
    case 'iri': return term.value.length;
    case 'blank': return term.id.length;
    case 'literal': return term.value.length + (term.datatype?.length ?? 0) + (term.language?.length ?? 0);
    case 'triple': return termChars(term.subject) + termChars(term.predicate) + termChars(term.object);
    default: throw new Error(`no term of kind ${term.kind} in these fixtures`);
  }
}
/** The characters a quad counts toward its subject's bound. */
export const quadChars = (quad) => termChars(quad.subject) + termChars(quad.predicate) + termChars(quad.object) + termChars(quad.graph);

/** The names of a space with RDF on at `base`, as the reverse addressing builds them. */
export async function namesAt(base) {
  const { addressNames } = await reverseModule();
  return addressNames({ rdf: { enabled: true, base, baseEpoch: 0 }, typeSchemas: {} });
}

/** An async iterable over `quads`, as the reader hands them. */
export async function* streamOf(quads) { for (const quad of quads) yield quad; }

/** Every group the spool yields, as plain data. */
export async function groupsOf(spool) {
  const out = [];
  for await (const group of spool.groups()) out.push(group);
  return out;
}

/** The refusal `promise` rejects with; fails when it resolves. */
export async function refusalOf(promise, what) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail(`${what}: nothing was refused`);
}

/** Assert `err` is the import's bound refusal naming `bound` and its `limit`. */
export function assertBound(err, bound, limit) {
  assert.equal(err?.name, 'RdfImportBoundExceeded', `the refusal is ${err?.name}: ${err?.message}, not the import's bound refusal`);
  assert.equal(err.code, 'rdf_bound_exceeded');
  assert.equal(err.bound, bound, `the refusal names ${err.bound}, not ${bound}`);
  assert.equal(err.limit, limit);
  assert.match(err.message, new RegExp(bound), 'the message names the bound');
}
