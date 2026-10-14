/**
 * What a refused move must leave alone, and how to read it — the question "did the move change ANYTHING" answered once, for
 * every test that holds a refusal (bundle-44, Q-437).
 *
 * ## Why a module
 *
 * A refusal is only a refusal if nothing moved: not the bytes, not the records, not the derived rows, not the links, not the
 * jobs, not a tombstone. Each test that held it wrote its own list of "the things to compare", and the list that drifts is the
 * one that forgets a collection — a refused move that quietly removed a job passes every test that never read the jobs.
 *
 * ## The part a hand-written copy drops
 *
 * **The snapshot reads EVERYTHING the move can write, not what the test seeded**: every file and directory under the space's
 * tree (a directory the move created or removed is a change), every document of `files`, `links`, `media_jobs` and the file
 * tombstones — pending ones included, because a pending tombstone a refused move left is the defect, not a detail.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The three doors a move is asked at: the file router's `PATCH`, `POST /api/<tool>`, and MCP. */
export const MOVE_DOORS = Object.freeze(['REST', 'TOOL', 'MCP']);

/**
 * Every entry under `root`, by its path relative to it: a file's bytes (utf8), a directory as `null`. Sorted, so two trees compare
 * with `deepEqual`. Deliberately the whole tree: a move that created `moved/` and removed it again is not a change, one that left it is.
 */
export function treeOf(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { out[rel] = null; walk(full); } else out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** Everything a move can write, read now: see the module docblock. */
export async function stateOf(acts, space) {
  const all = (part) => acts.door.coll(space, part).find({}).sort({ _id: 1 }).toArray();
  return {
    tree: treeOf(acts.root()),
    files: await all('files'),
    links: await all('links'),
    jobs: await all('media_jobs'),
    tombstones: await all('file_tombstones'),
  };
}

/** What a door said, as one string: REST's body, a tool's `data` and MCP's text and structured content — for "the remedy is in the sentence". */
export function sentenceOf(answer) {
  return JSON.stringify({ body: answer.body, text: answer.text, sc: answer.sc });
}

/**
 * Whether the files tree is on a CASE-INSENSITIVE file system, asked of the file system itself: `x` created, `X` looked up. The case-only
 * rename tests run where it is true (this development machine is NTFS) and say so where it is not.
 */
export function caseInsensitiveAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `case-probe-${process.pid}`);
  fs.writeFileSync(probe, 'x');
  try { return fs.existsSync(path.join(dir, `CASE-PROBE-${process.pid}`)); } finally { fs.rmSync(probe, { force: true }); }
}
