/**
 * Splits an N-Triples file into subject-complete chunks under a byte bound, ends before the edges that point at them.
 *
 * The RDF import door refuses a body over its bound (1 GiB, `rdf_bound_exceeded`). A bigger variant is imported as
 * several files, in order.
 *
 * ## What this prevents
 *
 * - **A subject divided between two imports.** Every statement of one subject goes to one chunk: Ythril builds a
 *   record from all of its subject's statements, so half a subject is a different record.
 * - **An edge imported before its end.** A subject is never placed in an earlier chunk than a subject it points at
 *   (objects that are subjects of the file), so each import finds its edges' ends already imported. Subjects that
 *   point at each other (a cycle) are one unit and stay together. NOTE: a later import names an earlier chunk's record
 *   by the generator's address, which the import does not keep (the record has a new address), so an edge across
 *   chunks is, on the door as it is, refused as an unknown end; this module keeps the order right, it cannot give the
 *   door that memory. The benchmark's sizes are chosen so that none of them needs a second chunk.
 * - **A chunk over its bound.** A subject, or a cycle of them, that alone exceeds the bound throws, naming it.
 * - **A different plan on the next run.** Order follows the file's order of subjects; nothing depends on hash
 *   iteration.
 * - **A file in memory.** The file is read twice line by line; memory holds one entry per subject.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { linesOfFile } from './prepare.mjs';

/**
 * `{ chunks: [[id, ...], ...] }` from `subjects` (`{ id, bytes, refs }`, in file order). Chunks are filled in an order in
 * which every subject follows the subjects it refers to; a chunk takes the next unit while it fits.
 */
export function planChunks(subjects, maxBytes) {
  const index = new Map(subjects.map((s, i) => [s.id, i]));
  const edges = subjects.map((s, i) => [...new Set(s.refs.map((r) => index.get(r)).filter((j) => j !== undefined && j !== i))]);

  // Tarjan, iterative (a long chain of references must not overflow the stack). A component is completed after
  // every component it reaches, which is the order wanted: ends first.
  const order = new Array(subjects.length).fill(-1);
  const low = new Array(subjects.length).fill(0);
  const onStack = new Array(subjects.length).fill(false);
  const stack = [];
  const components = [];
  let counter = 0;
  for (let root = 0; root < subjects.length; root++) {
    if (order[root] !== -1) continue;
    const work = [[root, 0]];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, next] = frame;
      if (next < edges[v].length) {
        frame[1]++;
        const w = edges[v][next];
        if (order[w] === -1) {
          order[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], order[w]);
      } else {
        work.pop();
        if (work.length > 0) { const parent = work[work.length - 1][0]; low[parent] = Math.min(low[parent], low[v]); }
        if (low[v] === order[v]) {
          const members = [];
          for (;;) {
            const w = stack.pop();
            onStack[w] = false;
            members.push(w);
            if (w === v) break;
          }
          components.push(members.sort((a, b) => a - b));
        }
      }
    }
  }

  const chunks = [];
  let current = [];
  let used = 0;
  for (const members of components) {
    const bytes = members.reduce((n, i) => n + subjects[i].bytes, 0);
    if (bytes > maxBytes) {
      throw new Error(`subject ${subjects[members[0]].id}${members.length > 1 ? ` (with ${members.length - 1} more that point at each other)` : ''} is ${bytes} bytes, over the bound ${maxBytes}`);
    }
    if (used + bytes > maxBytes && current.length > 0) { chunks.push(current); current = []; used = 0; }
    for (const i of members) current.push(subjects[i].id);
    used += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks };
}

const SUBJECT = /^(<[^>]*>|_:\S+)\s/;
const OBJECT_IRI = / (<[^>]*>)\s*\.\s*$/;
const isStatement = (line) => /\S/.test(line) && !/^\s*#/.test(line);

/**
 * Writes `<dstDir>/chunk-0001.nt`, `chunk-0002.nt`, ... from the N-Triples file `src`: every statement of a subject in one
 * file, no file over `maxBytes`, ends first (see `planChunks`). Comments and blank lines are not carried. Returns
 * `{ files, chunks }`, the paths in the order to import them.
 */
export function chunkFile(src, dstDir, maxBytes, { chunkBytes = 1 << 22 } = {}) {
  const sizes = new Map();
  const refs = new Map();
  for (const { line } of linesOfFile(src, chunkBytes)) {
    if (!isStatement(line)) continue;
    const m = SUBJECT.exec(line);
    if (!m) throw new Error(`a statement with no subject: ${line.slice(0, 80)}`);
    sizes.set(m[1], (sizes.get(m[1]) ?? 0) + line.length + 1);
    const o = OBJECT_IRI.exec(line);
    if (o) { let set = refs.get(m[1]); if (!set) refs.set(m[1], (set = new Set())); set.add(o[1]); }
  }
  const { chunks } = planChunks([...sizes].map(([id, bytes]) => ({ id, bytes, refs: [...(refs.get(id) ?? [])] })), maxBytes);
  const chunkOf = new Map(chunks.flatMap((ids, i) => ids.map((id) => [id, i])));
  refs.clear();
  sizes.clear();

  mkdirSync(dstDir, { recursive: true });
  const files = chunks.map((_, i) => join(dstDir, `chunk-${String(i + 1).padStart(4, '0')}.nt`));
  const fds = files.map((f) => openSync(f, 'w'));
  const pending = files.map(() => []);
  const pendingSize = files.map(() => 0);
  const flush = (i) => {
    if (pendingSize[i] === 0) return;
    writeSync(fds[i], Buffer.from(pending[i].join(''), 'latin1'));
    pending[i] = [];
    pendingSize[i] = 0;
  };
  try {
    for (const { line } of linesOfFile(src, chunkBytes)) {
      if (!isStatement(line)) continue;
      const i = chunkOf.get(SUBJECT.exec(line)[1]);
      pending[i].push(`${line}\n`);
      pendingSize[i] += line.length + 1;
      if (pendingSize[i] >= 1 << 20) flush(i);
    }
    files.forEach((_, i) => flush(i));
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  return { files, chunks: files.length };
}
