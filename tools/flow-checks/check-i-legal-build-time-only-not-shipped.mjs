#!/usr/bin/env node
/**
 * check-i-legal-build-time-only-not-shipped: nothing used only at build time ends up in the shipped image or bundle.
 *
 * Rule (the flow node's stated assertion: the image's `node_modules` listing meets each `package.json`'s `devDependencies` in the empty set). The
 * image itself needs a Docker build, so the probe reads what decides its listing, from tracked files only:
 *
 *   - `image`:   in the `Dockerfile`, the last stage is the shipped one; every `node_modules` it takes `COPY --from=<stage>` comes from a stage that
 *                installed with `npm ci|install ... --omit=dev` (or `--production`), following `FROM <stage>` inheritance; the shipped stage itself runs
 *                no `npm ci|install` without that flag.
 *   - `import`:  no tracked non-spec source of a workspace (`server/src`, `schema/src`, `client/src`) imports a package that some `package.json` declares
 *                in `devDependencies` and the workspace does not declare as a dependency, peer or optional: that import is a build tool in shipped code.
 *   - `closure`: no package a workspace declares in its own `devDependencies` is in that workspace's production closure in `package-lock.json`
 *                (`testing/standalone/_notice-closure.mjs`): the lock's listing of what an `--omit=dev` install holds, met with the dev list.
 *
 * Findings are `image:<kind>`, `import:<workspace>:<package>`, `closure:<workspace>:<package>`; exceptions live only in
 * `check-i-legal-build-time-only-not-shipped.allow.json` (`{ id, reason, reviewBy }`); an entry with no reason, past its reviewBy, or that excuses nothing
 * fails the probe. The listing of a built image is the other probe's (`check-i-legal-deep-notice-against-image`).
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, so a build tool that
 * reached the image would have been found by a person reading a NOTICE.
 *
 *     node tools/flow-checks/check-i-legal-build-time-only-not-shipped.mjs
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { packagesOf, workspaceClosure } from '../../testing/standalone/_notice-closure.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { graphOf, reachableFrom } from './_import-graph.mjs';

/** The workspaces whose source ships, with the folder their `package.json` and `src` live in. */
export const WORKSPACES = Object.freeze([
  { name: 'server', dir: 'server', src: 'server/src' },
  { name: 'schema', dir: 'schema', src: 'schema/src' },
  { name: 'client', dir: 'client', src: 'client/src' },
]);

const OMITS_DEV = /--omit[= ]dev\b|--production\b|--only[= ]production\b/;

/** The stages of a Dockerfile: `[{ name, from, lines }]` in order, `from` the base (an earlier stage name or an image). */
export function stagesOf(text) {
  const stages = [];
  for (const raw of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (f) stages.push({ name: f[2] ?? `#${stages.length}`, from: f[1], lines: [] });
    else if (stages.length && line && !line.startsWith('#')) stages[stages.length - 1].lines.push(line);
  }
  return stages;
}

/** Does the stage `name` hold only a production install: its own (or its base stage's) `npm ci|install` carries the omit-dev flag? */
export function installsProductionOnly(stages, name) {
  const stage = stages.find((s) => s.name === name);
  if (!stage) return false;
  const installs = stage.lines.filter((l) => /^RUN\b/i.test(l) && /\bnpm\s+(ci|install|i)\b/.test(l));
  if (installs.length) return installs.every((l) => OMITS_DEV.test(l));
  return installsProductionOnly(stages, stage.from);
}

/** `[{ id, text }]` for the shipped (last) stage of a Dockerfile. */
export function imageFindings(dockerfile) {
  const stages = stagesOf(dockerfile);
  if (stages.length < 2) throw new CannotAnswer('the Dockerfile has fewer than two stages: the shipped stage cannot be told from a build stage');
  const shipped = stages[stages.length - 1];
  const out = [];
  if (shipped.lines.some((l) => /^RUN\b/i.test(l) && /\bnpm\s+(ci|install|i)\b/.test(l) && !OMITS_DEV.test(l))) out.push({ id: 'image:install-in-shipped-stage', text: `the shipped stage ${shipped.name} runs an npm install without --omit=dev` });
  for (const l of shipped.lines) {
    const c = /^COPY\s+--from=(\S+)\s+(\S+)/i.exec(l);
    if (c && /node_modules\b/.test(c[2]) && !installsProductionOnly(stages, c[1])) out.push({ id: `image:node_modules-from-${c[1]}`, text: `the shipped stage copies node_modules from ${c[1]}, which is not a production-only install` });
  }
  return out;
}

/** The bare package names a source imports (`@scope/name` and `name`, sub-paths cut), comments stripped. */
export function bareImports(code) {
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^./'"][^'"]*)['"]/g)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith('node:'))
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
}

const BUILTIN = new Set(builtinModules.map((m) => m.split('/')[0]));

/**
 * `[{ id, text }]` from the manifests and sources.
 * @param {{ name: string, manifest: object, sources: {file: string, code: string}[] }[]} workspaces
 * @param {object[]} allManifests every `package.json` (root and workspaces)
 */
export function importFindings(workspaces, allManifests) {
  const dev = new Set(allManifests.flatMap((m) => Object.keys(m.devDependencies ?? {})));
  const out = [];
  for (const w of workspaces) {
    const prod = new Set([...Object.keys(w.manifest.dependencies ?? {}), ...Object.keys(w.manifest.peerDependencies ?? {}), ...Object.keys(w.manifest.optionalDependencies ?? {}), w.manifest.name]);
    for (const { file, code } of w.sources) {
      for (const pkg of new Set(bareImports(code))) {
        if (BUILTIN.has(pkg) || prod.has(pkg) || !dev.has(pkg)) continue;
        out.push({ id: `import:${w.name}:${pkg}`, text: `${file} imports ${pkg}, which a package.json declares only as a devDependency` });
      }
    }
  }
  return [...new Map(out.map((f) => [f.id, f])).values()];
}

/** `[{ id, text }]` for each package a workspace declares in `devDependencies` that its own production closure holds. */
export function closureFindings(workspaces, packages) {
  const out = [];
  for (const w of workspaces) {
    const dev = Object.keys(w.manifest.devDependencies ?? {});
    if (!dev.length) continue;
    const closure = new Set(workspaceClosure(packages, w.dir).map((p) => p.name));
    for (const name of dev) if (closure.has(name)) out.push({ id: `closure:${w.name}:${name}`, text: `${w.name} declares ${name} as a devDependency, yet its production closure in the lock holds it` });
  }
  return out;
}

export function decide({ dockerfile, workspaces, allManifests, packages }, allow, todayDate) {
  const found = [...imageFindings(dockerfile), ...importFindings(workspaces, allManifests), ...closureFindings(workspaces, packages)];
  const { problem, open, used } = applyAllow(found, allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${workspaces.length} workspace(s), ${workspaces.reduce((n, w) => n + w.sources.length, 0)} source(s), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} build-time package(s) may reach the shipped image or bundle: ${open.slice(0, 6).map((f) => f.text).join('; ')}${open.length > 6 ? `; and ${open.length - 6} more` : ''} (${tail})`)
    : holds(`the shipped stage takes only a production install, and no shipped source or production closure meets a devDependency (${tail})`);
}

/** The browser entry `client/angular.json` builds from (its `browser` option), repo-relative. */
export function clientEntry(angularJsonText) {
  const find = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.browser === 'string' && node.browser.endsWith('.ts')) return node.browser;
    for (const v of Object.values(node)) { const r = find(v); if (r) return r; }
    return null;
  };
  const entry = find(JSON.parse(angularJsonText));
  if (!entry) throw new CannotAnswer('client/angular.json names no browser entry');
  return `client/${entry}`;
}

/**
 * The sources that ship: every non-spec source of the server and the schema package, and of the client only what the browser entry reaches (the
 * client keeps test harnesses beside its code, which import vitest and ship nowhere).
 */
export function shippedSources(w, sources, entry) {
  if (w.name !== 'client') return sources;
  const { edges } = graphOf(sources);
  const reach = reachableFrom(edges, [entry]);
  if (reach.size < sources.length / 2) throw new CannotAnswer(`only ${reach.size} of ${sources.length} client sources are reachable from ${entry}: the graph is broken`);
  return sources.filter((s) => reach.has(s.file));
}

/** The inputs from the checkout at `root`. */
export function readInputs(root = REPO_ROOT) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const entry = clientEntry(read('client/angular.json'));
  const workspaces = WORKSPACES.map((w) => ({
    ...w,
    manifest: JSON.parse(read(`${w.dir}/package.json`)),
    sources: shippedSources(w, trackedSources([w.src], { ext: ['.ts'], specs: false, floor: w.name === 'schema' ? 5 : 100, root })
      .filter((f) => !f.endsWith('.spec.ts')).map((file) => ({ file, code: stripComments(read(file)) })), entry),
  }));
  return { dockerfile: read('Dockerfile'), workspaces, allManifests: [JSON.parse(read('package.json')), ...workspaces.map((w) => w.manifest)], packages: packagesOf(read('package-lock.json')) };
}

if (isMain(import.meta.url)) await answer(() => decide(readInputs(), readAllow(allowFileFor(import.meta.url)), today()));
