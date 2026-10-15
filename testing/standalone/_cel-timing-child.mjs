/**
 * The child process `a-cel-rule-runs-in-linear-time.test.js` runs a rule in.
 *
 * ## Why a child
 *
 * A regex engine that backtracks does not answer slowly, it does not answer: the evaluation is synchronous, so a test that ran
 * it in-process would hang its own runner (and `node:test`'s timeout cannot interrupt a synchronous loop). The parent starts
 * this with a kill deadline instead, so "the linear engine is not in use" is a FAILED test and not a stuck one.
 *
 * ## What it does
 *
 * Reads one JSON spec from argv, evaluates the rule through the real validator exactly as a write door does (`recordViewOf`, then
 * `validateEntity`), and prints one JSON line. Specs:
 *
 *   { "mode": "once", "pattern": "(a+)+$", "length": 5000 }
 *       one evaluation of `self.properties.s.matches(pattern)` on `length` repeated "a" and a final "!"; prints { ms }
 *   { "mode": "ratio", "pattern": "(a|aa)+$", "n": 2000 }
 *       the time for strings of N and 2N after a warm-up, as the median of several samples each; prints { msN, ms2N, ratio }
 *   { "mode": "tags", "tags": 100, "length": 10000 }
 *       one comprehension rule over a list of `tags` strings of `length` characters each, one regex per string; prints { ms }
 */
/** Not imported from the fixtures module: that loads the schema bodies, and this process must control what loads first. */
const REPO_DIST = '../../server/dist/';

const spec = JSON.parse(process.argv[2]);
const { validateEntity } = await import(`${REPO_DIST}spaces/schema-validation.js`);
const { recordViewOf } = await import(`${REPO_DIST}brain/record-view.js`);

const meta = (expression) => ({
  validationMode: 'strict',
  typeSchemas: { entity: { thing: { propertySchemas: { s: { type: 'string' } }, rules: { r: { rule: expression, message: 'must hold' } } } } },
});
const entity = (properties, tags = []) => ({ name: 'Acme', type: 'thing', description: '', tags, properties });
const run = (m, record) => validateEntity(m, recordViewOf('entity', record));
const timed = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

if (spec.mode === 'once') {
  const m = meta(`self.properties.s.matches('${spec.pattern}')`);
  const record = entity({ s: `${'a'.repeat(spec.length)}!` });
  console.log(JSON.stringify({ ms: timed(() => run(m, record)) }));
} else if (spec.mode === 'ratio') {
  const m = meta(`self.properties.s.matches('${spec.pattern}')`);
  const at = (n) => entity({ s: `${'a'.repeat(n)}!` });
  for (let i = 0; i < 8; i++) { run(m, at(spec.n)); run(m, at(spec.n * 2)); }
  const sample = (n) => median(Array.from({ length: 9 }, () => timed(() => { for (let i = 0; i < 10; i++) run(m, at(n)); })));
  const msN = sample(spec.n);
  const ms2N = sample(spec.n * 2);
  console.log(JSON.stringify({ msN, ms2N, ratio: ms2N / msN }));
} else if (spec.mode === 'tags') {
  const m = meta(`self.tags.all(t, t.matches('^[a-z]+$'))`);
  const tags = Array.from({ length: spec.tags }, () => 'a'.repeat(spec.length));
  console.log(JSON.stringify({ ms: timed(() => run(m, entity({ s: 'x' }, tags))) }));
} else {
  throw new Error(`unknown spec ${process.argv[2]}`);
}
