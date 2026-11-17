/**
 * Which builds of the server's code are missing or older than their source (Q-685, R1).
 *
 * ## What it prevents
 *
 * The standalone files import `server/dist`, which imports the schema package, which resolves only to `schema/dist`. The runner refused a stale
 * `server/dist` and nothing else, so after an edit to `schema/src` the suite ran the OLD package build and reported on code nobody had written.
 * `tsx watch` never rebuilds the package either.
 *
 * ## One question, every root
 *
 * For each root of `SERVER_CODE_ROOTS` (`<package>/src`), the build is `<package>/dist/index.js` and the command that makes it is
 * `npm run build --workspace=<package>`: both derived from the root, so a package added to the constant is refused stale with no second list.
 * A check rather than a build, deliberately: building here would hide the mistake and add a minute to every run; refusing costs milliseconds and
 * says exactly what to do.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SERVER_CODE_ROOTS } from '../standalone/_sources.mjs';

/** The newest `.ts` file under `dir` as a time in ms, 0 when there is none. */
function newestSource(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) t = Math.max(t, newestSource(p));
    else if (e.name.endsWith('.ts')) t = Math.max(t, statSync(p).mtimeMs);
  }
  return t;
}

/**
 * One refusal message per root whose build is absent or older than its newest source; `[]` when every build is current.
 *
 * @param {string} [root] the checkout, default the working directory
 * @returns {string[]}
 */
export function staleBuilds(root = '.') {
  const messages = [];
  for (const src of SERVER_CODE_ROOTS) {
    const pkg = dirname(src);
    const dist = `${pkg}/dist/index.js`;
    const build = `npm run build --workspace=${pkg}`;
    let built;
    try { built = statSync(join(root, dist)).mtimeMs; } catch {
      messages.push(`${dist} is missing: run \`${build}\` first.`);
      continue;
    }
    const newest = newestSource(join(root, src));
    if (newest > built) {
      messages.push(`${pkg}/dist is OLDER than ${src} (${new Date(built).toISOString()} < ${new Date(newest).toISOString()}). These tests import from `
        + `the build, so this run would test a build you did not make. Run \`${build}\`, or pass --allow-stale if that is really what you meant.`);
    }
  }
  return messages;
}
