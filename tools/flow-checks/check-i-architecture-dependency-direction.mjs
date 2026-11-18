#!/usr/bin/env node
/**
 * check-i-architecture-dependency-direction: imports run the intended direction, and the cycles there are do not grow.
 *
 * Rule (the flow node's stated assertion, read from the relative imports of the tracked non-spec `.ts` of `server/src`, `schema/src` and
 * `client/src/app`, comments stripped; the module set is `git ls-files`, never a list):
 *
 *   - `boundary`:   no relative import leaves the package it is in (the client does not reach into the server, the schema package reaches nothing).
 *   - `transport`:  the transports are the top layer: only `server/src/api/**`, `server/src/mcp/**` and the files directly in `server/src/` (the
 *                   wiring: app, bootstrap, schedulers) import a module under `api/` or `mcp/`.
 *   - `converter`:  a converter does not reach the database: no module under `server/src/extractor/` imports `server/src/db/` directly.
 *   - `util`:       a utility does not import half the app: no module under `server/src/util/` imports from more than half of the other top-level
 *                   folders of `server/src/` (the count of folders is read from the tree).
 *   - cycles:       the import graph of each root has strongly connected sets (cycles). A cycle cannot be fixed in one bundle, so the number of
 *                   cyclic sets and the size of the largest are held to ceilings that only go down.
 *
 * Findings are `boundary:<file>-><target>`, `transport:<file>-><area>`, `converter:<file>`, `util:<file>`; exceptions live only in
 * `check-i-architecture-dependency-direction.allow.json`: `{ id, reason, reviewBy }`, and a ceiling `{ id: "cycles:<root>:components|largest", max,
 * reason, reviewBy }`. An entry with no reason, past its reviewBy, or that excuses nothing any more fails the probe; the verdict says how many it used.
 *
 * The failure that bought it (Q-875): the check was named by the plan and verify phases and answered "cannot answer" from a placeholder, so a
 * lower layer importing a transport, or a new cycle, was found by a reader when it was found at all. The repository has no dependency-cruiser,
 * madge or import lint, so the check cannot be a run of one.
 *
 *     node tools/flow-checks/check-i-architecture-dependency-direction.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { stripComments } from '../../testing/standalone/_strip-comments.mjs';
import { holds, violated, CannotAnswer, answer, isMain } from './_verdict.mjs';
import { graphOf, cyclicSets } from './_import-graph.mjs';
import { allowFileFor, readAllow, applyAllow, applyCeilings, today } from './_allow.mjs';

/** The roots the graph is read over, each the `src` tree of one package. */
export const ROOTS = Object.freeze(['server/src', 'schema/src', 'client/src/app']);
const SERVER = 'server/src';

/** The top-level folder of `server/src` a file is in, or null for a file directly in `server/src` (the wiring) or outside it. */
const topFolder = (file) => {
  const rest = file.startsWith(`${SERVER}/`) ? file.slice(SERVER.length + 1) : '';
  return rest.includes('/') ? rest.split('/')[0] : null;
};
const inTransport = (file) => /^server\/src\/(api|mcp)\//.test(file);
const isWiring = (file) => file.startsWith(`${SERVER}/`) && !file.slice(SERVER.length + 1).includes('/');

/** Does the path a specifier names fall outside the package tree `rootDir`? (Such a path is in no tracked-source set of the root, so the graph reports it as unresolved.) */
const leavesRoot = (target, rootDir) => target !== rootDir && !target.startsWith(`${rootDir}/`);

/** `[{ id, text }]` direction findings over one root's graph (the server rules apply to the server root only; the boundary rule to every root). */
export function directionFindings(graph, rootDir, serverFolders) {
  const out = [];
  const half = serverFolders.length / 2;
  for (const u of graph.unresolved) if (leavesRoot(u.target, rootDir)) out.push({ id: `boundary:${u.file}->${u.target}`, text: `${u.file} imports ${u.target}, outside ${rootDir}` });
  for (const [file, targets] of graph.edges) {
    for (const t of targets) {
      if (rootDir !== SERVER) continue;
      if (inTransport(t) && !inTransport(file) && !isWiring(file)) out.push({ id: `transport:${file}->${/\/api\//.test(t) ? 'api' : 'mcp'}`, text: `${file} imports the ${/\/api\//.test(t) ? 'api' : 'mcp'} transport (${t})` });
      if (file.startsWith('server/src/extractor/') && t.startsWith('server/src/db/')) out.push({ id: `converter:${file}`, text: `${file} (a converter) imports the database layer (${t})` });
    }
    if (rootDir === SERVER && file.startsWith('server/src/util/')) {
      const folders = new Set(targets.map(topFolder).filter((f) => f && f !== 'util'));
      if (folders.size > half) out.push({ id: `util:${file}`, text: `${file} (a utility) imports ${folders.size} of ${serverFolders.length} server folders` });
    }
  }
  // One finding per id (a file importing two modules of one transport is one finding).
  return [...new Map(out.map((f) => [f.id, f])).values()];
}

/** Cycle measures per root: the number of cyclic sets and the size of the largest. */
export function cycleMeasures(rootDir, graph) {
  const sets = cyclicSets(graph.edges);
  return [
    { id: `cycles:${rootDir}:components`, value: sets.length, text: `${sets.length} cyclic set(s) in ${rootDir}` },
    { id: `cycles:${rootDir}:largest`, value: sets.reduce((m, s) => Math.max(m, s.length), 0), text: `a cyclic set of ${sets.reduce((m, s) => Math.max(m, s.length), 0)} modules in ${rootDir}` },
  ];
}

/** `graphs` is `{ [root]: graph }` from {@link graphOf}. */
export function decide(graphs, allow, todayDate) {
  for (const [root, g] of Object.entries(graphs)) {
    const edgeCount = [...g.edges.values()].reduce((n, t) => n + t.length, 0);
    const broken = g.unresolved.filter((u) => !leavesRoot(u.target, root));
    if (broken.length > Math.max(3, edgeCount * 0.02)) throw new CannotAnswer(`${broken.length} import(s) in ${root} name a path no tracked source holds (e.g. ${broken[0].file} -> ${broken[0].spec}): the graph is broken`);
  }
  const serverFolders = [...new Set([...graphs[SERVER].edges.keys()].map(topFolder).filter((f) => f && f !== 'util'))];
  const found = Object.entries(graphs).flatMap(([root, g]) => directionFindings(g, root, serverFolders));
  const measures = Object.entries(graphs).flatMap(([root, g]) => cycleMeasures(root, g));
  const ceilings = allow.filter((e) => 'max' in e);
  const excuses = allow.filter((e) => !('max' in e));
  const a = applyAllow(found, excuses, todayDate);
  if (a.problem) return violated(a.problem);
  const c = applyCeilings(measures, ceilings, todayDate);
  if (c.problem) return violated(c.problem);
  const files = Object.values(graphs).reduce((n, g) => n + g.edges.size, 0);
  const tail = `${files} module(s) in ${Object.keys(graphs).join(', ')}, ${a.used + c.used} exception(s) used${c.slack.length ? `; ceilings above their measure, lower them: ${c.slack.join('; ')}` : ''}`;
  const bad = [...a.open.map((f) => f.text), ...c.over.map((m) => `${m.text}, above its ceiling`)];
  return bad.length
    ? violated(`${bad.length} direction problem(s): ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? `; and ${bad.length - 6} more` : ''} (${tail})`)
    : holds(`imports run the intended direction and the cycles do not grow (${tail})`);
}

/** The comment-stripped sources of the checkout at `root`, per source root: `{ [root]: { file, code }[] }`. */
export function readSources(root = REPO_ROOT) {
  const byRoot = {};
  for (const dir of ROOTS) {
    const files = trackedSources([dir], { ext: ['.ts'], specs: false, floor: dir === 'schema/src' ? 5 : 100, root }).filter((f) => !f.endsWith('.spec.ts'));
    byRoot[dir] = files.map((file) => ({ file, code: stripComments(readFileSync(join(root, file), 'utf8')) }));
  }
  return byRoot;
}

/** The import graph of each root from its sources. */
export const graphsOf = (byRoot) => Object.fromEntries(Object.entries(byRoot).map(([dir, sources]) => [dir, graphOf(sources)]));

/** The graphs of the checkout at `root`. */
export const readGraphs = (root = REPO_ROOT) => graphsOf(readSources(root));

if (isMain(import.meta.url)) await answer(() => decide(readGraphs(), readAllow(allowFileFor(import.meta.url)), today()));
