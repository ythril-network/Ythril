/**
 * Literal sources for `a-database-test-never-downloads-a-model.test.js`: one sample per way a file can change the
 * model-download variables, the reads and mentions that are not a change, and one small import graph holding each
 * shape of file the gate's derived rule tells apart.
 *
 * Literal on purpose: a fixture that derived its samples from the detector would assert the detector equals itself.
 * Every sample is a STRING, so nothing here runs and nothing here is code the gate reads as a write.
 */

/** Each must be found, naming `name`. */
export const WRITES = [
  { form: 'dot assignment', name: 'YTHRIL_MODELS_OFFLINE', source: "process.env.YTHRIL_MODELS_OFFLINE = '1';" },
  { form: 'bracket assignment', name: 'MODEL_CACHE_DIR', source: "const EMPTY = '/x';\nprocess.env['MODEL_CACHE_DIR'] = EMPTY;" },
  { form: 'logical assignment', name: 'YTHRIL_MODELS_OFFLINE', source: "process.env['YTHRIL_MODELS_OFFLINE'] ??= '1';" },
  { form: 'assignment inside a callback', name: 'TRANSFORMERS_OFFLINE', source: "before(() => { process.env.TRANSFORMERS_OFFLINE = '0'; });" },
  { form: 'delete, dot', name: 'HF_HUB_OFFLINE', source: 'delete process.env.HF_HUB_OFFLINE;' },
  { form: 'delete, bracket', name: 'TRANSFORMERS_OFFLINE', source: "delete process.env['TRANSFORMERS_OFFLINE'];" },
  { form: 'Object.assign onto process.env', name: 'YTHRIL_MODELS_OFFLINE', source: "Object.assign(process.env, { YTHRIL_MODELS_OFFLINE: '' });" },
  { form: 'Object.assign, quoted key', name: 'MODEL_CACHE_DIR', source: "Object.assign(process.env, { 'MODEL_CACHE_DIR': dir });" },
  { form: 'object spreading process.env', name: 'MODEL_CACHE_DIR', source: "spawn(process.execPath, [f], { env: { ...process.env, MODEL_CACHE_DIR: warm } });" },
  { form: 'object spreading process.env, computed key', name: 'HF_HUB_OFFLINE', source: "const env = { ...process.env, ['HF_HUB_OFFLINE']: '0' };" },
  { form: 'object spreading process.env, key before the spread', name: 'YTHRIL_MODELS_OFFLINE', source: "const env = { YTHRIL_MODELS_OFFLINE: '0', ...process.env };" },
  { form: "testChildEnv's extra", name: 'YTHRIL_MODELS_OFFLINE', source: "spawnSync(n, a, { env: testChildEnv({ YTHRIL_MODELS_OFFLINE: '0' }) });" },
  { form: 'creates the cache path', name: 'MODEL_CACHE_DIR', source: "fs.mkdirSync(process.env['MODEL_CACHE_DIR'], { recursive: true });" },
  { form: 'creates under the cache path through a binding', name: 'MODEL_CACHE_DIR', source: "const cache = process.env.MODEL_CACHE_DIR;\nawait mkdir(path.join(cache, 'nomic-ai'), { recursive: true });" },
  { form: 'writes into the cache path', name: 'MODEL_CACHE_DIR', source: "writeFileSync(join(process.env.MODEL_CACHE_DIR, 'config.json'), '{}');" },
];

/** None of these changes a variable. */
export const NOT_WRITES = [
  "const v = process.env['YTHRIL_MODELS_OFFLINE'];",
  "// process.env.YTHRIL_MODELS_OFFLINE = '1';",
  "/* delete process.env.HF_HUB_OFFLINE; */",
  "const s = \"process.env.MODEL_CACHE_DIR = x\";",
  "spawn(process.execPath, [f], { env: { ...process.env, OTHER: '1' } });",
  "assert.equal(env.MODEL_CACHE_DIR, '/models');",
  "assert.equal(existsSync(process.env.MODEL_CACHE_DIR), false);",
  "const env = { MODEL_CACHE_DIR: '/models' };",
  "process.env.CONFIG_PATH = '/c';",
];

/**
 * A graph of every shape the derived rule separates. `HARNESS` stands for `_mongo-harness.mjs`.
 *
 * - `db.test.js` imports the harness: it reaches it, so its write is forbidden.
 * - `_db-only.mjs` is imported only by that test: inside the closure, its write is forbidden.
 * - `_deep.mjs` reaches the harness through `_door.mjs`, two levels down: forbidden.
 * - `_shared-helper.mjs` is imported by the db test AND by `pure.test.js`: it also runs where the harness never
 *   loads, so it keeps its write, exempt with its reason.
 * - `_boot-child.mjs` is imported by nobody and started by URL from `pure.test.js`: exempt with its reason.
 * - `pure.test.js` reaches nothing of the harness and keeps its write: outside the closure, not a subject.
 */
export const HARNESS = 'testing/standalone/_mongo-harness.mjs';
export const GRAPH = {
  [HARNESS]: "process.env['YTHRIL_MODELS_OFFLINE'] = '1';\nexport const openTestMongo = () => {};",
  'testing/standalone/db.test.js': "import { openTestMongo } from './_mongo-harness.mjs';\nimport './_db-only.mjs';\nimport { h } from './_shared-helper.mjs';\nprocess.env['YTHRIL_MODELS_OFFLINE'] = '1';",
  'testing/standalone/_db-only.mjs': "process.env.MODEL_CACHE_DIR = '/x';",
  'testing/standalone/_door.mjs': "export * from './_mongo-harness.mjs';",
  'testing/standalone/_deep.mjs': "import { openTestMongo } from './_door.mjs';\ndelete process.env.HF_HUB_OFFLINE;",
  'testing/standalone/_shared-helper.mjs': "export function h() { process.env['YTHRIL_MODELS_OFFLINE'] = '1'; }",
  'testing/standalone/_boot-child.mjs': "process.env['YTHRIL_MODELS_OFFLINE'] = '1';",
  'testing/standalone/pure.test.js': "import { h } from './_shared-helper.mjs';\nconst CHILD = fileURLToPath(new URL('./_boot-child.mjs', import.meta.url));\nprocess.env.YTHRIL_MODELS_OFFLINE = '1';",
};
export const GRAPH_EXPECTED = {
  forbidden: ['testing/standalone/_db-only.mjs', 'testing/standalone/_deep.mjs', 'testing/standalone/db.test.js'],
  exempt: ['testing/standalone/_boot-child.mjs', 'testing/standalone/_shared-helper.mjs'],
  outside: ['testing/standalone/pure.test.js'],
};
