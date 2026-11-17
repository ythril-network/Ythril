/**
 * `package-lock.json` holds no `<workspace>/node_modules/` entry for a workspace whose `node_modules` the image does not copy (Q-685, T-3).
 *
 * ## What it prevents
 *
 * The production image carries the root `node_modules` and `server/node_modules` (`COPY --from=prod-deps`), and the package manifest and build
 * of each other workspace it ships (the schema package: `schema/package.json` and `schema/dist`), never its `node_modules`. When two workspaces
 * disagree about a dependency, npm nests a second copy under the workspace (`schema/node_modules/zod`), and that copy exists in every checkout and
 * in CI and is absent from the image: the package fails at runtime in the image only (the I2 case of Q-668). Nothing failed when the lock gained
 * such an entry; `the-schema-package-builds-and-resolves-as-the-server-does` holds that the SPECS agree, not what the lock resolved.
 *
 * ## The rule, derived
 *
 * The shipped workspaces are those whose `<workspace>/package.json` the Dockerfile's `production` stage copies; the copied `node_modules` are the
 * `COPY --from=prod-deps /app/<workspace>/node_modules` lines. No lock key under `<shipped workspace>/node_modules/` may exist for a workspace
 * whose `node_modules` is not copied. The client is built in its own stage and ships only its output, so its nested installs are not the image's.
 *
 * Run: node --test testing/standalone/the-lockfile-holds-no-nested-install-the-image-does-not-copy.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

/** Workspaces whose nested installs the image would need and does not copy. */
function uncopiedNestedInstalls(dockerfile, lockKeys) {
  const production = dockerfile.slice(dockerfile.search(/^FROM .* AS production\b/m));
  assert.ok(production.length > 100, 'the Dockerfile has a production stage');
  const shipped = [...production.matchAll(/^COPY\s+(?:--\S+\s+)*([\w-]+)\/package\.json\b/gm)].map(m => m[1]);
  const copied = new Set([...production.matchAll(/^COPY\s+--from=prod-deps\s+\/app\/([\w-]+)\/node_modules\b/gm)].map(m => m[1]));
  return lockKeys
    .filter(key => shipped.some(ws => key.startsWith(`${ws}/node_modules/`) && !copied.has(ws)));
}

describe('the lock and the image agree about nested installs', () => {
  const dockerfile = read('Dockerfile');
  const keys = () => Object.keys(JSON.parse(read('package-lock.json')).packages);

  it('the image ships the schema package and the server, and copies only the server nested installs (the rule has something to say)', () => {
    const production = dockerfile.slice(dockerfile.search(/^FROM .* AS production\b/m));
    assert.match(production, /^COPY\s+schema\/package\.json/m);
    assert.match(production, /^COPY\s+--from=prod-deps\s+\/app\/server\/node_modules/m);
    assert.doesNotMatch(production, /\/app\/schema\/node_modules/);
    assert.ok(keys().length > 500, 'the lock has its packages');
  });

  it('no key of the lock is a nested install of a workspace the image does not copy', () => {
    assert.deepEqual(uncopiedNestedInstalls(dockerfile, keys()), [],
      'npm nested a second copy under a workspace the image ships without its node_modules: make the specs agree (the-schema-package-builds-and-resolves-as-the-server-does), then npm install');
  });

  it('fails on a planted copy: the real lock with a schema/node_modules entry added, and the real Dockerfile with its server copy dropped', () => {
    const real = keys();
    assert.deepEqual(uncopiedNestedInstalls(dockerfile, real), []);
    const server = real.find(k => k.startsWith('server/node_modules/'));
    assert.ok(server, 'the real lock nests an install under the server');
    assert.deepEqual(uncopiedNestedInstalls(dockerfile, [...real, server.replace(/^server\//, 'schema/')]), [server.replace(/^server\//, 'schema/')]);
    const withoutServerCopy = dockerfile.replace(/^COPY\s+--from=prod-deps\s+\/app\/server\/node_modules.*$/m, '');
    assert.ok(uncopiedNestedInstalls(withoutServerCopy, real).some(k => k.startsWith('server/node_modules/')));
  });
});
