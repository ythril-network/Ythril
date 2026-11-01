/**
 * No module outside `server/src/api/` imports from it, except the ones listed below with their reason (bundle-40 pre-ship A2, `Q-267`).
 *
 * ## What it prevents
 *
 * `server/src/api/` is the HTTP doors: a router, its request schemas and its answers. A module under `spaces/`, `db/`, `brain/` or `sync/` that
 * imports from it depends on a door, so the door cannot move or change without the core moving with it, and the import graph runs both ways
 * through the layer that should only call in. The import act (`spaces/import-act.ts`) took the importer core from `api/admin-import.ts`, the one
 * such import a space act had; the core now lives in `sync/space-import.ts`, and this gate keeps the next one out.
 *
 * ## How it reads
 *
 * Every tracked `.ts` under `server/src` outside `server/src/api` (`git ls-files`, with a floor), comments blanked, every static `from '...'`,
 * dynamic `import('...')` and `export ... from '...'` whose specifier resolves into `server/src/api/`. An exception is a file and its reason; a
 * listed file that no longer imports from the api is named too, so the list cannot outlive what it excuses.
 *
 * ## Seen red
 *
 * On 505b5790c `server/src/spaces/import-act.ts` imports `importSpool`, `restoreOriginOf` and `ImportResult` from `../api/admin-import.js`.
 *
 * Run: `node --test testing/standalone/no-module-outside-the-api-imports-from-it.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** Files outside the api that import from it, each with why it may. */
const EXCEPTIONS = new Map([
  ['server/src/app.ts', 'the application mounts every router: it is where the doors are wired, so it imports each of them'],
  ['server/src/auth/middleware.ts', 'decorates a JSON answer (`api/decorate-json-answer.ts`), the answer shape every door shares; the middleware is itself a door step'],
  ['server/src/mcp/schema-warnings.ts', 'the MCP door reads the same answer decoration the REST doors write (`api/decorate-json-answer.ts`)'],
  ['server/src/networks/join-remote-act.ts', 'a network act validates a peer URL and hashes a secret with the networks routers\' shared vocabulary (`api/networks/_shared.ts`)'],
  ['server/src/networks/member-acts.ts', 'a network act validates a peer URL, hashes a secret and lists members with the networks routers\' shared vocabulary'],
  ['server/src/networks/member-introductions.ts', 'hashes a secret at the networks routers\' bcrypt cost (`api/networks/_shared.ts`)'],
  ['server/src/networks/network-acts.ts', 'hashes a secret at the networks routers\' bcrypt cost (`api/networks/_shared.ts`)'],
  ['server/src/networks/topology-acts.ts', 'validates a peer URL with the networks routers\' SSRF-safe schema (`api/networks/_shared.ts`)'],
  ['server/src/sync/arrival-shape.ts', 'reads a sender\'s file metadata by the wire schema the sync routers declare (`api/sync/_shared.ts`)'],
  ['server/src/sync/arrivals.ts', 'writes file metadata in the wire shape the sync routers declare (`api/sync/_shared.ts`)'],
  ['server/src/sync/file-meta-write.ts', 'removes the authored keys the sync wire schema names (`api/sync/_shared.ts`)'],
  ['server/src/sync/push-family.ts', 'sends file metadata in the wire shape the sync routers declare (`api/sync/_shared.ts`)'],
  ['server/src/sync/stray-filemeta-drain.ts', 'sends file metadata in the wire shape the sync routers declare (`api/sync/_shared.ts`)'],
  ['server/src/sync/trigger.ts', 'the sync trigger answers a request through the doors\' one failure answer (`api/send-failure.ts`)'],
]);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;

/** The specifiers of `raw` (comments blanked) that resolve into `server/src/api/`, read from the file `file` (repo-relative). */
function apiImportsOf(file, raw) {
  const out = [];
  const dir = path.posix.dirname(file);
  for (const m of blankComments(raw).matchAll(SPECIFIER)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(dir, spec));
    if (target.startsWith('server/src/api/')) out.push(spec);
  }
  return out;
}

describe('no module outside server/src/api imports from it, but the listed exceptions', () => {
  it('the reader\'s truth table: an import into the api is found, a comment or a neighbour named like it is not', () => {
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "import { a } from '../api/admin-import.js';"), ['../api/admin-import.js']);
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "const m = await import('../api/admin-import.js');"), ['../api/admin-import.js']);
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "export { a } from '../api/x.js';"), ['../api/x.js']);
    assert.deepEqual(apiImportsOf('server/src/x.ts', "import type { a } from './api/x.js';"), ['./api/x.js']);
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "// import { a } from '../api/admin-import.js';"), []);
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "import { a } from '../apiary/x.js';"), []);
    assert.deepEqual(apiImportsOf('server/src/spaces/x.ts', "import { a } from '../sync/space-import.js';"), []);
  });

  it('every tracked module outside the api imports from it only when listed, and every listed one still does', () => {
    const files = trackedSources('server/src', { floor: 500 }).filter(f => !f.startsWith('server/src/api/'));
    assert.ok(files.length >= 400, `only ${files.length} modules outside the api: the listing is broken`);
    const offenders = [];
    const importing = new Set();
    for (const file of files) {
      const found = apiImportsOf(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      if (found.length === 0) continue;
      importing.add(file);
      if (!EXCEPTIONS.has(file)) offenders.push(`${file} imports ${found.join(', ')}`);
    }
    assert.deepEqual(offenders, [], `a module outside server/src/api imports from it; move what it needs out of the api, or list it here with its reason:\n  ${offenders.join('\n  ')}`);
    const stale = [...EXCEPTIONS.keys()].filter(f => !importing.has(f));
    assert.deepEqual(stale, [], `a listed exception no longer imports from the api; take it off the list: ${stale.join(', ')}`);
  });
});
