/**
 * What source files does the client app have? Tracked, non-spec `.ts` under `src/app`, relative to `client/`.
 *
 * `git ls-files`, never readdir: a gitignored or generated file is not the app, and a gate that reads one
 * passes locally on a file no clone, image or CI run has.
 *
 * **It throws instead of returning a short list, and that is the reason it is a module.** An empty listing —
 * git missing from PATH, the spec run from the wrong directory — passes every loop written over it, and a
 * gate built on that loop reports clean about nothing. The floor is the line a hand-written copy drops,
 * because it looks like boilerplate.
 *
 * vitest runs with cwd = client/; the path is resolved from this file rather than from `import.meta.url`,
 * which throws at collection under vitest and leaves the suite reporting no tests.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** The client package root. */
export const CLIENT_ROOT = resolve(__dirname, '../../..');

/** Far below the real count (hundreds); it exists to tell "none found" from "found". */
const FLOOR = 50;

export function trackedAppSources(): string[] {
  const files = execFileSync('git', ['ls-files', 'src/app'], { cwd: CLIENT_ROOT, encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim().replace(/\\/g, '/'))
    .filter(p => p.endsWith('.ts') && !p.endsWith('.spec.ts'));
  if (files.length < FLOOR) {
    throw new Error(`git ls-files found ${files.length} client sources under src/app — fewer than ${FLOOR}, so `
      + 'the listing failed rather than the app shrinking. A gate over this list would report clean about nothing.');
  }
  return files;
}
