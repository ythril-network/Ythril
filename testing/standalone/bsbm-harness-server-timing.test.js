/**
 * The server's own time of a BSBM query, read from the `Server-Timing` header (REST) or the result's `_meta` (MCP): the door's total and the
 * engine's own work (Q-976), so a run against Oxigraph compares the engine like for like.
 *
 * Run: node --test testing/standalone/bsbm-harness-server-timing.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phasesOf, mcpPhasesOf, timingOfAnswer, summarizeTimed, ENGINE_PHASES } from '../../benchmarks/rdf/server-timing.mjs';

const HEADER = 'total;dur=12.5, auth;dur=0.4, door;dur=12.1, parse;dur=0.5, members;dur=0.3, plan;dur=2.5;desc="n=2", run;dur=7.25, render;dur=1';

test('a header gives each phase its duration, the sum of a phase that ran twice included in the one entry', () => {
  const p = phasesOf(HEADER);
  assert.equal(p.total, 12.5);
  assert.equal(p.plan, 2.5);
  assert.equal(p.run, 7.25);
  assert.deepEqual(phasesOf(undefined), {});
});

test('an MCP result carries the same figures in its _meta', () => {
  const p = mcpPhasesOf({ _meta: { 'ythril/server-timing': { total: { dur: 9, count: 1 }, plan: { dur: 1, count: 1 }, run: { dur: 4, count: 1 } } } });
  assert.deepEqual(p, { total: 9, plan: 1, run: 4 });
  assert.deepEqual(mcpPhasesOf({}), {});
});

test('the door total is the total phase and the engine time is the engine phases summed', () => {
  assert.deepEqual(ENGINE_PHASES, ['plan', 'run']);
  assert.deepEqual(timingOfAnswer(phasesOf(HEADER)), { doorMs: 12.5, engineMs: 9.75 });
});

test('an answer without the header, or without the total or an engine phase, is refused naming what is missing, never read as zero', () => {
  assert.throws(() => timingOfAnswer(phasesOf(null)), /Server-Timing/);
  assert.throws(() => timingOfAnswer(phasesOf('auth;dur=0.4')), /total/);
  assert.throws(() => timingOfAnswer(phasesOf('total;dur=5, plan;dur=1')), /run/);
  assert.throws(() => timingOfAnswer(phasesOf('total;dur=5, run;dur=1')), /plan/);
  assert.throws(() => timingOfAnswer({ total: NaN, plan: 1, run: 1 }), /total/);
});

test('a query keeps every measured run\'s wall, door and engine time, and the median and p95 of each', () => {
  const runs = [1, 2, 3, 4, 5].map(k => ({ wall: 10 * k, doorMs: 8 * k, engineMs: 5 * k }));
  const s = summarizeTimed(runs);
  assert.equal(s.median, 30);
  assert.equal(s.p95, 50);
  assert.deepEqual(s.door, { median: 24, p95: 40 });
  assert.deepEqual(s.engine, { median: 15, p95: 25 });
  assert.deepEqual(s.perRun, runs.map(r => ({ wallMs: r.wall, doorMs: r.doorMs, engineMs: r.engineMs })));
  assert.equal(s.n, 5);
  assert.throws(() => summarizeTimed([]), /empty/);
  assert.throws(() => summarizeTimed([{ wall: 1, doorMs: 1 }]), /engine/);
});

test('the Ythril run and the door-floor script read the header through this one module', () => {
  const dir = new URL('../../benchmarks/rdf/', import.meta.url);
  const floor = readFileSync(new URL('door-floor.mjs', dir), 'utf8');
  const run = readFileSync(new URL('run.mjs', dir), 'utf8');
  assert.doesNotMatch(floor, /function phasesOf/, 'door-floor.mjs parses the header itself');
  assert.match(floor, /from '\.\/server-timing\.mjs'/);
  assert.match(run, /from '\.\/server-timing\.mjs'/);
});
