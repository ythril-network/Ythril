/**
 * Which standalone tests read only tracked text, found from what each file's imports reach (Q-870, bundle-316).
 *
 * ## The defect this refuses
 *
 * The preflight ran every pure standalone file after both builds, because some of them import `server/dist`. 344 of the 1 241 pure files read nothing
 * a build writes (the changelog test takes 136 ms), and a failure in one of them was found after the server build and the client build, minutes later
 * than it could have been. "Needs no build" was a hand list of eleven gates (`SOURCE_GATES`), the only statement of it, and it could not grow with
 * the tree. `testing/_shared/text-only-test.mjs` answers the question once, by computation: a file is text-only when no module of its import closure
 * imports under `server/` or `client/`, names `server/dist`, `client/dist`, `schema/dist` or `node_modules`, calls `fetch`, uses a non-literal
 * `import()` or `createRequire`, imports a package, or starts a process other than git. A module it cannot read or resolve is NOT text-only, and it
 * never throws on what a test says: fixture text that holds an import line (a template literal) is data, not an edge.
 *
 * ## What is asserted
 *
 * - **The truth table, on a scratch git repository** (`readsOnlyTrackedText`): a text file; a helper chain; a comment that names a build; a `.js` helper
 *   that is tracked (it resolves as itself); git spawned; and, each NOT text-only: a build import, each of the four build and package directories
 *   named, a package, `createRequire`, node spawned (alone, and beside git), `fetch`, a non-literal `import()`, a helper that names a build,
 *   an import that resolves to nothing (which does not throw), and a db file. Fixture text with an import line inside a template literal does not throw.
 *   The set answer `textOnlyFiles(split, { root })` is the exact set, sorted, repo-relative, and holds no `@ci-only` file.
 * - **`readsDist` has one home**: the module exports it, with the stage test's behaviour, and no other file under `testing/` or `scripts/` declares it.
 * - **The real tree**: the changelog test is text-only; every file `SOURCE_GATE_FILES` names is; `audit-route-coverage` (a built gate) is not; no
 *   text-only file names a build output or `node_modules` in its own code; there are at least 200; and the three kinds of `offlineRuns` hold every
 *   offline file exactly once, with the text runs holding exactly `textOnlyFiles` and the pure runs none of them.
 *
 * The module does not exist on the unchanged code: each case imports it through `importOrFail`, so the red line names the missing behaviour.
 *
 * Run: node --test testing/standalone/a-text-only-test-is-found-from-what-its-imports-reach.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { importOrFail } from '../_shared/import-or-fail.mjs';
import { splitStandalone, offlineRuns } from '../_shared/standalone-split.mjs';

const TEXT_ONLY = 'testing/_shared/text-only-test.mjs';
const classifier = () => importOrFail(TEXT_ONLY, 'the text-only classification of a standalone test (readsOnlyTrackedText, textOnlyFiles, readsDist)');
const T = (name) => `testing/standalone/${name}.test.js`;

/** Every fixture file of the scratch repository, path to text: one row per rule of the truth table. */
const FIXTURE = {
  // text-only
  'testing/standalone/text.test.js': "import { readFileSync } from 'node:fs';\nimport { x } from './_helper.mjs';\nvoid [readFileSync('CHANGELOG.md'), x];\n",
  'testing/standalone/_helper.mjs': "import { readFileSync } from 'node:fs';\nexport const x = readFileSync.name;\n",
  'testing/standalone/chain.test.js': "import { a } from './_a.mjs';\nvoid a;\n",
  'testing/standalone/_a.mjs': "import { b } from './_b.mjs';\nexport const a = b;\n",
  'testing/standalone/_b.mjs': "import { join } from 'node:path';\nexport const b = join('x', 'y');\n",
  'testing/standalone/comment.test.js': "// the build lives in server/dist and the page in client/dist; fetch(url) is not called here\n/* import x from '../../server/src/y.ts'; node_modules */\nimport { join } from 'node:path';\nvoid join;\n",
  'testing/standalone/tracked-js.test.js': "import { helper } from '../sync/helpers.js';\nvoid helper;\n",
  'testing/sync/helpers.js': "export const helper = 1;\n",
  'testing/standalone/git.test.js': "import { execFileSync } from 'node:child_process';\nvoid execFileSync('git', ['ls-files']);\n",
  // not text-only
  'testing/standalone/dist-import.test.js': "import { f } from '../../server/dist/x.js';\nvoid f;\n",
  'testing/standalone/src-import.test.js': "import { f } from '../../server/src/x.ts';\nvoid f;\n",
  'testing/standalone/named-server.test.js': "import { readFileSync } from 'node:fs';\nvoid readFileSync('server/dist/x.js');\n",
  'testing/standalone/named-client.test.js': "import { join } from 'node:path';\nvoid join('root', 'client', 'dist', 'index.html');\n",
  'testing/standalone/named-schema.test.js': "import { readFileSync } from 'node:fs';\nvoid readFileSync('schema/dist/index.js');\n",
  'testing/standalone/named-modules.test.js': "import { readFileSync } from 'node:fs';\nvoid readFileSync('node_modules/x/package.json');\n",
  'testing/standalone/package.test.js': "import ts from 'typescript';\nvoid ts;\n",
  'testing/standalone/require.test.js': "import { createRequire } from 'node:module';\nvoid createRequire(import.meta.url)('typescript');\n",
  'testing/standalone/spawn-node.test.js': "import { spawnSync } from 'node:child_process';\nvoid spawnSync(process.execPath, ['x.js']);\n",
  'testing/standalone/git-and-node.test.js': "import { execFileSync, spawnSync } from 'node:child_process';\nvoid execFileSync('git', ['ls-files']);\nvoid spawnSync(process.execPath, ['x.js']);\n",
  'testing/standalone/fetch.test.js': "void await fetch('http://127.0.0.1:1/');\n",
  'testing/standalone/dynamic.test.js': "const name = './x.mjs';\nvoid await import(name);\n",
  'testing/standalone/deep.test.js': "import { c } from './_c.mjs';\nvoid c;\n",
  'testing/standalone/_c.mjs': "import { readFileSync } from 'node:fs';\nexport const c = readFileSync('server/dist/y.js');\n",
  'testing/standalone/unresolved.test.js': "import './no-such-file.mjs';\n",
  'testing/standalone/db.test.js': "import { openTestMongo } from './_mongo-harness.mjs';\nvoid openTestMongo;\n",
  'testing/standalone/_mongo-harness.mjs': "import { MongoClient } from 'mongodb';\nexport const openTestMongo = () => new MongoClient('mongodb://x');\n",
  'testing/standalone/instance.test.js': "/**\n * @needs-instance drives the live test instance over http and nothing else\n */\nvoid await fetch(process.env.BASE_URL);\n",
  // a file that is text-only and says @ci-only: the set never holds it
  'testing/standalone/ci-only.test.js': "/**\n * @ci-only\n */\nimport { join } from 'node:path';\nvoid join;\n",
  // fixture text that holds import lines inside a template literal: data, not edges
  'testing/standalone/template.test.js': "const fixture = `\nimport { spaceCollection } from './x.js';\nimport y from '../../server/src/z.ts';\n`;\nvoid fixture;\n",
};

/** What is text-only among them, and what is not, with the word the reason must carry where the rule names one. */
const TEXT = ['text', 'chain', 'comment', 'tracked-js', 'git'];
const NOT_TEXT = {
  'dist-import': /server|dist/, 'src-import': /server/, 'named-server': /dist/, 'named-client': /dist/, 'named-schema': /dist/,
  'named-modules': /node_modules/, package: /typescript|package/, require: /./, 'spawn-node': /./, 'git-and-node': /./,
  fetch: /fetch/, dynamic: /./, deep: /dist/, unresolved: /no-such-file/, db: /./, instance: /./,
};

describe('the classifier, on a scratch git repository (one row per rule)', () => {
  let repo;
  before(() => {
    repo = makeScratchRepo({ prefix: 'text-only-' });
    for (const [path, text] of Object.entries(FIXTURE)) {
      mkdirSync(join(repo.dir, dirname(path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
    repo.git('add', '-A');
  });
  after(() => repo?.cleanup());

  for (const name of TEXT) {
    it(`${name}: reads only tracked text`, async () => {
      const { readsOnlyTrackedText } = await classifier();
      const answer = readsOnlyTrackedText(T(name), { root: repo.dir });
      assert.equal(answer.textOnly, true, `${T(name)} was judged not text-only: ${answer.reason}`);
    });
  }

  for (const [name, reasonWord] of Object.entries(NOT_TEXT)) {
    it(`${name}: is not text-only, and the reason says so`, async () => {
      const { readsOnlyTrackedText } = await classifier();
      const answer = readsOnlyTrackedText(T(name), { root: repo.dir });
      assert.equal(answer.textOnly, false, `${T(name)} was judged text-only`);
      assert.equal(typeof answer.reason, 'string');
      assert.match(answer.reason, reasonWord, `the reason for ${name} names nothing of its cause: ${JSON.stringify(answer.reason)}`);
    });
  }

  it('fixture text with import lines inside a template literal does not throw, and gives a yes or no', async () => {
    const { readsOnlyTrackedText } = await classifier();
    let answer;
    assert.doesNotThrow(() => { answer = readsOnlyTrackedText(T('template'), { root: repo.dir }); }, 'a test\'s data made the classifier throw');
    assert.equal(typeof answer.textOnly, 'boolean');
  });

  it('an import that resolves to nothing does not throw: the answer is no, never "text-only for a closure it could not follow"', async () => {
    const { readsOnlyTrackedText } = await classifier();
    assert.doesNotThrow(() => readsOnlyTrackedText(T('unresolved'), { root: repo.dir }));
    assert.equal(readsOnlyTrackedText(T('unresolved'), { root: repo.dir }).textOnly, false);
  });

  it('the set answer is exactly the text-only files of the split, sorted, repo-relative, and holds no @ci-only file', async () => {
    const { textOnlyFiles } = await classifier();
    const everyFile = [...TEXT, ...Object.keys(NOT_TEXT), 'ci-only'].map(n => `${n}.test.js`);
    // The split's own shape (`splitStandalone`): the pure files and the @ci-only ones, as bare names. The db and instance files are not pure.
    const split = { offlinePure: everyFile.filter(f => !['db.test.js', 'instance.test.js'].includes(f)), ciOnly: ['ci-only.test.js'] };
    const found = textOnlyFiles(split, { root: repo.dir });
    assert.deepEqual(found, TEXT.map(T).sort(), 'the text-only set is not exactly the rows the table says are text-only');
    assert.deepEqual([...found], [...found].sort(), 'the set is not sorted');
  });

  it('a stale or wrong root is not the checkout: the same file asked in a repository that does not hold it is not text-only', async () => {
    const { readsOnlyTrackedText } = await classifier();
    const other = makeScratchRepo({ prefix: 'text-only-empty-' });
    try {
      let answer;
      assert.doesNotThrow(() => { answer = readsOnlyTrackedText(T('text'), { root: other.dir }); });
      assert.equal(answer.textOnly, false);
    } finally { other.cleanup(); }
  });
});

describe('readsDist has one home and keeps the behaviour the stage test gave it', () => {
  it('names a build output path or its joined segments, in code only, for the one directory asked about', async () => {
    const { readsDist } = await classifier();
    assert.equal(readsDist("readFileSync('server/dist/x.js')", 'server'), true);
    assert.equal(readsDist("join(root, 'client', 'dist')", 'client'), true);
    assert.equal(readsDist("readFileSync('server/dist/x.js')", 'client'), false, 'the other directory was read as this one');
    assert.equal(readsDist('// server/dist is built first\nconst a = 1;', 'server'), false, 'a comment that names the build counts as a reader');
    assert.equal(readsDist('/* client/dist */ const a = 1;', 'client'), false);
    assert.equal(readsDist("readFileSync('myserver/dist/x.js')", 'server'), false, 'a path that only ends in the name matched');
  });

  it('is declared in no other file under testing/ or scripts/', async () => {
    await classifier();
    const files = [...trackedSources(['testing', 'scripts'], { ext: ['.js', '.mjs'], floor: 100 })];
    const declaring = files.filter(f => /\bfunction\s+readsDist\s*\(|\bconst\s+readsDist\s*=/.test(stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(declaring, [TEXT_ONLY], 'the dist rule has more than one spelling, or none');
  });
});

describe('the real tree', () => {
  const split = () => splitStandalone({ root: REPO_ROOT });
  const textFiles = async () => (await classifier()).textOnlyFiles(split(), { root: REPO_ROOT });

  it('the changelog test is text-only (it is the first thing a change to scripts/ must satisfy, and reads no build)', async () => {
    assert.ok((await textFiles()).includes(T('the-changelog-is-written-for-its-reader')));
  });

  it('every source gate file is text-only, and the built gate is not', async () => {
    const found = new Set(await textFiles());
    const { SOURCE_GATES, BUILT_GATES, SOURCE_GATE_FILES } = await importOrFail('scripts/_shared/preflight-stages.mjs', 'SOURCE_GATE_FILES, the gate files as repo-relative paths');
    assert.ok(SOURCE_GATE_FILES instanceof Set && Object.isFrozen(SOURCE_GATE_FILES), 'SOURCE_GATE_FILES is not a frozen Set');
    assert.deepEqual([...SOURCE_GATE_FILES].sort(), SOURCE_GATES.map(([n]) => T(n)).sort(), 'SOURCE_GATE_FILES is not the gate table as test paths');
    for (const file of SOURCE_GATE_FILES) assert.ok(found.has(file), `${file} runs in a source stage and is not classified text-only`);
    for (const [name] of BUILT_GATES) assert.ok(!found.has(T(name)), `${name} imports server/dist and is classified text-only`);
  });

  it('no text-only file names a build output or node_modules in its own code', async () => {
    const { readsDist } = await classifier();
    const found = await textFiles();
    const offenders = found.filter((f) => {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      return ['server', 'client', 'schema'].some(which => readsDist(text, which)) || /node_modules/.test(stripComments(text));
    });
    assert.deepEqual(offenders, [], 'these text-only files read what an install or a build writes, so they fail in the source stage on a clean checkout');
  });

  it('there are at least 200 (a scan that stopped matching would send every file back to the pure units without a word)', async () => {
    const found = await textFiles();
    assert.ok(found.length >= 200, `only ${found.length} text-only file(s)`);
  });

  it('the text, pure and db runs hold every offline file exactly once; text holds exactly the text-only set; pure holds none of it and no @ci-only text file', async () => {
    const text = new Set(await textFiles());
    const s = split();
    const path = (f) => `testing/standalone/${f}`;
    for (const ciOnly of [true, false]) {
      const runs = offlineRuns(s, { ciOnly });
      const of = (kind) => runs.filter(r => r.kind === kind).flatMap(r => r.files);
      assert.deepEqual([...new Set(runs.map(r => r.kind))].sort(), ['db', 'pure', 'text'], `the runs' kinds are ${runs.map(r => r.kind).join(',')}`);
      assert.deepEqual(of('text').sort(), [...text].sort(), 'the text runs are not exactly the text-only set');
      assert.deepEqual(of('pure').filter(f => text.has(f)), [], 'a text-only file is also in a pure run, so it runs twice');
      const all = runs.flatMap(r => r.files);
      assert.equal(new Set(all).size, all.length, 'a file is in two runs');
      const expected = s.offline.filter(f => ciOnly || !s.ciOnly.includes(f)).map(path);
      assert.deepEqual([...all].sort(), expected.sort(), `the runs do not hold every offline file once (ciOnly ${ciOnly})`);
      assert.deepEqual(of('db').sort(), s.offlineDb.map(path).sort());
    }
    for (const f of s.ciOnly) assert.ok(!text.has(path(f)), `${f} is @ci-only and in the text-only set`);
  });
});
