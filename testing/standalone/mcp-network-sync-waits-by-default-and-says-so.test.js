/**
 * The MCP door's `network_sync` WAITS BY DEFAULT and REST's does not: the third sanctioned divergence, held to the same three
 * conditions as the first two (Q-468).
 *
 * ## Why a divergence needs its own gate
 *
 * The y-flows convention `convention-ythril-sanctioned-door-divergences` sanctions a difference between the doors only as a DEFAULT and only on three conditions, written for `maxChars`
 * and held by `mcp-recall-budget-is-lower-than-rest`: the difference is deliberate and real, every MCP call site resolves it
 * through the one constant rather than one remembering to, and both doors disclose the number they used. Owner decision
 * 2026-10-28: an agent calling `network_sync` wants the outcome, so MCP's `wait` defaults to true; a REST caller, a script or the
 * UI's button, wants the answer at once, so REST's stays false. Same parameter on both, same refusals, one differing default.
 *
 * ## The three conditions, and where each is held
 *
 *  1. DELIBERATE AND REAL — `MCP_SYNC_WAIT_DEFAULT` is true and `SYNC_WAIT_DEFAULT` is false, both in `sync/trigger.ts`, and an
 *     explicit value resolves identically on both doors: only what a caller leaves unsaid differs.
 *  2. EVERY CALL SITE RESOLVES THROUGH IT — no module outside `trigger.ts` names the MCP constant, and every site that starts a
 *     sync through the shared acts derives its `wait` from `resolveSyncWait(…, <the door>)`. The tool says which door took the
 *     call (`ctx.transport`), so `POST /api/network_sync` (the generic door, the same module) answers as REST does.
 *  3. BOTH DOORS SAY IT — the answer carries `wait` (and `timeoutMs` where a bound applied), which the `-db` case beside this
 *     one measures on each door, and the tool's own description states both defaults where a caller reads while building
 *     arguments.
 *
 * It does NOT hold a second implementation of the wait: neither door runs a cycle itself, so the race against `timeoutMs` and
 * the answer's shape are one function's (`networkSyncOutcome`, `peerSyncOutcome`).
 *
 * Run: node --test testing/standalone/mcp-network-sync-waits-by-default-and-says-so.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { statementFrom } from './_structural-window.mjs';

/** The module that OWNS the two constants and the one resolver. Everything else is a caller. */
const OWNER = 'server/src/sync/trigger.ts';

/** What starts a sync through the shared acts: a call to any of these is a door, and a door resolves `wait` the same way. */
const STARTERS = /\b(?:networkSyncOutcome|peerSyncOutcome|triggerNetworkSync|triggerPeerSync)\(/g;

const src = p => stripComments(readFileSync(p, 'utf8'));

let trigger, tool;
before(async () => {
  trigger = await import('../../server/dist/sync/trigger.js');
  ({ network_syncTool: tool } = await import('../../server/dist/mcp/tools/sync.js'));
});

describe('the sync wait default differs between the doors on purpose, and says so', () => {
  it('MCP waits and REST does not: both are named constants beside one resolver', () => {
    assert.equal(typeof trigger.SYNC_WAIT_DEFAULT, 'boolean');
    assert.equal(typeof trigger.MCP_SYNC_WAIT_DEFAULT, 'boolean');
    assert.equal(trigger.MCP_SYNC_WAIT_DEFAULT, true, 'the owner\'s decision: an agent wants the outcome, not an acknowledgement');
    assert.equal(trigger.SYNC_WAIT_DEFAULT, false, 'REST keeps answering at once');
    assert.equal(trigger.resolveSyncWait(undefined, 'mcp'), trigger.MCP_SYNC_WAIT_DEFAULT);
    assert.equal(trigger.resolveSyncWait(undefined, 'rest'), trigger.SYNC_WAIT_DEFAULT);
  });

  it('a caller who SAYS gets the same answer on either door: only the default differs', () => {
    // `true`/`false` as an MCP argument, `'true'`/`'1'`/`'false'` as a query string: the same reading on both, or the
    // divergence has leaked from the default into the parameter.
    for (const said of [true, false, 'true', '1', 'false', '0', 'yes']) {
      assert.equal(trigger.resolveSyncWait(said, 'mcp'), trigger.resolveSyncWait(said, 'rest'), `wait: ${JSON.stringify(said)} reads differently on the two doors`);
    }
  });

  it('every bound is the same function on both doors: clamped, never refused', () => {
    assert.equal(trigger.syncTimeoutMs(undefined), 30_000);
    assert.equal(trigger.syncTimeoutMs(5), 1_000);
    assert.equal(trigger.syncTimeoutMs(999_999_999), 120_000);
  });
});

describe('every call site resolves its default from the DOOR, and nothing outside the owner names the MCP one', () => {
  const files = trackedSources(['server/src'], { exclude: [OWNER] });

  it('found the sources to sweep', () => {
    assert.ok(files.length >= 100, `only ${files.length} server sources found — the sweep is broken, not clean`);
  });

  it('no module outside trigger.ts names the MCP default', () => {
    const offenders = files.filter(f => /MCP_SYNC_WAIT_DEFAULT/.test(src(f)));
    assert.deepEqual(offenders, [], `these choose the MCP wait default themselves instead of asking which door called: ${offenders.join(', ')}`);
  });

  it('every site that starts a sync takes its `wait` from resolveSyncWait, and runs no cycle of its own', () => {
    const doors = files.filter(f => { STARTERS.lastIndex = 0; return STARTERS.test(src(f)); });
    // The REST routes and the MCP tool: at least the two files that exist today. A sweep that finds none passes everything.
    assert.ok(doors.length >= 2, `only ${doors.length} door(s) start a sync through the shared acts — the sweep is broken`);
    const wrong = [];
    for (const f of doors) {
      const text = src(f);
      const resolvedOnce = /const wait = resolveSyncWait\(/.test(text);
      for (const m of text.matchAll(STARTERS)) {
        const stmt = statementFrom(text, m.index, `a sync start in ${f}`);
        const takesResolved = /\bwait: resolveSyncWait\(/.test(stmt) || (resolvedOnce && /\bwait\b/.test(stmt));
        if (!takesResolved) wrong.push(`${f}: ${stmt.slice(0, 100).replace(/\s+/g, ' ')}`);
      }
      // No second implementation of the wait: a door that calls the engine itself has its own race and its own answer.
      if (/\brunSyncFor(?:Network|Peer)\(|\bwithinTimeBound\(/.test(text)) wrong.push(`${f}: runs a cycle or a time bound of its own`);
      // And no hand-parse of the flag beside the resolver.
      if (/(?<!resolveSyncWait\()(?:req\.query|\ba|\bargs)\[['"]wait['"]\]/.test(text)) wrong.push(`${f}: reads \`wait\` itself instead of through resolveSyncWait`);
    }
    assert.deepEqual(wrong, [], `these doors do not resolve the wait through the one constant:\n  ${wrong.join('\n  ')}`);
  });

  it('the MCP tool resolves it from the door that took the call, so the generic REST door answers as REST', () => {
    const text = src('server/src/mcp/tools/sync.ts');
    assert.match(text, /resolveSyncWait\([^)]*ctx\.transport\s*\)/, 'network_sync must pass ctx.transport');
  });
});

describe('both doors say what they used', () => {
  it('the tool\'s description states the two defaults where a caller reads while building arguments', () => {
    const props = tool.inputSchema({}).properties;
    assert.ok(props.wait, '`wait` is not declared');
    const said = `${tool.description}\n${props.wait.description ?? ''}`;
    assert.match(said, /default[^.]*\btrue\b[^.]*MCP|MCP[^.]*default[^.]*\btrue\b|waits by default/i, 'the MCP default is not stated');
    assert.match(said, /REST[^.]*\bfalse\b|REST[^.]*(?:does not wait|answers at once)/i, 'the REST default is not stated');
  });

  it('the answer shapes carry `wait` — held by the -db case that drives both doors', () => {
    const text = src(OWNER);
    // The one module that builds every answer names the wait it used in EACH body (derived from the bodies, not counted); the
    // behavioural half is network-sync-takes-wait-and-timeout-on-both-doors-db.test.js.
    const bodies = [...text.matchAll(/\bok: (?:true|false), status: '[a-z]+'[^}]*\}/g)].map(m => m[0]);
    assert.ok(bodies.length >= 4, `only ${bodies.length} answer bodies found in ${OWNER} — the sweep is broken`);
    const silent = bodies.filter(b => !/\bwait: (?:true|false)\b/.test(b));
    assert.deepEqual(silent, [], `these answers do not say which wait they used: ${silent.join(' | ')}`);
  });
});
