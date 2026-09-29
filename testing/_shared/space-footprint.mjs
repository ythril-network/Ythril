/**
 * What a space HOLDS, read straight out of its instance's Mongo — the question "did that call write anything
 * into the space?", answered once.
 *
 * ## Why this is a module
 *
 * `Q-92`: a search wrote into the space it searched. A recall with `remainderDump`, or a traversal past the
 * inline cap, put a JSON file under `_tmp/`, a `<space>_files` record, a seq bump (so the record synced to
 * every peer) and an embed job — all from a knowledge-READ token. The red-team suite asks "a read leaves the
 * space untouched" and the sync suite asks "a peer holds no spill"; both are questions about the same three
 * stores, and a hand-written copy of the read in each would drift the first time one of them grew a fourth.
 *
 * It reads Mongo rather than the REST listing on purpose. The listing HIDES `_tmp/` (it is a derived tree),
 * so a listing-based check would report a space untouched while it held the very file this is looking for.
 *
 * ## The un-skippable part
 *
 * A footprint of a space that does not exist, or of a container that did not answer, is EMPTY — and two
 * empty footprints are equal, which reads as "nothing was written". So `spaceFootprint` THROWS when the
 * space has no seq counter (every seeded space has one) and when the container's answer cannot be parsed;
 * a caller cannot receive the failure as a clean comparison.
 *
 * The script is one `--eval` argument passed with NO shell in between (`execFileSync` with an argument
 * list), so no runner — cmd.exe on Windows, sh on CI — gets to reinterpret a quote, a `$` or a `|` in it.
 * Not stdin: mongosh reads stdin as a REPL, line by line.
 */
import { execFileSync } from 'node:child_process';

/** Run `js` in the `ythril` database of instance `x`'s Mongo and return what it `print`s, parsed as JSON. */
export function mongoEval(x, js) {
  const out = execFileSync('docker', [
    'exec', `ythril-mongo-${x}`, 'mongosh', '--quiet',
    '-u', 'ythril', '-p', 'ythril-test-pw', '--authenticationDatabase', 'admin',
    '--eval', `const d = db.getSiblingDB('ythril');\n${js}\n`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  const last = out.split(/\r?\n/).filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(last);
  } catch {
    throw new Error(`mongosh on ythril-mongo-${x} gave no JSON: ${out.slice(0, 400)}`);
  }
}

/**
 * The parts of a space a read must never change: every file-record id, the space's seq counter, and every
 * embed job that names a `_tmp/` path.
 *
 * Embed jobs are filtered rather than counted because the seeding a test does queues jobs of its own, and
 * their completion would move a count for reasons unrelated to the call under test.
 */
export function spaceFootprint(x, spaceId) {
  const fp = mongoEval(x, `
    const files = d.getCollection(${JSON.stringify(`${spaceId}_files`)}).find({}, { projection: { _id: 1 } })
      .toArray().map(f => String(f._id)).sort();
    const counter = d.getCollection('ythril_counters').findOne({ _id: ${JSON.stringify(spaceId)} });
    const jobs = d.getCollection(${JSON.stringify(`${spaceId}_embed_jobs`)}).find({}).toArray()
      .map(j => JSON.stringify(j)).filter(s => s.includes('_tmp/'));
    print(JSON.stringify({ fileIds: files, seq: counter ? Number(counter.seq) : null, spillJobs: jobs }));
  `);
  if (typeof fp.seq !== 'number' || !Number.isFinite(fp.seq)) {
    throw new Error(`space '${spaceId}' on instance ${x} has no seq counter — a footprint of nothing compares `
      + 'equal to itself, so it cannot say whether a call wrote');
  }
  return fp;
}

/** The stored rows of one read spill on instance `x`: how many headers and pages carry `spillId`. */
export function spillRows(x, spillId) {
  return mongoEval(x, `
    print(JSON.stringify({
      headers: d.getCollection('_read_spills').countDocuments({ _id: ${JSON.stringify(spillId)} }),
      pages: d.getCollection('_read_spill_pages').countDocuments({ spillId: ${JSON.stringify(spillId)} }),
    }));
  `);
}
