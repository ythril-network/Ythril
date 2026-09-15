/**
 * A benchmark corpus is used only when it is the file this repository pinned.
 *
 * ## The failure this exists for
 *
 * A dataset is fetched by URL and refused on a hash mismatch. That rule was written once, for LoCoMo, when
 * there was one pin and its hash was filled in. The second benchmark arrives with `"sha256": null` — nothing
 * has been fetched yet — and the obvious spelling of the check, `if (pin.sha256 && actual !== pin.sha256)`,
 * reads a null hash as *nothing to verify* and writes the file. The corpus is then unverified for as long as
 * nobody re-reads that condition.
 *
 * Nothing contradicts it. A run against the wrong bytes completes, scores something, and looks exactly like a
 * run against the right ones. So the refusal lives in one module and this asserts the rule rather than the
 * site: **every dataset any benchmark folder declares is either pinned with a real hash, or refused.**
 *
 * ## The subject set is derived
 *
 * From `git ls-files benchmarks/ * /pin.json`, never a list — a list is the same defect with a later expiry
 * date, and the folder gains a benchmark whenever one is released. A floor is asserted on what was found,
 * because an empty listing passes every loop written over it.
 *
 * Run: node --test testing/standalone/an-unpinned-dataset-is-refused-not-used.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { assertPinned, readPin, sha256 } = await import('../../benchmarks/dataset-pin.mjs');

/** Every pin file any benchmark folder declares, read out of git rather than named here. */
function pinFiles() {
  const out = execFileSync('git', ['ls-files', 'benchmarks/*/pin.json'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  assert.ok(out.length >= 1, 'no benchmark pin files found at all — the derivation is broken, not the repo');
  return out;
}

/** Every `{ file, name, entry }` triple across all of them. */
function allPins() {
  const rows = [];
  for (const file of pinFiles()) {
    const doc = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    for (const name of Object.keys(doc.datasets ?? {})) rows.push({ file, name, entry: doc.datasets[name] });
  }
  assert.ok(rows.length >= 2, `expected pins for at least two datasets, found ${rows.length}`);
  return rows;
}

describe('every declared dataset can be checked, or is refused', () => {
  it('each pin carries the two fields a fetch cannot proceed without', () => {
    for (const { file, name } of allPins()) {
      assert.doesNotThrow(() => readPin(join(repoRoot, file), name), `${file}: pin "${name}" is unusable`);
    }
  });

  it('a pin with no hash is REFUSED, not treated as nothing to check', () => {
    // The whole reason this module exists. An absent hash and a wrong hash are the same statement — this is
    // not the file that was pinned — and only one of them looks like an error to a reader of the condition.
    for (const sha of [null, undefined, '', 'deadbeef']) {
      assert.throws(() => assertPinned({ sha256: sha }, Buffer.from('x'), 'fixture'), /NOT PINNED/,
        `a sha256 of ${JSON.stringify(sha)} was accepted`);
    }
  });

  it('a real hash that does not match is refused, and says so without offering to fix it', () => {
    const entry = { sha256: sha256(Buffer.from('the pinned bytes')) };
    assert.throws(() => assertPinned(entry, Buffer.from('different bytes'), 'fixture'), err => {
      assert.match(err.message, /does not match its pin/);
      assert.match(err.message, /Do not overwrite the pin/);
      return true;
    });
  });

  it('the matching file passes, and a wrong byte count fails even when the hash matches', () => {
    const bytes = Buffer.from('the pinned bytes');
    assert.equal(assertPinned({ sha256: sha256(bytes), bytes: bytes.length }, bytes, 'fixture'), true);
    assert.throws(() => assertPinned({ sha256: sha256(bytes), bytes: 999 }, bytes, 'fixture'),
      /internally wrong/);
  });
});

describe('an unpinned dataset says so where a reader will see it', () => {
  it('every pin whose hash is absent is described as unpinned in its own file', () => {
    // A null hash is a legitimate state — a benchmark can be recorded before it is fetched. What is not
    // legitimate is a null hash that reads like a filled-in one, so the file has to say it out loud.
    for (const { file, name, entry } of allPins()) {
      if (typeof entry.sha256 === 'string' && entry.sha256.length === 64) continue;
      const src = readFileSync(join(repoRoot, file), 'utf8');
      assert.match(src, /NOT YET PINNED|NOT PINNED/,
        `${file} declares "${name}" with no hash and nowhere says the dataset is unpinned`);
    }
  });

  it('every benchmark folder has a README saying what its benchmark measures', () => {
    const folders = new Set(pinFiles().map(f => f.split('/')[1]));
    const tracked = execFileSync('git', ['ls-files', 'benchmarks'], { cwd: repoRoot, encoding: 'utf8' });
    for (const folder of folders) {
      assert.ok(tracked.includes(`benchmarks/${folder}/README.md`),
        `benchmarks/${folder} pins a dataset and has no README — a corpus nobody describes is a corpus `
        + 'nobody can tell you is the wrong one for the question.');
    }
  });
});
