/**
 * The namespace of a schema-library group is looked up through `namespaceOfGroup` (`server/src/spaces/library-terms.ts`), never by
 * indexing the map with the group's name (Q-748, bundle-269 lens sweep, finding 6).
 *
 * ## The defect it prevents
 *
 * A group is any name the library accepts, and the namespaces are a plain object keyed by it. `namespaces[group]` for a group called
 * `constructor` or `toString` answers a function, and for `__proto__` the prototype: `effectiveLibraryEntries` threw for every entry of
 * such a group, `GET /groups` listed an empty namespace, and `DELETE .../namespace` answered `removed: true` and removed nothing.
 * Four readers did it; `namespaceOfGroup` answers only an own key.
 *
 * ## What it holds
 *
 * - No server source (comments stripped) indexes `namespaces` or `schemaLibraryNamespaces` with brackets: every lookup by group asks
 *   `namespaceOfGroup`.
 * - The scan is proven on a planted copy: the repository's own `GET /groups` line with its lookup written as an index, which it flags,
 *   and the unplanted line, which it passes.
 *
 * Run: node --test testing/standalone/a-group-namespace-is-looked-up-by-its-own-key-only.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** A bracket index on the map of group namespaces, however it is reached (`namespaces[g]`, `x.schemaLibraryNamespaces?.[g]`, `schemaLibraryNamespaces![g]`). */
const INDEXED = /\b(?:namespaces|schemaLibraryNamespaces)\s*[?!]?\.?\s*\[/;

const sources = readTrackedSources(SERVER_CODE_ROOTS, { untracked: true }).map(({ file, text }) => ({ file, code: stripComments(text) }));
const indexers = (list) => list.filter(s => INDEXED.test(s.code)).map(s => s.file);

describe('a group namespace is looked up through namespaceOfGroup', () => {
  it('reads a tree worth reading, and the lookup has askers (the floors)', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} sources were read`);
    const askers = sources.filter(s => /\bnamespaceOfGroup\s*\(/.test(s.code)).map(s => s.file);
    for (const f of ['server/src/api/schema-library.ts', 'server/src/api/schema-library-namespaces.ts', 'server/src/spaces/library-terms.ts']) {
      assert.ok(askers.includes(f), `${f} no longer asks namespaceOfGroup`);
    }
  });

  it('no server source indexes the namespaces by a group name', () => {
    assert.deepEqual(indexers(sources), [], 'a lookup by index answers `constructor`, `toString` and `__proto__` with what every object inherits: ask namespaceOfGroup');
  });

  it('flags the repository\'s own GET /groups written as an index, and passes it as it is', () => {
    const route = sources.find(s => s.file === 'server/src/api/schema-library.ts');
    assert.ok(route, 'the library router is not among the sources');
    const asIs = indexers([route]);
    const planted = { file: route.file, code: route.code.replace('namespaceOfGroup(namespaces, name)', 'namespaces[name]') };
    assert.notEqual(planted.code, route.code, 'the planted copy changed nothing: the lookup moved and this proof must follow it');
    assert.deepEqual(asIs, [], 'the router as it is already indexes the namespaces');
    assert.deepEqual(indexers([planted]), [route.file], 'the scan does not see an index on the namespaces');
  });
});
