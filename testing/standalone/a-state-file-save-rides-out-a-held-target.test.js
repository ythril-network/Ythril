/**
 * A state file's save rides out a target another handle holds open for a moment, and every save goes through the one renamer.
 *
 * ## The rule
 *
 *  1. `renameOverSync` retries a rename refused as `EPERM`, `EACCES` or `EBUSY` (what Windows answers while anything holds the target
 *     open) and succeeds once the target is free.
 *  2. Any other refusal is thrown at once, after one attempt: a missing source is not waited for.
 *  3. Every module under `server/src/config/` that saves a file renames it through `renameOverSync`, never `fs.renameSync` by hand.
 *     The set is derived from the source, with a floor: the loader is one of them.
 *
 * ## Seen red
 *
 * 3 failed on the base: `config/loader.ts` renamed six state files with a bare `fs.renameSync`, and on a Windows host the vote-round
 * expiry's config save was refused (`EPERM ... rename config.json.tmp -> config.json`) in preflight runs.
 *
 * Run: node --test testing/standalone/a-state-file-save-rides-out-a-held-target.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let renameOverSync;
let dir;
const realRename = fs.renameSync;

/** `fs.renameSync` refusing with `code` for the first `times` calls, then renaming; the calls are counted. */
function refuseFirst(code, times) {
  const seen = { calls: 0 };
  fs.renameSync = (src, dst) => {
    seen.calls += 1;
    if (seen.calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
    return realRename(src, dst);
  };
  return seen;
}

describe('a state file save rides out a held target', () => {
  before(async () => {
    ({ renameOverSync } = await import('../../server/dist/util/rename-over.js'));
    dir = fs.mkdtempSync(path.join(process.env['YTHRIL_TEMP_ROOT'] ?? os.tmpdir(), 'rename-over-'));
  });
  after(() => {
    fs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`a rename refused as ${code} is retried and lands (1)`, () => {
      const src = path.join(dir, `${code}.tmp`);
      const dst = path.join(dir, `${code}.json`);
      fs.writeFileSync(dst, 'old');
      fs.writeFileSync(src, 'new');
      const seen = refuseFirst(code, 2);
      try { renameOverSync(src, dst); } finally { fs.renameSync = realRename; }
      assert.equal(seen.calls, 3, 'the rename was not tried again after a transient refusal');
      assert.equal(fs.readFileSync(dst, 'utf8'), 'new');
    });
  }

  it('any other refusal is thrown after one attempt (2)', () => {
    const seen = refuseFirst('ENOENT', 5);
    try {
      assert.throws(() => renameOverSync(path.join(dir, 'missing.tmp'), path.join(dir, 'x.json')), /ENOENT/);
    } finally { fs.renameSync = realRename; }
    assert.equal(seen.calls, 1, 'a refusal that is not transient was retried');
  });

  it('every config module renames its saves through renameOverSync (3)', () => {
    const files = execFileSync('git', ['ls-files', 'server/src/config/*.ts'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(files.length >= 5, `only ${files.length} config modules found: the listing is broken`);
    const bare = [];
    const through = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/\bfs\.renameSync\s*\(/.test(src)) bare.push(f);
      if (/\brenameOverSync\s*\(/.test(src)) through.push(f);
    }
    assert.deepEqual(bare, [], 'these config modules rename a saved file by hand; use renameOverSync (util/rename-over.ts)');
    assert.ok(through.includes('server/src/config/loader.ts'), 'the loader saves through renameOverSync: the rule is about something');
  });
});
