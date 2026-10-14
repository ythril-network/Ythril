/**
 * The production closure of one package, read out of `package-lock.json`, and the question "does NOTICE name each of them".
 *
 * ## What it prevents
 *
 * `notice-coverage.test.js` reads the DIRECT dependencies of both workspaces, and says why it stops there ("a gate nobody can
 * satisfy is a gate that gets deleted"). `jszip` showed the cost of that limit once: transitive, in the browser bundle, unattributed,
 * found by a person. A rule engine (`@bufbuild/cel`) is the first dependency added since whose licence story is carried by its
 * CHILDREN: the engine's own package ships no licence file, its spec data is derived from Google's, its protobuf runtime
 * carries a Google-named BSD clause, its regex engine is a port with two copyright holders. The obligation travels with each one
 * of them, so the question is asked of the whole closure of THIS dependency — bounded, and a set a person can keep honest —
 * without widening the direct-dependency gate to thousands.
 *
 * ## What it decides, once
 *
 * - which edges are production: `dependencies`, `optionalDependencies` and `peerDependencies` of a package whose lock entry is not
 *   `dev`; a development-only package is a build tool and reaches no user;
 * - how a name resolves: the nearest `node_modules/<name>` going up from the requiring package (npm's own rule), so a nested copy
 *   is the one that ships and a hoisted one is found;
 * - what counts as named: a `###` or `####` heading of NOTICE that lists the FULL scoped name (`@bufbuild/cel`), alone or in a
 *   comma-separated list as the Angular packages are. A bare `cel` is not a name; a body sentence is not a heading.
 */

/** The lock's `packages` map, from `package-lock.json` text. */
export const packagesOf = (lockText) => JSON.parse(lockText).packages ?? {};

/** The lock key a requirement resolves to, from the package at `fromKey` (`''` is the root, `server` a workspace). */
function resolveKey(packages, fromKey, name) {
  /** The package whose `node_modules` holds `key`: `a/node_modules/b` is under `a`, anything else is under the root (`''`). */
  const parentOf = (key) => {
    const cut = key.lastIndexOf('/node_modules/');
    return cut === -1 ? '' : key.slice(0, cut);
  };
  let base = fromKey;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (base === '') return null;
    base = parentOf(base);
  }
}

/**
 * Every package `entryName` pulls into production, itself included: `[{ name, key, version, license }]`, in discovery order.
 * `from` is the workspace that declares the dependency (`server`). Throws when the entry is not in the lock.
 */
export function productionClosure(packages, entryName, from = 'server') {
  const start = resolveKey(packages, from, entryName);
  if (!start) throw new Error(`${entryName} is not in the lock file (looked from '${from}')`);
  const seen = new Map();
  const queue = [start];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    const entry = packages[key];
    if (!entry || entry.dev === true) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    seen.set(key, { name, key, version: entry.version, license: entry.license ?? null });
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(entry[field] ?? {})) {
        const next = resolveKey(packages, key, dep);
        if (next) queue.push(next);
      }
    }
  }
  return [...seen.values()];
}

/** The package names the headings of a NOTICE list (`### a, b` gives both), full scoped names only. */
export function noticeHeadingNames(noticeText) {
  const names = new Set();
  for (const line of noticeText.split(/\r?\n/)) {
    const m = /^#{3,4}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) names.add(part.trim().replace(/^`|`$/g, '').toLowerCase());
  }
  return names;
}

/** Which of `names` no NOTICE heading carries. */
export const missingFromNotice = (names, noticeText) => {
  const headings = noticeHeadingNames(noticeText);
  return names.filter(n => !headings.has(n.toLowerCase()));
};
