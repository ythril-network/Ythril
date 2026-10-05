/**
 * A scratch repository holding the real tracked test layout, for a script that answers a question about "this repo".
 *
 * ## Why it exists
 *
 * `scripts/unrun-tests.mjs`, `scripts/executed-tests.mjs` and `splitStandalone()` all read the repo they run in:
 * `git ls-files`, `package.json`, the workflow, the vitest config. To show one of them refuse a file that nothing
 * reaches, the test has to ADD such a file, and it must not do that to the working tree it is being run from (a
 * gate that dirties the checkout is a gate people stop trusting). So the question is put to a COPY: every tracked
 * file under `testing/`, `.github/`, `scripts/`, the client's specs and its test configuration, plus the root and
 * client `package.json`, in a temporary directory with its own git index.
 *
 * It copies the real files rather than writing small ones, so the derivations under test read the formats this
 * repository actually uses — a fixture written in the shape the author of the script expected would prove the
 * script reads the fixture.
 *
 * `with({ add, replace }, fn)` changes the copy for the length of `fn` and puts it back, so one copy serves a
 * whole file of cases.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';

/** Every tracked file of a checkout, floor inside: the copy is meant to hold the real layout, so a short listing proves nothing. */
const trackedIn = (root) => trackedSources(['.'], { ext: null, floor: 500, root });

/** The tracked files a copy needs: the test layout and what decides which of it runs. */
function filesToCopy() {
  return trackedIn(REPO_ROOT).filter(f => f.startsWith('testing/') || f.startsWith('.github/') || f.startsWith('scripts/')
    || f === 'package.json' || f === 'client/package.json' || /^client\/(vitest|vite)[^/]*\.[mc]?[jt]s$/.test(f)
    || /^client\/src\/.*(\.spec\.ts|test-setup\.ts)$/.test(f));
}

/**
 * @returns {{ root: string, tracked: () => string[], with: <T>(changes: { add?: Record<string,string>, replace?: Record<string,(text:string)=>string>, remove?: string[] }, fn: () => T) => T, dispose: () => void }}
 */
export function makeCiRoot() {
  const files = filesToCopy();
  if (files.length < 500) throw new Error(`only ${files.length} files to copy — the layout filter matched too little, so the copy would prove nothing`);
  const { dir: root, git, cleanup } = makeScratchRepo({ prefix: 'ythril-ci-root-' });
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    copyFileSync(join(REPO_ROOT, f), join(root, f));
  }
  git('add', '-A');

  const tracked = () => trackedIn(root);
  return {
    root,
    tracked,
    with(changes, fn) {
      const { add = {}, replace = {}, remove = [] } = changes;
      const undo = [];
      for (const [rel, text] of Object.entries(add)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
        undo.push(() => rmSync(join(root, rel), { force: true }));
      }
      for (const [rel, edit] of Object.entries(replace)) {
        const before = readFileSync(join(root, rel), 'utf8');
        const after = edit(before);
        if (after === before) throw new Error(`the edit to ${rel} changed nothing — the fixture no longer matches the file`);
        writeFileSync(join(root, rel), after);
        undo.push(() => writeFileSync(join(root, rel), before));
      }
      for (const rel of remove) {
        if (!existsSync(join(root, rel))) throw new Error(`${rel} is not in the copy — nothing to remove`);
        const before = readFileSync(join(root, rel));
        rmSync(join(root, rel));
        undo.push(() => writeFileSync(join(root, rel), before));
      }
      git('add', '-A');
      try {
        return fn();
      } finally {
        for (const u of undo.reverse()) u();
        git('add', '-A');
      }
    },
    dispose: cleanup,
  };
}
