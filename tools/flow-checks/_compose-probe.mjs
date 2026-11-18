/**
 * The compose files a probe reads, and the one reader that parses them, with the modules folder the a11y probes take.
 *
 * ## What it prevents
 *
 * A probe that parses a compose file with a YAML reader of its own. `testing/_shared/compose-file.mjs` is the repository's one reader (it
 * knows compose's `!reset` and `!override` tags and resolves `${VAR:-default}`), and it needs `js-yaml`, which a checkout without an install
 * does not have. The probe therefore takes `--modules <folder>` (or `FLOW_MODULES`) like the a11y probes: the folder that holds `js-yaml`
 * (a `node_modules` folder, or the folder that holds one). Without the flag the reader loads `js-yaml` from the checkout, as the repository's
 * own tests do; if that fails the probe says `cannot answer`, never `holds`.
 *
 * ## Which files
 *
 * The tracked compose files of the checkout that ship to a deployment: every `docker-compose*.yml` / `compose*.yml` that is not under
 * `testing/` (the test stack is a harness, held to its own gates). The list is `git ls-files`, with a floor inside.
 */
import { createRequire, register } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { CannotAnswer } from './_verdict.mjs';

/** `--modules <folder>` (also `--modules=<folder>`), else `FLOW_MODULES`, else ''. */
export function modulesFlag(argv, env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--modules(?:=(.*))?$/.exec(argv[i]);
    if (m) return m[1] ?? argv[i + 1] ?? '';
  }
  return env.FLOW_MODULES || '';
}

/** The tracked compose files that ship to a deployment, repo-relative. */
export function deploymentComposeFiles(root = REPO_ROOT) {
  const files = trackedSources(['.'], { ext: null, floor: 100, root })
    .filter((f) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(f) && !f.startsWith('testing/'));
  if (!files.length) throw new CannotAnswer('no tracked compose file outside testing/ was found');
  return files;
}

/** The networks a service is on: a list or a map in compose, `default` when it names none. */
export function networksOf(service) {
  const n = service.networks;
  if (!n) return ['default'];
  return Array.isArray(n) ? n.map(String) : Object.keys(n);
}

/**
 * `{ database, app, parsers }` (sets of service names) from the topology of one compose document, never from a list: the database is the
 * service whose image names mongo, the app is every other service that shares a network with it, a parser is everything else. A service added
 * tomorrow lands in one of the three by what it is attached to.
 */
export function rolesOf(doc) {
  const names = Object.keys(doc.services);
  const database = new Set(names.filter((n) => /mongo/i.test(String(doc.services[n].image ?? ''))));
  const dbNets = new Set([...database].flatMap((n) => networksOf(doc.services[n])));
  const app = new Set(names.filter((n) => !database.has(n) && networksOf(doc.services[n]).some((net) => dbNets.has(net))));
  return { database, app, parsers: new Set(names.filter((n) => !database.has(n) && !app.has(n))) };
}

/** The ESM entry of the `js-yaml` that `dir` holds, as a file URL. */
function yamlEntry(dir) {
  const req = createRequire(join(resolve(dir), 'noop.js'));
  let pkgFile;
  try { pkgFile = req.resolve('js-yaml/package.json'); }
  catch (e) { throw new CannotAnswer(`js-yaml cannot be found from ${resolve(dir)}: ${String(e.message).split('\n')[0]}`); }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const entry = pkg.exports?.['.']?.import ?? pkg.module;
  if (!entry) throw new CannotAnswer(`js-yaml at ${dirname(pkgFile)} has no ES module entry`);
  return pathToFileURL(join(dirname(pkgFile), entry)).href;
}

/**
 * The compose reader module (`testing/_shared/compose-file.mjs`): `{ loadCompose, memoryMiB, resolvedValue, environmentOf, ... }`.
 * With `modules`, the reader's `js-yaml` import is redirected to that folder's copy; without it, the checkout's own install is used.
 */
export async function composeReader({ modules = '', root = REPO_ROOT } = {}) {
  if (modules) {
    const target = yamlEntry(modules);
    const hook = `export async function resolve(specifier, context, next) { if (specifier === 'js-yaml') return { url: ${JSON.stringify(target)}, shortCircuit: true }; return next(specifier, context); }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
  }
  try {
    return await import(pathToFileURL(join(root, 'testing', '_shared', 'compose-file.mjs')).href);
  } catch (e) {
    throw new CannotAnswer(`the compose reader cannot load (${String(e.message).split('\n')[0]}): pass --modules <folder holding js-yaml> or run npm ci`);
  }
}
