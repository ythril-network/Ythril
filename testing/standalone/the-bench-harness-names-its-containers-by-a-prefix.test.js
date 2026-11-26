/**
 * The RDF benchmark harness names its Ythril containers, volumes and network by a prefix taken from `--name-prefix`, else from its work
 * folder, so two runs never collide; the default work folder keeps the names `b271-*` (bundle-273, Q-764 slice S4; contract row 7).
 *
 * The defect: `benchmarks/rdf/ythril.mjs` named every container `b271-*`, so a second measurement (the Q-763 run) removed the first's
 * containers when it started (`ythrilUp` calls `ythrilDown` first).
 *
 * ## Seen red
 *
 * On 65080cae3: `namePrefixOf` is not exported by `benchmarks/rdf/env.mjs`, and `ythrilNames('b273')` still answers `b271-*` names.
 *
 * Run: node --test testing/standalone/the-bench-harness-names-its-containers-by-a-prefix.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as env from '../../benchmarks/rdf/env.mjs';
import { ythrilNames, ythrilNetwork } from '../../benchmarks/rdf/ythril.mjs';
import { oxigraphNames } from '../../benchmarks/rdf/oxigraph.mjs';

/** Every name a run of `prefix` creates: its containers, volumes and network. */
const namesOf = (prefix) => [...Object.values(ythrilNames(prefix)), ythrilNetwork(prefix)];

describe('the bench harness names its containers by a prefix', () => {
  it('the prefix comes from --name-prefix, else from the work folder, and the default work folder keeps b271', () => {
    assert.equal(typeof env.namePrefixOf, 'function', 'env.mjs answers the prefix of a run');
    assert.equal(env.namePrefixOf({}, env.DEFAULT_WORK), 'b271');
    assert.equal(env.namePrefixOf({ 'name-prefix': 'q763' }, env.DEFAULT_WORK), 'q763');
    assert.equal(env.namePrefixOf({}, 'E:/TMP/Ythril/data/b273-bench'), 'b273');
    assert.equal(env.namePrefixOf({}, 'E:/TMP/Ythril/data/Embed Meaning'), 'embed-meaning');
    assert.throws(() => env.namePrefixOf({ 'name-prefix': 'Bad_Name' }, env.DEFAULT_WORK), /prefix/);
  });

  it('every name a run creates carries its prefix, so two prefixes share none', () => {
    for (const n of namesOf('b271')) assert.match(n, /^b271-/);
    const a = namesOf('b273');
    const b = namesOf('q763');
    for (const n of a) assert.match(n, /^b273-/, `${n} carries the run's prefix`);
    assert.deepEqual(a.filter(n => b.includes(n)), [], 'two runs share no container, volume or network');
    assert.deepEqual(namesOf(undefined), namesOf('b271'), 'no prefix is the default one');
  });

  it('finding H1: the Oxigraph container and volume carry the prefix too, and the default keeps b271', () => {
    const names = (prefix) => Object.values(oxigraphNames(1000, prefix));
    for (const n of names('b273')) assert.equal(n, 'b273-oxigraph-1000', 'the name carries the run\'s prefix and its size');
    assert.deepEqual(names('b273').filter(n => names('q763').includes(n)), [], 'two prefixes share no Oxigraph container or volume');
    assert.deepEqual(oxigraphNames(1000), oxigraphNames(1000, 'b271'), 'no prefix is the default one');
    assert.equal(oxigraphNames(1000).container, 'b271-oxigraph-1000', 'the default work folder keeps its b271 names');
  });
});
