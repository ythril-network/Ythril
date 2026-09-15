/**
 * The MCP/REST gap is declared, and every declaration is checked in BOTH directions.
 *
 * ## The report
 *
 * The canary operator, 2026-08-11T1722Z: *"The rights matrix decides what a token may do; the surface should not
 * also decide whether it can."* They hit five REST-only capabilities in one day of ordinary work, none of them
 * from auditing the API — reindex, schema write, token listing, `retry_embed_file`, space creation.
 *
 * The sharpest part of the report was not the five. It was that they **could not tell absent from gated**: a
 * tool hidden by a right they lack and a tool that was never built look identical from outside, and one is a
 * documentation fix while the other is an afternoon of work. So they had to ask.
 *
 * ## What this gate protects
 *
 * `REST_ONLY_CAPABILITIES` is a list of promises that things are MISSING, which is an unusual thing to assert
 * and needs both halves checked or it rots silently:
 *
 *  1. **The REST route named must exist.** Otherwise the map sends an integrator at a 404 while telling them
 *     it is the supported path.
 *  2. **No MCP tool of that name may exist.** The day somebody builds `reindex`, this gate fails until the row
 *     is deleted — so the map cannot keep advertising a gap that has been closed. That is the direction a
 *     hand-maintained list always rots in, and the one nobody notices, because closing a gap feels like the end
 *     of the job.
 *
 * A hand-maintained list is what produced the five gaps. A hand-maintained list OF the gaps would reproduce the
 * problem one level up, which is why neither half is taken on trust.
 *
 * Run: node --test testing/standalone/mcp-rest-parity.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

let REST_ONLY_CAPABILITIES, restOnlyCapabilityMap, ALL_TOOLS;

before(async () => {
  ({ REST_ONLY_CAPABILITIES, restOnlyCapabilityMap } = await import('../../server/dist/mcp/parity.js'));
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

/** Every route string declared anywhere under server/src/api, with its router prefix resolved. */
function declaredRoutes() {
  // The floor is 10 rather than the default 100: this sweeps one directory, and a floor above what it can
  // ever return would fail on correct code — which is how a guard gets deleted instead of corrected.
  const files = trackedSources('server/src/api', { floor: 10 });
  const paths = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) paths.add(m[2]);
  }
  // Router mount prefixes, read from app.ts so a remount cannot invalidate this quietly.
  const app = readFileSync('server/src/app.ts', 'utf8');
  const mounts = [...app.matchAll(/app\.use\('(\/api\/[a-z-]+)'/g)].map(m => m[1]);
  return { paths, mounts };
}

/** The MCP tool names the registry actually exposes. */
/**
 * Tool names from the REGISTRY — `ALL_TOOLS` — not from source declarations.
 *
 * It used to scan `server/src/mcp/tools/*.ts` for `name: '…'`, and that counted a tool as BUILT the moment someone
 * wrote the object. A tool absent from `ALL_TOOLS` is absent from `tools/list` and cannot be called, so declaring one
 * and never registering it satisfied the source scan while changing nothing an agent can reach.
 *
 * Found by mutation-testing the empty map: with the `reindex` row deleted AND `space_reindexTool` removed from the registry,
 * this file stayed GREEN — the exact "delete the row to quiet the gate" move it claims to prevent. The declaration was
 * still in `spaces.ts`, so the scan still saw it.
 */
function toolNames() {
  const names = new Set(ALL_TOOLS.map(t => t.name));
  assert.ok(names.size >= 30, `the registry holds only ${names.size} tools — the import is stale`);
  return names;
}

/** Every tool DECLARED in the tool modules, by source. Used only to compare against the registry. */
function declaredToolNames() {
  const files = trackedSources('server/src/mcp/tools', { floor: 10 });
  const names = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/^\s*name: '([a-z_]+)',/gm)) names.add(m[1]);
  }
  assert.ok(names.size >= 30, `parsed only ${names.size} tool names — the parser is stale`);
  return names;
}

describe('the declared MCP/REST gap is real in both directions', () => {
  it('every row is fully specified — and an EMPTY list is the finished state, not a vacuous one', () => {
    // set-claim: the REQUIRED keys of a capability row -- the row's own shape, which this case exists to
    // enforce. Deriving it from the rows would assert that whatever they carry is what they must carry.
    // This used to assert the list was NOT empty, on the reasoning that an empty one would pass everything below
    // while saying nothing, and that completing parity should mean deleting the gate.
    //
    // Both halves of that turned out to be wrong once parity was actually completed. The gate is not vacuous when the
    // list is empty: the two assertions that carry it — `every REST route it names EXISTS` and `the five reported
    // capabilities are each either still mapped or now BUILT` — are precisely what stops rows being DELETED to quiet
    // it, and the second one only gets stronger as rows disappear, because each name must then resolve to a real tool.
    //
    // And deleting the gate on completion is the worst available option: the next capability added to one surface and
    // not the other would meet no check at all. `help()` reports this list to every caller, so an empty list is a
    // CLAIM — that nothing is REST-only — and a claim is exactly what wants a test.
    //
    // So: empty is allowed, every row that exists must still be fully specified, and the anti-deletion guarantee
    // lives in the two assertions named above rather than in a length check.
    for (const c of REST_ONLY_CAPABILITIES) {
      for (const field of ['capability', 'restEndpoint', 'method', 'wouldBeTool', 'why']) {
        assert.ok(typeof c[field] === 'string' && c[field].trim().length > 0,
          `${c.capability ?? '(unnamed)'} is missing \`${field}\``);
      }
      assert.ok(c.why.length > 40,
        `\`why\` for ${c.capability} is too short to be a reason — a blank is what invites the next gap`);
      // Length alone is a weak proxy, and mutation testing proved it: a placeholder with a long sentence after
      // it passed the length check. A reason that defers is not a reason, and this map is read by the people
      // waiting on the work.
      assert.doesNotMatch(c.why, /\b(TODO|TBD|FIXME|N\/?A|later|somebody|eventually|no reason)\b/i,
        `\`why\` for ${c.capability} defers instead of explaining. Say what is missing and why, or delete the row`);
    }
  });

  it('every REST route it names EXISTS', () => {
    const { paths, mounts } = declaredRoutes();
    const missing = [];
    for (const c of REST_ONLY_CAPABILITIES) {
      // The declared endpoint is absolute; a router declares it relative to its mount. Strip each known mount
      // and see whether what remains was declared. `/api/spaces` with a router path of `/` is the awkward case,
      // so an empty remainder is normalised back to `/`.
      const hit = [...mounts].some(m => {
        if (!c.restEndpoint.startsWith(m)) return false;
        const rel = c.restEndpoint.slice(m.length) || '/';
        return paths.has(rel);
      }) || paths.has(c.restEndpoint);
      if (!hit) missing.push(`${c.capability}: ${c.method} ${c.restEndpoint}`);
    }
    assert.deepEqual(missing, [],
      'the capability map names a REST route that does not exist, so it would send an integrator at a 404 while '
      + 'calling it the supported path:\n  ' + missing.join('\n  '));
  });

  it('no MCP tool exists for any row — a closed gap must be DELETED, not left advertised', () => {
    const tools = toolNames();
    const built = REST_ONLY_CAPABILITIES.filter(c => tools.has(c.wouldBeTool));
    assert.deepEqual(built.map(c => c.wouldBeTool), [],
      `these tools now EXIST, so the rows claiming they are missing are wrong. Delete the row (and tell the `
      + `partner who asked): ${built.map(c => c.wouldBeTool).join(', ')}`);
  });

  it('the five reported capabilities are each either still mapped or now BUILT', () => {
    // set-claim: the five capabilities the canary REPORTED, a historical fact rather than a live set. The
    // case says so: these are the names an integrator was told about, and must not quietly disappear.
    // Named outright rather than counted: these are the ones an integrator was told about, and a refactor that
    // dropped one would quietly un-answer their report.
    //
    // "Still in the map" is the wrong invariant on its own, and using the gate is what showed it: a row LEAVES
    // the map when its tool ships, which is the whole lifecycle this file enforces. So the requirement is that
    // each reported capability is accounted for one way or the other — mapped as missing, or present as a tool.
    // Neither is the failure worth catching, and that is what this now catches.
    const mapped = new Set(REST_ONLY_CAPABILITIES.map(c => c.wouldBeTool));
    const built = toolNames();
    const lost = [];
    for (const t of ['space_reindex', 'schema_update', 'list_tokens', 'retry_embed_file', 'save_space']) {
      if (!mapped.has(t) && !built.has(t)) lost.push(t);
    }
    assert.deepEqual(lost, [],
      `reported as a gap, and now neither in the map nor built as a tool — the report has been silently `
      + `un-answered: ${lost.join(', ')}`);
  });

  it('every tool that EXISTS in source is actually registered', () => {
    // The hole the fix above closed, asserted directly rather than left to the parity rows. A tool object written and
    // never added to `ALL_TOOLS` is unreachable: absent from `tools/list`, uncallable, and invisible to every check
    // that reads the registry — while reading in source review as a shipped feature.
    const unregistered = [...declaredToolNames()].filter(n => !toolNames().has(n));
    assert.deepEqual(unregistered, [],
      `declared in server/src/mcp/tools but missing from ALL_TOOLS, so no agent can call them: ${unregistered.join(', ')}`);
  });

  it('help() reports the map, with mcpTool null on every row', () => {
    const map = restOnlyCapabilityMap();
    assert.equal(map.capabilities.length, REST_ONLY_CAPABILITIES.length);
    for (const row of map.capabilities) {
      assert.equal(row.mcpTool, null, 'a row in the REST-only map must not claim an MCP tool');
      assert.ok(row.why && row.restEndpoint && row.method, 'each row must carry its reason and its route');
    }
    // The distinction they said they could not make from outside must be stated where they will read it.
    assert.match(map.note, /absent|not a permission/i,
      'the note must say these are absences rather than rights the caller lacks — that is the whole ask');
  });

  it('help() actually emits it, rather than only being able to', () => {
    const src = readFileSync('server/src/mcp/tools/help.ts', 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(src, /restOnlyCapabilityMap\(\)/, 'help must call the map');
    assert.match(src, /structuredContent/, 'the map must ride in structuredContent, not only in prose');
  });
});
