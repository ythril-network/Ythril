/**
 * The NOTICE walk leaves out an optional peer dependency only when the depending package's OWN lock entry marks it optional, and the schema package's
 * `typescript` peer is marked so in `package.json` and in the lock, with a NOTICE sentence on the caller's own compiler (Q-687, design v3 items 3 and 13).
 *
 * ## The defect this prevents
 *
 * `_notice-closure.mjs` walks `dependencies`, `optionalDependencies` and `peerDependencies` of every package whose lock entry is not `dev`, and three gates share
 * the walk (`a-notice-names-every-package-the-rule-engine-ships`, `the-schema-package-notice-names-its-production-closure`, `notice-coverage`'s transitive half).
 * The schema package's from-typescript entry adds `typescript` as a peer of the schema package. The package ships none of it (the caller's own copy, Apache-2.0, Microsoft,
 * neither bundled nor installed by npm), so no NOTICE heading is owed; but `typescript` is `devOptional` in the lock, not `dev`, so the walk counts the peer edge
 * and demands a heading for a package the image does not carry. Skipping every peer edge would be wrong the other way: a REQUIRED peer is installed by npm and is
 * owed its notice. The rule is the package manager's own: an edge is optional when `peerDependenciesMeta.<name>.optional` is true in the entry of the package that
 * DECLARES the peer, and never by what some other package says of the same name.
 *
 * ## What is held
 *
 * - The walk, on fixture locks: a peer the depending entry marks optional is skipped; `optional: false`, a missing meta, and a meta on a DIFFERENT package are
 *   each still counted; the closure of a package with no peers is unchanged, and the real lock's closures of `@bufbuild/cel` and of `schema` carry no `typescript`.
 * - The real lock: the `schema` workspace entry carries `peerDependenciesMeta.typescript.optional === true`, and `schema/package.json` declares the same
 *   `peerDependencies` and `peerDependenciesMeta` as that entry (a regenerated lock and a hand edit cannot disagree).
 * - Every `typescript` package of the lock (the one the workspace develops against, and the aliased `typescript-6` row's package) stays `dev` or `devOptional`: a
 *   production edge to it is what would ship it. The schema package develops against both (`typescript` and the alias `typescript-6`).
 * - `schema/NOTICE` carries a sentence saying the `from-typescript` entry uses the caller's own `typescript` (Apache-2.0, Microsoft), neither bundled nor installed by npm.
 *
 * Run: node --test testing/standalone/an-optional-peer-is-left-out-of-the-notice-walk-only-by-its-own-entry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packagesOf, workspaceClosure, productionClosure } from './_notice-closure.mjs';

const names = (closure) => closure.map(p => p.name).sort();

describe('the walk leaves out an optional peer only by the depending entry\'s own meta (fixture locks)', () => {
  /** A lock whose workspace `pkg` has an engine and a peer `tool`; `meta` is what `pkg`'s own entry says, `engineMeta` what the engine's entry says. */
  const lock = ({ meta, engineMeta, peerOfEngine = false, devOptional = true } = {}) => ({
    '': { name: 'root' },
    pkg: { name: '@x/pkg', dependencies: { engine: '1.0.0' }, peerDependencies: { tool: '>=1 <3' }, ...(meta ? { peerDependenciesMeta: meta } : {}) },
    'node_modules/engine': {
      version: '1.0.0', license: 'Apache-2.0', dependencies: { child: '^1' },
      ...(peerOfEngine ? { peerDependencies: { tool: '*' } } : {}), ...(engineMeta ? { peerDependenciesMeta: engineMeta } : {}),
    },
    'node_modules/child': { version: '1.0.0', license: 'MIT' },
    'node_modules/tool': { version: '2.0.0', license: 'Apache-2.0', ...(devOptional ? { devOptional: true } : {}) },
  });
  const closure = (l) => names(workspaceClosure(l, 'pkg'));

  it('skips a peer the depending package\'s own entry marks optional', () => {
    assert.deepEqual(closure(lock({ meta: { tool: { optional: true } } })), ['child', 'engine']);
  });

  it('counts the peer when the entry says optional: false, says nothing of it, or has no meta at all', () => {
    assert.deepEqual(closure(lock({ meta: { tool: { optional: false } } })), ['child', 'engine', 'tool']);
    assert.deepEqual(closure(lock({ meta: { other: { optional: true } } })), ['child', 'engine', 'tool']);
    assert.deepEqual(closure(lock({ meta: { tool: {} } })), ['child', 'engine', 'tool']);
    assert.deepEqual(closure(lock()), ['child', 'engine', 'tool']);
  });

  it('counts a required peer even when its target is only devOptional (npm installs a required peer)', () => {
    assert.deepEqual(closure(lock({ devOptional: true })).includes('tool'), true);
  });

  it('skips by the declaring package\'s own meta, never by another package\'s: the engine\'s peer on tool is counted unless the ENGINE marks it', () => {
    const onlyWorkspaceMarks = lock({ meta: { tool: { optional: true } }, peerOfEngine: true });
    assert.deepEqual(closure(onlyWorkspaceMarks), ['child', 'engine', 'tool'], 'the workspace\'s meta must not excuse the engine\'s own peer edge');
    const engineMarks = lock({ meta: { tool: { optional: true } }, peerOfEngine: true, engineMeta: { tool: { optional: true } } });
    assert.deepEqual(closure(engineMarks), ['child', 'engine']);
    const onlyEngineMarks = lock({ peerOfEngine: true, engineMeta: { tool: { optional: true } } });
    assert.deepEqual(closure(onlyEngineMarks), ['child', 'engine', 'tool'], 'the engine\'s meta must not excuse the workspace\'s own peer edge');
  });

  it('leaves a closure with no peer edge as it was (the existing fixture of the closure gate)', () => {
    const plain = {
      '': { name: 'root' },
      pkg: { name: '@x/pkg', dependencies: { engine: '1.0.0' }, devDependencies: { tool: '1' } },
      'node_modules/engine': { version: '1.0.0', license: 'Apache-2.0', dependencies: { child: '^1' }, optionalDependencies: { extra: '1' } },
      'node_modules/child': { version: '1.0.0', license: 'MIT' },
      'node_modules/extra': { version: '1.0.0', license: 'MIT' },
      'node_modules/tool': { version: '1.0.0', license: 'MIT', dev: true },
    };
    assert.deepEqual(names(workspaceClosure(plain, 'pkg')), ['child', 'engine', 'extra'], 'an optionalDependency (not a peer) is still counted');
  });
});

describe('the real lock', () => {
  const packages = packagesOf(readFileSync('package-lock.json', 'utf8'));
  const schemaEntry = packages.schema;
  const manifest = JSON.parse(readFileSync('schema/package.json', 'utf8'));

  it('the schema workspace entry carries peerDependenciesMeta.typescript.optional === true', () => {
    assert.ok(schemaEntry, 'the lock has no schema workspace entry');
    assert.equal(schemaEntry.peerDependenciesMeta?.typescript?.optional, true,
      'package-lock.json\'s "schema" entry does not mark its typescript peer optional: npm would install the compiler for every consumer, and the NOTICE walk would demand a heading for it');
  });

  it('schema/package.json declares the same peer and peer meta as the lock entry (a regenerated lock and a hand edit agree)', () => {
    assert.ok(manifest.peerDependencies?.typescript, 'schema/package.json declares no typescript peer dependency');
    assert.deepEqual(manifest.peerDependenciesMeta, schemaEntry.peerDependenciesMeta);
    assert.deepEqual(manifest.peerDependencies, schemaEntry.peerDependencies);
    assert.equal(manifest.peerDependenciesMeta?.typescript?.optional, true, 'schema/package.json does not mark its typescript peer optional');
  });

  it('the schema and cel closures carry no typescript, and keep what they carried', () => {
    const schema = names(workspaceClosure(packages, 'schema'));
    assert.ok(!schema.includes('typescript'), 'the NOTICE walk counts typescript as a production package of the schema workspace');
    const cel = names(productionClosure(packages, '@bufbuild/cel', 'schema'));
    assert.deepEqual(cel, ['@bufbuild/cel', '@bufbuild/cel-spec', '@bufbuild/protobuf', '@bufbuild/re2']);
    for (const n of ['@bufbuild/cel', '@bufbuild/cel-spec', '@bufbuild/protobuf', '@bufbuild/re2', 'zod']) assert.ok(schema.includes(n), `the schema closure lost ${n}`);
  });

  it('every typescript package of the lock stays dev or devOptional, and the schema package develops against both rows', () => {
    const tsEntries = Object.entries(packages).filter(([key, e]) => (e.name ?? key.slice(key.lastIndexOf('node_modules/') + 13)) === 'typescript');
    assert.ok(tsEntries.length >= 1, 'the lock has no typescript package');
    for (const [key, e] of tsEntries) assert.ok(e.dev === true || e.devOptional === true, `${key} is a production package (neither dev nor devOptional): the image would ship the compiler`);
    assert.equal(manifest.devDependencies?.typescript?.length > 0, true, 'schema/package.json lost its typescript devDependency');
    assert.match(manifest.devDependencies?.['typescript-6'] ?? '', /^npm:typescript@\^?6/, 'schema/package.json has no aliased typescript-6 devDependency (npm:typescript@^6), which the 6.x harness row needs');
    assert.ok(tsEntries.some(([key, e]) => key.endsWith('node_modules/typescript-6') && /^6\./.test(e.version)), 'the lock has no typescript-6 alias entry at 6.x');
  });
});

describe('schema/NOTICE says the from-typescript entry uses the caller\'s own typescript', () => {
  const notice = readFileSync('schema/NOTICE', 'utf8');
  /** The NOTICE's body sentences (not headings) that mention typescript, whitespace collapsed. */
  const sentences = notice.split(/\r?\n/).filter(l => !/^#/.test(l)).join(' ').replace(/\s+/g, ' ').split(/(?<=\.)\s/).filter(s => /typescript/i.test(s));

  it('has a sentence naming typescript, its licence and its owner, "the caller\'s own", and neither bundled nor installed', () => {
    const sentence = sentences.find(s => /from-typescript/.test(s));
    assert.ok(sentence, 'schema/NOTICE has no sentence naming the from-typescript entry and typescript');
    assert.match(sentence, /Apache[- ]2\.0|Apache License/, 'the sentence does not name typescript\'s licence');
    assert.match(sentence, /Microsoft/, 'the sentence does not name typescript\'s owner');
    assert.match(sentence, /caller'?s own|your own|own copy/i, 'the sentence does not say the compiler is the caller\'s own');
    assert.match(sentence, /not bundled|neither bundled|never bundled|nor bundled/i, 'the sentence does not say it is not bundled');
    assert.match(sentence, /not installed|nor installed|neither .*installed/i, 'the sentence does not say npm does not install it');
  });

  it('keeps its statement that the package bundles no third-party code', () => {
    assert.match(notice, /bundles no third-party code/);
  });
});
