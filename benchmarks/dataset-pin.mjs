/**
 * Fetching a pinned dataset, and refusing everything else.
 *
 * ## What this prevents
 *
 * A benchmark corpus is somebody else's file on somebody else's server. It can be re-uploaded, silently
 * corrected, truncated by a proxy, or replaced — and every one of those produces a run that completes, scores
 * something, and is not comparable to the last one. Nothing in a results table says which file it read.
 *
 * So a dataset is **pinned, not vendored**: this repository records the URL and the sha256, fetches by URL,
 * and refuses anything whose bytes do not match. Redistributing the corpus here would put us in the business
 * of hosting it, and a committed copy is one more thing that can drift from what the authors publish.
 *
 * ## The guard a hand-written copy drops
 *
 * **A pin with no hash is refused, exactly like a mismatch.** That is the line that looks like boilerplate and
 * is the whole point: a second benchmark is added, its `sha256` is `null` because nothing has been fetched
 * yet, and the obvious four lines — `if (pin.sha256 && actual !== pin.sha256) throw` — read that as *nothing
 * to check* and write the file. The corpus is then unverified for as long as nobody re-reads the condition,
 * which is for ever. `LongMemEval` is in exactly that state today, which is why this rule is enforced rather
 * than remembered.
 *
 * Recording a hash is a deliberate act: fetch with `recordHash`, look at what came back, and write the value
 * into the pin file by hand. There is no mode in which this module updates a pin for you.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Every field a pin entry must carry before it can be fetched at all. */
const REQUIRED = ['url', 'cachePath'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read one dataset's pin entry out of a `pin.json`, refusing a shape that cannot be checked.
 *
 * @param {string} pinPath  path to a benchmark folder's `pin.json`
 * @param {string} name     key under `datasets`
 */
export function readPin(pinPath, name) {
  const doc = JSON.parse(readFileSync(pinPath, 'utf8'));
  const entry = doc?.datasets?.[name];
  if (!entry) throw new Error(`${pinPath} has no pin for dataset "${name}"`);
  for (const key of REQUIRED) {
    if (typeof entry[key] !== 'string' || !entry[key]) {
      throw new Error(`${pinPath}: pin "${name}" is missing ${key}`);
    }
  }
  return entry;
}

/**
 * The cached file for a pin, verified against its hash.
 *
 * Returns the bytes, or throws saying which of the three things is wrong: not fetched, not pinned, or not the
 * file that was pinned. It never repairs and never re-fetches — a benchmark that silently replaces its corpus
 * mid-run is the failure this whole module is about.
 */
export function readPinnedDataset(repoRoot, pinPath, name) {
  const entry = readPin(pinPath, name);
  const path = join(repoRoot, entry.cachePath);
  if (!existsSync(path)) {
    throw new Error(`${name} has not been fetched. Run the fetch for ${entry.url} first.`);
  }
  const bytes = readFileSync(path);
  assertPinned(entry, bytes, name);
  return bytes;
}

/**
 * The refusal, on its own so both callers share it and neither can weaken it.
 *
 * The null case is FIRST and is not folded into the comparison, because folding it in is the bug: an absent
 * hash and a wrong hash are both "this is not the file that was pinned", and only one of them looks like an
 * error to somebody reading the condition.
 */
export function assertPinned(entry, bytes, name) {
  if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64) {
    throw new Error(
      `${name} is recorded but NOT PINNED: its sha256 is ${JSON.stringify(entry.sha256)}. `
      + 'Fetch it with recordHash, check what came back, and write the hash into the pin file by hand. '
      + 'An unpinned dataset is refused rather than used, because a run against an unverified corpus '
      + 'produces a number nobody can reproduce.');
  }
  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new Error(
      `${name} does not match its pin.\n  expected ${entry.sha256}\n  actual   ${actual}\n`
      + 'The file at the pinned URL is not the file this repository measured. Do not overwrite the pin to '
      + 'make this pass — find out what changed upstream and record it.');
  }
  if (typeof entry.bytes === 'number' && entry.bytes !== bytes.length) {
    throw new Error(`${name} matched its hash but not its byte count — the pin file is internally wrong.`);
  }
  return true;
}

/**
 * Fetch a pin's URL and write it to the cache, verifying unless `recordHash` is set.
 *
 * `recordHash` is the one path that accepts an unpinned entry, and it prints the hash rather than storing it:
 * writing the pin is a human act, so that the value in the file is one somebody looked at.
 */
export async function fetchPinned(repoRoot, pinPath, name, { recordHash = false } = {}) {
  const entry = readPin(pinPath, name);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`${entry.url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  if (recordHash) {
    return { bytes, sha256: sha256(bytes), byteLength: bytes.length, written: false };
  }

  assertPinned(entry, bytes, name);
  const path = join(repoRoot, entry.cachePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { bytes, sha256: entry.sha256, byteLength: bytes.length, written: true, path };
}
