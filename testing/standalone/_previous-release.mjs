/**
 * The code of an EARLIER RELEASE, loaded as it shipped — so a version-skew test runs the receiver a peer really has.
 *
 * ## The question it answers
 *
 * *"What does a network peer on release X do with this?"* A test that answers it with a literal ("the old body refuses unknown keys") records
 * what the author believed about the old release on the day it was written; the old release's own source cannot be believed wrongly.
 * `sync-protocol.md` says an older receiver refuses a meta carrying a key it does not know, WHOLE; that sentence is the premise the
 * tolerant reader (R6-7) and the writer's warning about older members stand on, so the premise is run, not quoted.
 *
 * ## How
 *
 * Each module is read with `git show <tag>:<path>`, transpiled, written to a scratch directory and imported. Its relative imports are
 * rewritten: to another module of the same request (so the old `replicated-meta` reads the OLD `body-schemas`), and otherwise to the
 * CURRENT build's `server/dist` (the old receiver's helpers — the library, the redos check, the log — are not what is under test).
 * Bare imports (`zod`) resolve from `server/`.
 *
 * ## The guards a hand-written copy drops
 *
 * - **An absent tag is a failure on CI**, a skip elsewhere (`absentInputReason`): a runner that cannot read the tag must not report green
 *   for a skew test that never ran.
 * - **The scratch directory is removed**, whichever way the run ends.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { ts } from '../_shared/syntax-tree.mjs';
import { absentInputReason } from '../_shared/absent-input.mjs';

/** The release the version-skew tests compare against: the one before the release this bundle ships in. */
export const PREDECESSOR_TAG = 'v5.6.10';

/** The source of `path` at `tag`, or null when the tag or the file is not in this checkout. */
export function sourceAt(tag, path) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', `${tag}:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** A skip reason when `tag` cannot be read from this checkout (a failure on CI), or `false` when it can. */
export function releaseSkipReason(tag = PREDECESSOR_TAG) {
  return sourceAt(tag, 'server/src/spaces/body-schemas.ts') === null
    ? absentInputReason(`the release tag ${tag} is not in this checkout`, 'Fetch tags (git fetch --tags) in the checkout step: a version-skew test needs the predecessor\'s own source.')
    : false;
}

/**
 * Import `paths` (repo-relative `.ts` sources) as they were at `tag`.
 *
 * @param {string[]} paths
 * @param {{tag?: string}} [opts]
 * @returns {Promise<{modules: Record<string, any>, cleanup: () => void}>} keyed by the path as given
 */
export async function loadRelease(paths, { tag = PREDECESSOR_TAG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ythril-release-'));
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    const require = createRequire(join(REPO_ROOT, 'server', 'package.json'));
    const target = new Map(paths.map(p => [p, join(dir, p.replace(/[\\/]/g, '__').replace(/\.ts$/, '.mjs'))]));
    for (const p of paths) {
      const text = sourceAt(tag, p);
      if (text === null) throw new Error(`${p} is not in ${tag}`);
      const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      // Only real module specifiers: a statement that starts a line (`import … from '…'`, `export … from '…'`, `import '…'`) or a dynamic
      // `import('…')` — never a string that happens to contain the words ("the value does not match" follows `from ` in a message).
      const out = js.replace(/^(\s*(?:import|export)\b[^;'"\n]*?\bfrom\s+|\s*import\s+|[^\n'"]*\bimport\s*\(\s*)(['"])([^'"\n]+)\2/gm, (whole, lead, q, spec) => {
        if (spec.startsWith('node:')) return whole;
        if (spec.startsWith('.')) {
          const asSource = posix.normalize(posix.join(posix.dirname(p), spec)).replace(/\.js$/, '.ts');
          const sibling = target.get(asSource);
          if (sibling) return `${lead}${q}${pathToFileURL(sibling).href}${q}`;
          return `${lead}${q}${pathToFileURL(resolve(REPO_ROOT, asSource.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js'))).href}${q}`;
        }
        return `${lead}${q}${pathToFileURL(require.resolve(spec)).href}${q}`;
      });
      mkdirSync(dirname(target.get(p)), { recursive: true });
      writeFileSync(target.get(p), out);
    }
    const modules = {};
    for (const p of paths) modules[p] = await import(pathToFileURL(target.get(p)).href);
    return { modules, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
