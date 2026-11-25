/**
 * The Ythril-loadable variant of a BSBM dataset: the same data with the two shapes the RDF import door refuses
 * taken out, so that BOTH engines can load the same triples (Q-759, lead's decision for the benchmark).
 *
 *   1. One `rdf:type` per subject. The generator, run without forward chaining, still gives each product two
 *      types (`bsbm:Product` and its `ProductTypeN`), and Ythril refuses several types of one kind
 *      (`several-types-of-one-kind`). The subject keeps its most specific class: one that is not above another of
 *      its classes in the data's own `rdfs:subClassOf` statements, followed transitively. When two classes are
 *      unrelated, the one the data places in its subclass hierarchy stays (`ProductTypeN`, not the vocabulary class
 *      `bsbm:Product`); when that does not decide either, the first stated stays. The `rdfs:subClassOf`
 *      statements themselves are all kept.
 *   2. No language tags. Ythril refuses `language-tagged-literal`, and language tags on values are an open idea
 *      awaiting the owner (I-41). `"x"@en` becomes `"x"`, the same lexical form as a plain string.
 *
 *   3. The address statement. The import mints a new address per record and keeps the generator's nowhere, but the
 *      BSBM parameters name generator addresses. Every subject that is an `<iri>` gets one closing statement
 *      `<s> rdfs:seeAlso "<s>"`, the address as a PLAIN STRING (an address object would be read as a link to the
 *      record itself and answer the minted address back). Both engines load it, so the data stays the same on both
 *      sides; the Ythril run asks for the record carrying each parameter's address and uses the minted one.
 *
 * Nothing else changes.
 *
 * ## What this prevents
 *
 * - **Two engines loading different data.** One transform makes the file both load, so a timing difference is
 *   not a difference in triples. The result record names `VARIANT` and the sha256 of the bytes written here.
 * - **A silent edit of a line it should not touch.** Lines are read and written as latin1, which maps every
 *   byte to one character and back, so a line the rules do not change leaves byte for byte, whatever its
 *   encoding, line ending or spacing; a dataset that is not valid UTF-8 is not "repaired".
 * - **A different file on the second run.** The output depends only on the input bytes (no stamp, no ordering
 *   by hash iteration: statements keep their file order), so the sha256 is the same every time.
 * - **A dataset in memory.** The file is read twice in chunks (first the types and the subclass statements, then
 *   the rewrite); only the type lists of subjects with two or more types are kept for the second pass.
 */
import { closeSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Names this transform's output; the result record carries it beside the sha256. Raise it when a rule changes. */
export const VARIANT = 'ythril-loadable-2';

/** The property that carries a subject's generator address as a string (rule 3). */
export const ADDRESS_PREDICATE = 'http://www.w3.org/2000/01/rdf-schema#seeAlso';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

const NODE = String.raw`(<[^>]*>|_:\S+)`;
const TYPE_LINE = new RegExp(`^${NODE} <${RDF_TYPE}> (<[^>]*>)\\s*\\.\\s*$`);
const SUBCLASS_LINE = new RegExp(`^(<[^>]*>) <${SUBCLASS_OF}> (<[^>]*>)\\s*\\.\\s*$`);
// A literal's closing quote, its language tag, then the end of the statement. Anchored to the end, so a tag-like
// text inside a literal, a typed literal and an IRI never match.
const LANG_TAIL = /"@[A-Za-z]+(?:-[A-Za-z0-9]+)*(\s*\.\s*)$/;
const COMMENT_LINE = /^\s*#/;

/** The address statement of a subject given as `<iri>`: the IRI between the brackets, escaped as an N-Triples string. */
function addressLine(subject) {
  const iri = subject.slice(1, -1).replace(/[\\"]/g, (c) => `\\${c}`);
  return `${subject} <${ADDRESS_PREDICATE}> "${iri}" .\n`;
}

/** The subject of a statement line when it is an `<iri>`, else null (a blank node, a comment, a blank line). */
function iriSubject(line) {
  if (line.charCodeAt(0) !== 60) return null;
  const end = line.indexOf('>');
  return end < 0 ? null : line.slice(0, end + 1);
}

/** Yields `{ line, terminated }` for a text; `terminated` is whether a `\n` followed the line. */
function* linesOfText(text) {
  let from = 0;
  for (;;) {
    const nl = text.indexOf('\n', from);
    if (nl < 0) {
      if (from < text.length) yield { line: text.slice(from), terminated: false };
      return;
    }
    yield { line: text.slice(from, nl), terminated: true };
    from = nl + 1;
  }
}

/** The same, over a file read in chunks (latin1), so a file larger than memory is read line by line. */
export function* linesOfFile(path, chunkBytes) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let carry = '';
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const text = carry + buf.latin1Slice(0, n);
      const cut = text.lastIndexOf('\n');
      if (cut < 0) { carry = text; continue; }
      yield* linesOfText(text.slice(0, cut + 1));
      carry = text.slice(cut + 1);
    }
    if (carry) yield { line: carry, terminated: false };
  } finally {
    closeSync(fd);
  }
}

function newScan() {
  return { types: new Map(), parents: new Map(), hierarchy: new Set() };
}

function scanLine(scan, line) {
  if (line.includes(RDF_TYPE)) {
    const m = TYPE_LINE.exec(line);
    if (m) {
      const [, subject, klass] = m;
      const seen = scan.types.get(subject);
      if (seen === undefined) scan.types.set(subject, klass);
      else if (typeof seen === 'string') { if (seen !== klass) scan.types.set(subject, [seen, klass]); }
      else if (!seen.includes(klass)) seen.push(klass);
    }
    return;
  }
  if (line.includes(SUBCLASS_OF)) {
    const m = SUBCLASS_LINE.exec(line);
    if (m) {
      const [, child, parent] = m;
      let set = scan.parents.get(child);
      if (!set) scan.parents.set(child, (set = new Set()));
      set.add(parent);
      scan.hierarchy.add(child).add(parent);
    }
  }
}

/** Every class above `klass` through `rdfs:subClassOf`, transitively (a cycle in the data ends the walk). */
function ancestorsOf(scan, klass, memo) {
  const known = memo.get(klass);
  if (known) return known;
  const out = new Set();
  const stack = [klass];
  while (stack.length) {
    for (const p of scan.parents.get(stack.pop()) ?? []) {
      if (!out.has(p)) { out.add(p); stack.push(p); }
    }
  }
  memo.set(klass, out);
  return out;
}

/** `subject -> the one class it keeps`, for subjects that were stated with two or more classes. */
function decide(scan) {
  const kept = new Map();
  const memo = new Map();
  let tied = 0;
  for (const [subject, classes] of scan.types) {
    if (typeof classes === 'string') continue;
    let best = classes.filter((c) => !classes.some((o) => o !== c && ancestorsOf(scan, o, memo).has(c)));
    if (best.length === 0) best = classes; // a subclass cycle in the data: nothing is above everything
    if (best.length > 1) {
      const inHierarchy = best.filter((c) => scan.hierarchy.has(c));
      if (inHierarchy.length > 0) best = inHierarchy;
    }
    if (best.length > 1) tied++;
    kept.set(subject, best[0]);
  }
  return { kept, tied };
}

/** The line as it is written, or `null` when it is dropped; `count` tallies what changed. */
function rewrite(line, kept, count) {
  if (kept.size > 0 && line.includes(RDF_TYPE)) {
    const m = TYPE_LINE.exec(line);
    if (m) {
      const keeps = kept.get(m[1]);
      if (keeps !== undefined && keeps !== m[2]) { count.droppedTypeStatements++; return null; }
    }
  }
  if (line.includes('"@') && !COMMENT_LINE.test(line)) {
    const m = LANG_TAIL.exec(line);
    if (m) {
      let backslashes = 0;
      for (let i = m.index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
      if (backslashes % 2 === 0) { count.retaggedLiterals++; return line.slice(0, m.index + 1) + m[1]; }
    }
  }
  return line;
}

function newCount() {
  return { droppedTypeStatements: 0, retaggedLiterals: 0 };
}

const isTriple = (line) => /\S/.test(line) && !COMMENT_LINE.test(line);

/**
 * The variant of an N-Triples text (a latin1 string: one character per byte). Returns `{ text, stats }`.
 * Pure: the same text gives the same text.
 */
export function prepareText(text) {
  const scan = newScan();
  for (const { line } of linesOfText(text)) scanLine(scan, line);
  const { kept, tied } = decide(scan);
  const count = newCount();
  const out = [];
  const subjects = new Set();
  let inputTriples = 0;
  let triples = 0;
  let endsInNewline = true;
  for (const { line, terminated } of linesOfText(text)) {
    if (isTriple(line)) inputTriples++;
    const written = rewrite(line, kept, count);
    if (written === null) continue;
    if (isTriple(written)) { triples++; const s = iriSubject(written); if (s !== null) subjects.add(s); }
    out.push(terminated ? `${written}\n` : written);
    endsInNewline = terminated;
  }
  if (subjects.size > 0 && !endsInNewline) out.push('\n');
  for (const s of subjects) out.push(addressLine(s));
  return {
    text: out.join(''),
    stats: { inputTriples, triples: triples + subjects.size, multiTypedSubjects: kept.size, tiedSubjects: tied, addressStatements: subjects.size, ...count },
  };
}

/**
 * The same transform from one file to another, in two passes over the source and chunks of memory. Writes
 * `<dst>.partial` and renames it, so a stopped run leaves no half file under the real name. Returns the
 * variant's name, the sha256 and byte count of what was written, and the counts of what changed.
 */
export function prepareFile(src, dst, { chunkBytes = 1 << 22 } = {}) {
  const scan = newScan();
  for (const { line } of linesOfFile(src, chunkBytes)) scanLine(scan, line);
  const { kept, tied } = decide(scan);
  scan.types.clear();

  const count = newCount();
  const hash = createHash('sha256');
  const partial = `${dst}.partial`;
  const fd = openSync(partial, 'w');
  let bytes = 0;
  let inputTriples = 0;
  let triples = 0;
  const subjects = new Set();
  let endsInNewline = true;
  let pending = [];
  let pendingSize = 0;
  const flush = () => {
    if (pendingSize === 0) return;
    const chunk = Buffer.from(pending.join(''), 'latin1');
    writeSync(fd, chunk);
    hash.update(chunk);
    bytes += chunk.length;
    pending = [];
    pendingSize = 0;
  };
  try {
    for (const { line, terminated } of linesOfFile(src, chunkBytes)) {
      if (isTriple(line)) inputTriples++;
      const written = rewrite(line, kept, count);
      if (written === null) continue;
      if (isTriple(written)) { triples++; const s = iriSubject(written); if (s !== null) subjects.add(s); }
      const piece = terminated ? `${written}\n` : written;
      pending.push(piece);
      pendingSize += piece.length;
      endsInNewline = terminated;
      if (pendingSize >= 1 << 20) flush();
    }
    if (subjects.size > 0 && !endsInNewline) { pending.push('\n'); pendingSize++; }
    for (const s of subjects) {
      const piece = addressLine(s);
      pending.push(piece);
      pendingSize += piece.length;
      if (pendingSize >= 1 << 20) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }
  renameSync(partial, dst);
  return {
    variant: VARIANT, sha256: hash.digest('hex'), bytes, triples: triples + subjects.size, inputTriples,
    multiTypedSubjects: kept.size, tiedSubjects: tied, addressStatements: subjects.size, ...count,
  };
}
