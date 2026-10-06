/**
 * Every timer job the process starts is stopped when it shuts down, before the drain (`Q-386`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * `index.ts`'s shutdown handler stopped the sync scheduler, the backup scheduler, the duplicate scanner, the two workers and the webhook
 * retry poll — by hand, one call each, from a list written when each of those existed. The TTL sweep, the candidate prune, the tombstone
 * prune, the contradiction scanner and the audit change-retention sweep were added later and never joined it: each exports a `stop…`
 * that nothing called. The stale-chunk cleanup is a bare `setInterval` whose handle nothing kept. So for the whole drain (the part of a
 * shutdown where requests are still finishing) a tick could start a pass over spaces whose connection the shutdown was about to close
 * under it. Nothing contradicted it: the process exits 0 either way.
 *
 * ## What it holds, each part derived from the tree
 *
 * 1. **Every `stop…` function a module under `server/src` exports** is called in the shutdown handler (the arrow bound to
 *    `const shutdown = async`, found by that text, exactly one). The set is read out of the sources, so a sixth module that adds a job and
 *    a `stop` is covered without an edit here.
 * 2. Each of those calls is **before the drain** (`server.close(`) — a tick that starts while the HTTP drain runs is the defect —
 *    except the one named in {@link AFTER_THE_DRAIN}, which says why, and which is held true (the call must be after it).
 * 3. **Every `const x = setInterval(` in the handler's own file** is cleared by `clearInterval(x)` in the handler before the drain.
 *    A bare `setInterval(` whose result is not bound has nothing to clear, so it is a finding of its own.
 *
 * ## It cannot pass by reading nothing
 *
 * Floors on the exports found, the calls found and the intervals found; exactly one file defines the handler.
 *
 * ## Seen red
 *
 * On the 5.6.5 tag, where five `stop` exports had no caller and the chunk-cleanup interval was unbound; then, by hand and put back by
 * hand, a call removed from the handler, one moved after the drain, and the `clearInterval` removed.
 *
 * Run: node --test testing/standalone/the-shutdown-handler-stops-every-timer-job.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { balancedFrom } from './_structural-window.mjs';

/** Stops that run AFTER the drain on purpose, with why. */
const AFTER_THE_DRAIN = {
  stopSpaceActivityFlush: 'it stops its timer and then WRITES the last partial minute of usage counters, so calls that finished while '
    + 'connections were closing are counted too; it runs before `closeMongo`, since the write needs the connection',
};

/**
 * `stop…` exports that are NOT a timer's stop, and so are never called by the shutdown handler — with why. They end ONE sync transfer
 * (they mark its outcome truncated and say where it is held, `sync/watermark.ts`, bundle-52), which is a step inside a cycle and not
 * a job that outlives it. Held true like the other table: each named export must still exist (`a row outliving the code` is a finding).
 */
const NOT_A_TIMER_STOP = {
  stopTransfer: 'it marks one transfer truncated and reports where it is held (`sync/watermark.ts`); it holds no timer',
  stopAtPageBound: 'it ends one transfer at its page bound through `stopTransfer` (`sync/watermark.ts`); it holds no timer',
};

const FLOORS = { stops: 10, calls: 10, intervals: 1 };

const sources = readTrackedSources('server/src', { floor: 100 });

/** The handler: its body text, the file that defines it, and where its drain begins. */
function shutdownHandler() {
  const hosts = sources.filter(s => /\bconst\s+shutdown\s*=\s*async\b/.test(s.text));
  assert.equal(hosts.length, 1, `exactly one file defines the shutdown handler (\`const shutdown = async\`), found ${hosts.map(h => h.file).join(', ') || 'none'}`);
  const { file, text } = hosts[0];
  const at = text.search(/\bconst\s+shutdown\s*=\s*async\b/);
  const arrow = text.indexOf('=>', at);
  const body = balancedFrom(text, text.indexOf('{', arrow), 'the shutdown handler body');
  const drainAt = body.indexOf('server.close(');
  assert.ok(drainAt > -1, 'the handler no longer calls `server.close(`: re-anchor where the drain begins');
  return { file, text, body, drainAt };
}

/** The `stop…` functions every module exports, with the file that holds each. */
function exportedStops() {
  const found = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\bexport\s+(?:async\s+)?function\s+(stop[A-Za-z0-9_$]*)\s*\(/g)) found.push({ file, name: m[1] });
  }
  return found;
}

describe('the shutdown handler stops every timer job', () => {
  const { file: hostFile, text: hostText, body, drainAt } = shutdownHandler();

  it('calls every exported stop…, before the drain unless it says why not', () => {
    const stops = exportedStops();
    assert.ok(stops.length >= FLOORS.stops, `only ${stops.length} exported stop… function(s) found — the derivation is broken`);
    const findings = [];
    let calls = 0;
    for (const { file, name } of stops) {
      if (name in NOT_A_TIMER_STOP) continue;
      const at = body.search(new RegExp(String.raw`\b${name}\s*\(`));
      if (at < 0) { findings.push(`${file}: \`${name}\` is exported and the shutdown handler never calls it`); continue; }
      calls++;
      if (name in AFTER_THE_DRAIN) {
        if (at < drainAt) findings.push(`${file}: \`${name}\` is called before the drain, but it is listed as running after it (${AFTER_THE_DRAIN[name]})`);
      } else if (at > drainAt) {
        findings.push(`${file}: \`${name}\` is called after the drain begins`);
      }
    }
    const exported = new Set(stops.map(s => s.name));
    for (const name of Object.keys(AFTER_THE_DRAIN)) {
      if (!exported.has(name)) findings.push(`AFTER_THE_DRAIN lists \`${name}\`, which no module exports: a row outliving the code`);
    }
    for (const name of Object.keys(NOT_A_TIMER_STOP)) {
      if (!exported.has(name)) findings.push(`NOT_A_TIMER_STOP lists \`${name}\`, which no module exports: a row outliving the code`);
    }
    // The findings first: a handler missing calls is the defect, and the floor below would otherwise report it as a broken derivation.
    assert.deepEqual(findings, [], findings.join('\n'));
    assert.ok(calls >= FLOORS.calls, `only ${calls} stop call(s) found in the handler — the derivation is broken`);
  });

  it('clears every interval the handler\'s own file starts, before the drain', () => {
    const handles = [...hostText.matchAll(/\bconst\s+([A-Za-z0-9_$]+)\s*=\s*setInterval\s*\(/g)].map(m => m[1]);
    assert.ok(handles.length >= FLOORS.intervals, `no \`const x = setInterval(\` found in ${hostFile} — the derivation is broken`);
    const findings = [];
    for (const handle of handles) {
      const at = body.search(new RegExp(String.raw`\bclearInterval\s*\(\s*${handle.replace(/\$/g, '\\$')}\s*\)`));
      if (at < 0) findings.push(`${hostFile}: the interval \`${handle}\` is never cleared by the shutdown handler`);
      else if (at > drainAt) findings.push(`${hostFile}: \`clearInterval(${handle})\` is after the drain begins`);
    }
    assert.deepEqual(findings, [], findings.join('\n'));
  });

  it('leaves no setInterval in the handler\'s own file unbound, so there is always a handle to clear', () => {
    const all = [...hostText.matchAll(/\bsetInterval\s*\(/g)].length;
    const bound = [...hostText.matchAll(/\bconst\s+[A-Za-z0-9_$]+\s*=\s*setInterval\s*\(/g)].length;
    assert.equal(all, bound, `${hostFile} starts ${all - bound} setInterval(s) it keeps no handle to`);
  });
});
