/**
 * `intervalJobRuns(index)` scans the sources once per set of sources, and every index it is given still gets the synthetic bodies (Q-871, bundle-316).
 *
 * ## The defect this refuses
 *
 * The deleter gate asked for the interval-job edges inside an arrow it handed to the walk, so the scan (a regex over every server source, with a
 * parse of each match's arguments) ran 10 530 times per `unauditedPairs` call: 93 percent of the gate's time, 58 s a call, for the same answer
 * every time. The fix at the call site (build the edge helpers once) leaves the next caller free to repeat the mistake, so the module holds it: the
 * SCAN is remembered per `sources` map, which the cut copies of an index share.
 *
 * What a memo of the whole function would lose is its side effect. `intervalJobRuns` inserts one synthetic body per inline closure
 * (`file:intervalJob@<offset>`) into the `bodies` of the index it is given, and copies of an index (`unauditedPairs` cuts one, the housekeeping
 * walks make one without the walk callbacks) share `sources` but own their `bodies`. A call that returned from the memo without inserting
 * would leave a copy with no body for the key, the walk would stop there quietly, and the gate would report fewer findings and pass. So the
 * insertion happens on every call, and only the scan is remembered.
 *
 * ## What is asserted
 *
 * - a second call on the same index scans no source again, and answers the same runs (a spy counts every way the `sources` map is iterated, and the
 *   first call must be seen to scan, so a spy that sees nothing cannot pass);
 * - a copy of the index made BEFORE the first call, one whose first call comes before the original's, and one made AFTER both each get the
 *   synthetic bodies, and none of the later calls scans again;
 * - an index built from other sources is not answered from the first one's scan.
 *
 * The no-rescan cases are red on the unchanged code (every call scans); the body cases state what the change must not lose.
 *
 * Run: node --test testing/standalone/an-interval-job-scan-runs-once-per-set-of-sources.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexSources, intervalJobRuns } from './_call-graph.mjs';

/** A Map that counts every way it is walked, so a scan cannot hide behind `entries()` or `forEach`. */
class WalkCountingMap extends Map {
  walks = 0;
  [Symbol.iterator]() { this.walks++; return super[Symbol.iterator](); }
  entries() { this.walks++; return super.entries(); }
  keys() { this.walks++; return super.keys(); }
  values() { this.walks++; return super.values(); }
  forEach(...args) { this.walks++; return super.forEach(...args); }
}

const INTERVAL = 'export function intervalJob(label: string, ms: number, run: () => unknown) { return [label, ms, run]; }\n';
const sourcesOf = (extra = '') => new Map([
  ['server/src/interval.ts', INTERVAL],
  ['server/src/jobs.ts', [
    "import { intervalJob } from './interval.js';",
    'export function sweep() { return 1; }',
    'export function start() {',
    "  intervalJob('closure-job', 1000, () => sweep());",
    "  intervalJob('reference-job', 2000, sweep);",
    `  ${extra}`,
    '}',
  ].join('\n')],
]);
const build = (extra) => indexSources(sourcesOf(extra), { functionFloor: 1, label: 'the fixture' });

/** A copy the way the repository makes them: the same `sources` (here a counting map), its own `bodies`. */
const copyOf = (index) => ({ ...index, bodies: new Map(index.bodies) });
const withCountingSources = (index) => { const sources = new WalkCountingMap(index.sources); return { ...copyOf(index), sources }; };
const closureKeysOf = (index) => intervalJobRuns(index).filter(r => r.how === 'closure').map(r => r.key);

describe('intervalJobRuns scans once per set of sources', () => {
  it('a second call on the same index scans no source again and answers the same runs', () => {
    const index = withCountingSources(build());
    const first = intervalJobRuns(index);
    const scansAfterFirst = index.sources.walks;
    assert.ok(scansAfterFirst > 0, 'the first call was not seen to walk the sources: the spy proves nothing');
    const second = intervalJobRuns(index);
    assert.equal(index.sources.walks, scansAfterFirst, 'the second call scanned the sources again');
    assert.deepEqual(second, first);
    assert.deepEqual(first.map(r => r.how).sort(), ['closure', 'reference'], 'the fixture holds one closure job and one reference job');
  });

  it('a copy made before the first call, a copy whose call comes first and a copy made after both each get the synthetic bodies, and none scans again', () => {
    const original = withCountingSources(build());
    const copyBefore = copyOf(original);
    const copyFirst = copyOf(original);
    intervalJobRuns(copyFirst);
    const scans = original.sources.walks;
    assert.ok(scans > 0, 'the first call was not seen to walk the sources: the spy proves nothing');
    intervalJobRuns(original);
    intervalJobRuns(copyBefore);
    const copyAfter = copyOf(original);
    intervalJobRuns(copyAfter);
    assert.equal(original.sources.walks, scans, 'a later call on the same sources scanned them again');
    const keys = closureKeysOf(build());
    assert.equal(keys.length, 1);
    for (const [label, index] of [['the original', original], ['the copy made before the first call', copyBefore], ['the copy whose call came first', copyFirst], ['the copy made after both', copyAfter]]) {
      const body = index.bodies.get(keys[0]);
      assert.ok(body?.synthetic, `${label} has no synthetic body for ${keys[0]}: a walk reaching the job's closure would stop there and report fewer findings`);
    }
  });

  it('an index built from other sources is answered from its own scan, not the first index\'s', () => {
    const one = build();
    const other = build("intervalJob('another-job', 3000, () => sweep());");
    // The label is the argument as written, quotes included.
    const labelOf = (r) => r.label.replace(/^['"]|['"]$/g, '');
    const first = intervalJobRuns(one).map(labelOf);
    const second = intervalJobRuns(other).map(labelOf);
    assert.deepEqual(first.sort(), ['closure-job', 'reference-job']);
    assert.deepEqual(second.sort(), ['another-job', 'closure-job', 'reference-job']);
    assert.deepEqual(intervalJobRuns(one).map(labelOf).sort(), first, 'the first index changed its answer after another index was asked');
  });
});
