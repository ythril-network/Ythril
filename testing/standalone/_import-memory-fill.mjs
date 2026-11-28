/**
 * The child process of `the-import-memory-room-keeps-the-process-alive-at-its-bound.test.js`: it fills every holder of an RDF import to the room the
 * instance gives it, as the worst moment of two imports that can exist at once (a door that infers a schema from the file's data, and the act that
 * translates it, then plans it), in a process whose heap limit the parent set (`--max-old-space-size`) to the one a container of that size gets.
 *
 * usage: node --max-old-space-size=<MiB> --expose-gc _import-memory-fill.mjs <container bytes>
 *
 * It prints one JSON line when every holder stopped at its bound, never earlier or later: each holder ends by a refusal from the room's meter (the
 * "refused just past it"), never by the heap running out. The process dying first (the heap, or the container) is the failure the room is for.
 */
import v8 from 'node:v8';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const load = (file) => import(pathToFileURL(path.join(REPO_ROOT, 'server/dist/rdf', file)).href);
const [memory, index, count, ends, win, data, edgePlan] = await Promise.all(['import-memory.js', 'import-index.js', 'import-count.js', 'import-ends.js', 'import-window.js', 'schema-from-data.js', 'import-edge-plan.js'].map(load));
const { ReadSet } = await import(pathToFileURL(path.join(REPO_ROOT, 'server/dist/brain/write-plan/read-set.js')).href);

const container = Number(process.argv[2]);
const { bytes: room, heapLimitBytes } = memory.importMemoryRoom({ readFile: () => String(container) });
const heapNow = () => v8.getHeapStatistics().used_heap_size;
let peak = 0;
const sample = () => { peak = Math.max(peak, heapNow()); };

/** Charge `perEntry` to `meter` and run `make` until the meter refuses; answers how many entries it kept and whether the refusal came from the room. */
function fillUntilRefused(meter, perEntry, make) {
  let kept = 0;
  try {
    for (;;) {
      meter.charge(perEntry);
      make(kept);
      kept += 1;
      if ((kept & 0xffff) === 0) sample();
    }
  } catch (err) {
    if (err?.bound !== 'RDF_IMPORT_MAX_MEMORY') throw err;
    return { kept, refused: true, need: err.need };
  }
}

const key = (i) => JSON.stringify([`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${i % 997}/Product${i}`, '']);
const flat = (s) => Buffer.from(s, 'utf8').toString('utf8');

/** The door's holder: the inference's first pass, charged a subject at a time as the door's check says. */
function door() {
  const meter = new memory.ImportMemoryMeter(room);
  const seen = new Set();
  const subjects = new Map();
  // A quarter of the room is label-only subjects with labels of 2 000 characters, charged by their characters as the first pass reads them.
  const labels = new Map();
  for (let spent = 0, i = 0; ; i += 1) {
    const address = flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/Label${i}`);
    const key = flat(address);
    const label = flat(`${'y'.repeat(2000)}${i}`);
    const cost = memory.textBytes(address) + memory.textBytes(key) + memory.textBytes(label);
    if (spent + cost > room / 4) break;
    meter.charge(cost);
    spent += cost;
    labels.set(address, { keys: [key], labels: [label] });
  }
  const r = fillUntilRefused(meter, memory.INFER_SUBJECT_BYTES, (i) => {
    const digest = count.digestOfKey(flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${i % 997}/Product${i}`));
    seen.add(digest);
    const have = subjects.get(digest) ?? [];
    have.push(i % 5);
    subjects.set(digest, have);
  });
  return { ...r, hold: [seen, subjects, labels] };
}

/** The act's first phase: the index (subjects, then bare edges), the two digest sets, and a window of groups at its share. */
function actFirstPhase() {
  const meter = new memory.ImportMemoryMeter(room);
  const idx = new index.ImportIndex({ meter });
  const asserted = new count.DigestSet();
  // A file like the benchmark's: per subject an entry, two statements of the sets, and one bare edge minted under its triplet.
  let subjects = 0;
  let refusedAt = null;
  try {
    for (;; subjects += 1) {
      idx.set(key(subjects), { kind: 'entity', id: flat(crypto.randomUUID()), stored: false });
      asserted.addCharged(JSON.stringify([`http://x/s${subjects}`, 'http://x/p', `http://x/o${subjects}`, '']), meter);
      asserted.addCharged(JSON.stringify([`http://x/s${subjects}`, 'http://x/q', `http://x/o${subjects}`, '']), meter);
      idx.set(JSON.stringify([`http://x/s${subjects}`, 'http://x/p', `http://x/o${subjects}`, '']), { kind: 'edge', id: flat(crypto.randomUUID()), stored: false });
      if ((subjects & 0xffff) === 0) sample();
    }
  } catch (err) {
    if (err?.bound !== 'RDF_IMPORT_MAX_MEMORY') throw err;
    refusedAt = err.need;
  }
  // The window of groups the passes hold beside them: filled to its share, as the window ends.
  const window = [];
  const share = win.windowBudgetOf(room);
  let held = 0;
  for (let g = 0; ; g += 1) {
    const subject = { kind: 'iri', value: flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/dataFromProducer${g % 97}/Product${g}`) };
    const group = { key: subject.value, subject, quads: Array.from({ length: 12 }, (_, q) => ({ subject: { ...subject }, predicate: { kind: 'iri', value: flat(`http://www4.wiwiss.fu-berlin.de/bizer/bsbm/vocab/v01/property${q}`) }, object: { kind: 'literal', value: flat(`${'x'.repeat(20)}${g}`) } })) };
    const cost = win.groupBytes(group);
    if (held + cost > share) break;
    held += cost;
    window.push(group);
  }
  return { kept: subjects, refused: refusedAt !== null, need: refusedAt, hold: [idx, asserted, window], window: window.length };
}

/** The act's second phase: the minted ends, then their copy, in a meter of their own room. */
function actSecondPhase() {
  const meter = new memory.ImportMemoryMeter(room);
  const made = new ends.MintedEnds(meter);
  const fit = Math.floor(room / 2 / (memory.MINTED_END_BYTES + memory.ENDS_COPY_BYTES));
  for (let i = 0; i < fit; i += 1) {
    made.set(flat(crypto.randomUUID()), i % 4 === 0 ? { kind: 'entity', type: flat(`ProductType${i % 400}`) } : { kind: 'fact' });
    if ((i & 0xffff) === 0) sample();
  }
  const copy = made.copy();
  // The dry plan's shared read set (a functional edge label), charged an edge at a time to a fork of the meter until the room refuses.
  const view = new ReadSet('probe');
  const sets = new edgePlan.EdgeReadSets({ edge: { productFeature: { functional: true } } }, meter.resumed(), () => view);
  let edges = 0;
  let refused = false;
  try {
    for (;;) {
      sets.forWindow([]);
      sets.planned(1);
      const from = flat(crypto.randomUUID());
      const to = flat(crypto.randomUUID());
      view.noteWritten('entity', { _id: from, spaceId: 'probe', type: flat('Product') }, true);
      view.noteWritten('entity', { _id: to, spaceId: 'probe', type: flat('Feature') }, true);
      view.noteWritten('edge', {
        _id: flat(crypto.randomUUID()), spaceId: 'probe', from, to, label: flat('productFeature'), tags: [], properties: {}, author: { kind: 'token', id: flat(`author-${edges % 7}`) },
        createdAt: flat(new Date().toISOString()), updatedAt: flat(new Date().toISOString()), seq: 0, schemaFingerprint: flat('0123456789abcdef'), fromKind: flat('entity'), toKind: flat('entity'),
      }, true);
      edges += 1;
      if ((edges & 0xffff) === 0) sample();
    }
  } catch (err) { if (err?.bound !== 'RDF_IMPORT_MAX_MEMORY') throw err; refused = true; }
  return { kept: made.size, edges, refused, hold: [made, copy, view] };
}

const doorHolds = door();
sample();
let phase = actFirstPhase();
sample();
const first = { kept: phase.kept, refused: phase.refused, window: phase.window };
const doorRes = { kept: doorHolds.kept, refused: doorHolds.refused };
// The act's first phase is over: nothing keeps its index and sets. The door's maps are still held (a second door may be inferring).
phase = null;
const second = actSecondPhase();
sample();
const secondRes = { kept: second.kept, edges: second.edges, refused: second.refused };
global.gc();
console.log(JSON.stringify({
  containerMiB: Math.round(container / 2 ** 20), heapLimitMiB: Math.round(heapLimitBytes / 2 ** 20), roomMiB: +(room / 2 ** 20).toFixed(1),
  door: doorRes, actFirst: first, actSecond: secondRes, peakHeapMiB: Math.round(peak / 2 ** 20), usedAfterGcMiB: Math.round(heapNow() / 2 ** 20),
  holds: doorHolds.hold.length + second.hold.length,
}));
