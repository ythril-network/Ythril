/**
 * The server's own start loads the RDF import's schema step (bundle-270, Q-955 fix round: finding S4).
 *
 * ## The doubt
 *
 * The import act asks for its schema step through `rdfImportSchemaStep()` (`spaces/rdf-import-files.ts`), which throws when nothing registered
 * it: the step registers itself when its module is loaded, and the act cannot import it (the settings write's import cycle). The only load was a
 * side-effect import in the REST route (`api/brain/rdf-import.ts`). A cleanup that dropped that line, or a server wired without the route, would
 * answer every import with `schema` 500 and leave an act that resumes after a restart owed for good, and no test would say so.
 *
 * ## What it holds
 *
 * The static imports of `server/src/index.ts`, followed through every module (`import x from`, `import 'x'`, `export ... from`; a type-only
 * import erases and is not followed), reach `spaces/rdf-import-schema-step.ts`. The same walk over a copy of the route with its side-effect
 * import removed does not (the planted case: the walk can fail).
 *
 * Run: node --test testing/standalone/the-server-loads-the-rdf-import-schema-step-itself.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { readTrackedSources } from './_sources.mjs';

const ENTRY = 'server/src/index.ts';
const STEP = 'server/src/spaces/rdf-import-schema-step.ts';
const ROUTE = 'server/src/api/brain/rdf-import.ts';

/** The files `src` (at `file`) loads statically: a side-effect import, a value import and a re-export, never `import type`. */
function staticImports(src, file, has) {
  const found = new Set();
  const specs = [
    ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;'"]*?\s+from\s+['"]([^'"]+)['"]/gms),
  ].map(m => m[1]);
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    const base = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '');
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (has(candidate)) { found.add(candidate); break; }
  }
  return found;
}

/** Every file reached from `entry` by static imports over `files` (path to text). */
function reachedFrom(entry, files) {
  const has = (p) => files.has(p);
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const next of staticImports(files.get(file), file, has)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

describe('the server loads the RDF import schema step itself', () => {
  const files = new Map(readTrackedSources('server/src', { floor: 300 }).map(f => [f.file, f.text]));

  it('the walk reaches the files it is asked about (it reads something)', () => {
    const seen = reachedFrom(ENTRY, files);
    assert.ok(seen.size > 300, `the walk reached ${seen.size} files`);
    assert.ok(seen.has('server/src/spaces/rdf-import-act.ts'), 'the import act is loaded by the server');
  });

  it('the server start reaches the import schema step', () => {
    assert.ok(reachedFrom(ENTRY, files).has(STEP), `${ENTRY} does not load ${STEP}: an import with schema would answer 500`);
  });

  it('a route without its side-effect import leaves the step unreached (the planted case)', () => {
    const route = files.get(ROUTE);
    const planted = route.replace(/^\s*import\s+['"][^'"]*rdf-import-schema-step\.js['"];?\s*$/m, '');
    assert.notEqual(planted, route, 'the route has the import to remove');
    const without = new Map(files);
    without.set(ROUTE, planted);
    assert.equal(reachedFrom(ENTRY, without).has(STEP), false, 'something else loads the step, so the planted case proves nothing');
  });
});
