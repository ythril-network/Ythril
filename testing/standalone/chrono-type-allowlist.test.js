/**
 * The chrono type allowlist must be enforced by EVERY write surface.
 *
 * `save_chrono` rejected a type outside the space's allowed set; `update_chrono` did not — so a record
 * could be moved to a disallowed type through the door that skipped the check. Both REST handlers
 * enforced it, which made MCP update the one surface of four that did not.
 *
 * That asymmetry is worse than either rule alone: the constraint looks enforced right up until someone
 * uses the other door, and nothing anywhere reports that it was bypassed.
 *
 * **These are behavioural, not source greps.** A grep-based first version of this file SURVIVED a
 * mutation that moved the guard into an `else if (false)` branch — the strings were still inside the
 * region being matched, so the test could not tell live code from dead code. The rejection happens
 * before any database call, so the handler can be driven directly with nothing but a config file.
 *
 * Run: node --test testing/standalone/chrono-type-allowlist.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-chrono-allowlist-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH; // read at module load — must be set before importing

/** A space whose schema declares its OWN chrono types, so the built-in defaults are not the allowlist. */
const SPACE = {
  id: 'ops',
  label: 'Ops',
  meta: { typeSchemas: { chrono: { incident: {}, maintenance: {} } } },
};

let save_chronoTool, update_chronoTool;

before(async () => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [SPACE], networks: [], tokens: [] }, null, 2));
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  ({ save_chronoTool, update_chronoTool } = await import('../../server/dist/mcp/tools/chrono.js'));
});

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const ctx = args => ({ args: { space: 'ops', ...args }, callSpace: 'ops', actor: undefined });

/** The allowlist rejection, told apart from any later failure (database, quota, …). */
const isAllowlistRejection = err => /type must be one of/.test(String(err?.message ?? err));

describe('update_chrono — the gap this closes', () => {
  it('REJECTS a type outside the space allowlist', async () => {
    await assert.rejects(
      () => update_chronoTool.handle(ctx({ id: 'c1', type: 'event' })),
      isAllowlistRejection,
      'the space declares incident/maintenance, so the built-in "event" must be refused',
    );
  });

  it('names the allowed types, so the caller can correct itself', async () => {
    const err = await update_chronoTool.handle(ctx({ id: 'c1', type: 'nonsense' })).catch(e => e);
    assert.match(String(err.message), /incident/);
    assert.match(String(err.message), /maintenance/);
  });

  it('does NOT reject an allowed type — the guard gates the bad value, not the field', async () => {
    // This one gets past the allowlist and fails later (no database in a standalone run). Telling the
    // two apart is the point: a guard that rejected everything would pass the test above and be useless.
    const err = await update_chronoTool.handle(ctx({ id: 'c1', type: 'incident' })).catch(e => e);
    assert.ok(err, 'no database here, so it must fail somewhere');
    assert.ok(!isAllowlistRejection(err), `expected a later failure, got the allowlist rejection: ${err.message}`);
  });

  it('an update that does not touch `type` is not gated on it', async () => {
    const err = await update_chronoTool.handle(ctx({ id: 'c1', title: 'renamed' })).catch(e => e);
    assert.ok(!isAllowlistRejection(err), 'renaming an entry must not require a valid type argument');
  });
});

describe('create_chrono still enforces the same rule', () => {
  it('REJECTS a type outside the space allowlist', async () => {
    await assert.rejects(
      () => save_chronoTool.handle(ctx({ title: 'x', type: 'event', startsAt: '2026-01-01T00:00:00Z' })),
      isAllowlistRejection,
    );
  });

  it('and both surfaces reject with the SAME message', async () => {
    // Two rules that agree in effect but differ in wording still read as two rules to whoever hits them.
    const a = await save_chronoTool.handle(ctx({ title: 'x', type: 'nope', startsAt: '2026-01-01T00:00:00Z' })).catch(e => e);
    const b = await update_chronoTool.handle(ctx({ id: 'c1', type: 'nope' })).catch(e => e);
    assert.equal(a.message, b.message);
  });
});

/**
 * `ChronoKind` was removed in 3.0 (`_DEPRECATIONS.md` row 2.5). It aliased `ChronoType` and had zero
 * consumers on either side — which is exactly how a dead alias survives a major: nothing breaks, so
 * nothing notices, and the next person to reach for a chrono type has two names to choose between.
 *
 * A type alias leaves nothing at runtime to assert against, so this one has to be a source check. It is
 * scoped to the two files that declared it rather than the whole tree, so an unrelated identifier that
 * merely contains the word — `onEditChronoKindChange`, `drawerChronoKind` — cannot fail it.
 */
describe('the ChronoKind alias does not come back', () => {
  it('neither type module declares it', () => {
    for (const path of ['server/src/config/types.ts', 'client/src/app/core/api.types.ts']) {
      const src = fs.readFileSync(path, 'utf8');
      assert.ok(!/export type ChronoKind\b/.test(src),
        `${path} re-declares the alias removed in 3.0 — say ChronoType`);
      // And the type it aliased must still be there, or this gate would pass on a file that lost both.
      assert.ok(/export type ChronoType\b/.test(src),
        `${path} no longer declares ChronoType, so the check above proves nothing`);
    }
  });
});
