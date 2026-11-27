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
import * as timing from '../../benchmarks/rdf/server-timing.mjs';
import * as specTiming from './_server-timing.mjs';

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

// bundle-378, Q-976 (lens finding L1.1): one parser of the header and the `_meta` key, shared by the harness and the specs; `timing` and
// `specTiming` are namespace imports so each case fails alone when a name is missing.

test('the one parser is count-aware: each entry answers its duration and its count, and no header answers null', () => {
  const m = timing.serverTimingOf(HEADER);
  assert.deepEqual(m.get('plan'), { dur: 2.5, count: 2 });
  assert.deepEqual(m.get('run'), { dur: 7.25, count: 1 });
  assert.equal(m.get('desc'), undefined, 'a description is not a phase');
  assert.equal(timing.serverTimingOf(undefined), null);
  assert.deepEqual(timing.serverTimingOf(['total;dur=1', 'run;dur=2']).get('run'), { dur: 2, count: 1 }, 'a header sent twice is read as one list');
});

test('the MCP result is read by the same module, count included', () => {
  const m = timing.mcpTimingOf({ _meta: { 'ythril/server-timing': { total: { dur: 9, count: 1 }, plan: { dur: 1, count: 3 } } } });
  assert.deepEqual(m.get('plan'), { dur: 1, count: 3 });
  assert.equal(timing.mcpTimingOf({}), null);
  assert.equal(timing.MCP_TIMING_META, 'ythril/server-timing');
});

test('the spec helper re-exports the harness module\'s parser, and hand-rolls none', () => {
  assert.equal(specTiming.serverTimingOf, timing.serverTimingOf);
  assert.equal(specTiming.mcpTimingOf, timing.mcpTimingOf);
  assert.equal(specTiming.mcpCallResult, timing.mcpCallResult);
  const text = readFileSync(new URL('./_server-timing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /function (serverTimingOf|mcpTimingOf|mcpCallResult)/, '_server-timing.mjs parses the header itself');
  assert.doesNotMatch(text, /the one parser the phase specs and the door-floor script share/, 'the docblock claims a sharing the code did not do');
});

test('the door-floor script reads an MCP answer through mcpCallResult and hand-rolls no event-stream loop', () => {
  const floor = readFileSync(new URL('../../benchmarks/rdf/door-floor.mjs', import.meta.url), 'utf8');
  assert.match(floor, /mcpCallResult/);
  assert.doesNotMatch(floor, /startsWith\('data:'\)/, 'door-floor.mjs reads the MCP event stream itself');
});
