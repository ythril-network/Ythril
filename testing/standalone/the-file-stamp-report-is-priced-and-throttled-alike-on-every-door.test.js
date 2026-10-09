/**
 * `file_stamp_report` costs the same on every door: one admin gate, one heavy-call rail, one single flight (`Q-433`, plan
 * rev 4 items 5, 21, 26, 27, 30).
 *
 * ## Why this report is priced at all
 *
 * It is not a view of a space. It names peer instances and spends this instance's credentials on every peer that holds
 * the space — the same thing the manual network sync routes do, and priced the same way: instance admin, with a
 * `NOT_AREA_SCOPED` row whose reason says so (`auth/space-rights.ts`; a files row would area-scope a route the design says is
 * not). And it is expensive in the way the ingest is: a feed walk per peer, per call. A limit a door mounts for itself is
 * one door away from missing (`beginIngest` is the precedent: the rail sits in the module both doors call), so the rail and
 * the single flight sit inside the shared module, and this file asks every DOOR for the same answer.
 *
 * ## The three doors (`_file-stamp-doors.mjs`)
 *
 * The dedicated `POST /api/spaces/:id/file-stamp-report`, `POST /api/file_stamp_report` (the REST door every tool has) and the
 * tool through `callTool` (what MCP reaches). The first two are the real application over HTTP with real tokens.
 *
 * ## What is asserted
 *
 *  - **The rail.** A token's first five calls through a door are answered, the sixth is a 429 whose sentence names the tool
 *    and does not say "destructive" (a report destroys nothing; the generic refusal's word was wrong for a read). Five
 *    calls through a door and not fewer: a call counted twice (the tool declaring `heavy` AND the module consuming) refuses
 *    the third. The count is ONE count per token across the doors: a call through any door spends a slot of the same five.
 *  - **The single flight.** While a report runs for a space, a second call on ANY door is a 409; when it ends the space is
 *    free again.
 *  - **The gate.** A read-only token, a plain write token and a token that administers the space (and holds every area of
 *    it) are all refused 403 on every door — never run, never 404 — beside a control: the instance admin is served by the
 *    same door in the same test, so a door that does not exist cannot read as "refused".
 *  - **The row.** `NOT_AREA_SCOPED` has the dedicated route with a reason; `ROUTE_RIGHTS` has no row for it and
 *    `TOOL_RIGHTS` none for the tool (it is gated by `admin: true`, as the network tools are).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-file-stamp-report-is-priced-and-throttled-alike-on-every-door.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openStampDoor } from './_file-stamp-door.mjs';
import { openStampDoors } from './_file-stamp-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'stamprail';
const DOOR_NAMES = ['route', 'toolRest', 'mcp'];

let stamp, door, drivers, HEAVY_CALLS_PER_WINDOW, served;

before(async () => {
  stamp = await openStampDoor({ suite: 'stamprail', space: S });
  door = stamp.door;
  drivers = await openStampDoors(S);
  ({ HEAVY_CALLS_PER_WINDOW } = await import('../../server/dist/rate-limit/heavy-tool.js'));
});
after(async () => { await drivers?.close(); await stamp?.close(); });
beforeEach(async () => {
  served = 0;
  await stamp.reset();
  await stamp.s1('docs/a.txt');
  door.state.family = async (req, res, family) => { served++; await door.serveFamily(req, res, family); };
});

const answered = (r) => r.status === 200 && Array.isArray(r.answer?.rows);

describe('the gate: instance admin on every door, beside a control that is served', { skip }, () => {
  for (const doorName of DOOR_NAMES) {
    it(`${doorName}: the instance admin is served`, async () => {
      const r = await drivers.doors[doorName](await drivers.token('admin'));
      assert.ok(answered(r), `the control was not served: ${r.status} ${r.error ?? ''}`);
      assert.equal(r.answer.rows.length, 1);
    });

    for (const kind of ['read-only', 'write', 'space-admin']) {
      it(`${doorName}: a ${kind} token is refused 403, and nothing is sent to a peer`, async () => {
        const control = await drivers.doors[doorName](await drivers.token('admin'));
        assert.ok(answered(control), `the control (instance admin) was not served, so a refusal here proves nothing: ${control.status} ${control.error ?? ''}`);
        const before = served;
        const r = await drivers.doors[doorName](await drivers.token(kind));
        assert.equal(r.status, 403, `a ${kind} token got ${r.status} (${r.error ?? JSON.stringify(r.answer).slice(0, 120)})`);
        assert.ok(typeof r.error === 'string' && r.error.trim() !== '', 'a refusal with no sentence');
        assert.equal(served, before, 'the report ran for a token that may not run it: a peer was asked');
      });
    }
  }
});

describe('the rail: five calls a minute per token, the sixth is a 429, on every door', { skip }, () => {
  for (const doorName of DOOR_NAMES) {
    it(`${doorName}: the first ${5} calls are answered and the sixth is refused with a sentence of the tool's own`, async () => {
      assert.equal(HEAVY_CALLS_PER_WINDOW, 5, 'the rail is no longer five a minute: the doors and the docs say five');
      const tok = await drivers.token('admin');
      const statuses = [];
      let sixth;
      for (let i = 1; i <= HEAVY_CALLS_PER_WINDOW + 1; i++) {
        const r = await drivers.doors[doorName](tok);
        statuses.push(r.status);
        if (i <= HEAVY_CALLS_PER_WINDOW) assert.ok(answered(r), `call ${i} of ${HEAVY_CALLS_PER_WINDOW} was not answered: ${JSON.stringify(statuses)} ${r.error ?? ''}`);
        else sixth = r;
      }
      assert.equal(sixth.status, 429, `the sixth call through ${doorName} was answered ${sixth.status}: ${JSON.stringify(statuses)}`);
      assert.match(sixth.error, /rate limited/i);
      assert.match(sixth.error, /file[_ ]stamp/i, 'the refusal does not name the tool');
      assert.doesNotMatch(sixth.error, /destructive/i, 'a report destroys nothing: the generic refusal\'s word is wrong here');
    });
  }

  it('one token has ONE count across the doors: five calls spread over all three, and the sixth is refused on each', async () => {
    const tok = await drivers.token('admin');
    const spread = ['route', 'toolRest', 'mcp', 'route', 'toolRest'];
    for (const [i, name] of spread.entries()) {
      const r = await drivers.doors[name](tok);
      assert.ok(answered(r), `call ${i + 1} through ${name} was not answered: ${r.status} ${r.error ?? ''}`);
    }
    for (const name of DOOR_NAMES) {
      const r = await drivers.doors[name](tok);
      assert.equal(r.status, 429, `${name}: the sixth call from a token that used five elsewhere was answered ${r.status}: a door with a count of its own`);
    }
  });

  it('a token that has run out does not run the report: no peer is asked by the refused call', async () => {
    const tok = await drivers.token('admin');
    for (let i = 0; i < HEAVY_CALLS_PER_WINDOW; i++) await drivers.doors.route(tok);
    const before = served;
    const r = await drivers.doors.route(tok);
    assert.equal(r.status, 429);
    assert.equal(served, before, 'a refused call walked a peer\'s feed');
  });
});

describe('the single flight: while a report runs for a space, another call is a 409 on every door', { skip }, () => {
  it('a run held open at its peer refuses a second call through each door, and the space is free again when it ends', async () => {
    let entered; const inFeed = new Promise(r => { entered = r; });
    let release; const gate = new Promise(r => { release = r; });
    door.state.family = async (req, res, family) => { entered(); await gate; await door.serveFamily(req, res, family); };

    const running = drivers.doors.route(await drivers.token('admin'));
    // A door that answers at once (it does not exist, or refuses) never reaches the peer: that is this case's failure,
    // and it must be NAMED, not waited for.
    const first = await Promise.race([inFeed.then(() => 'in the peer\'s feed'), running]);
    if (first !== 'in the peer\'s feed') {
      release();
      assert.fail(`the first call ended before it reached the peer: ${first.status} ${first.error ?? ''}`);
    }
    try {
      for (const name of DOOR_NAMES) {
        const r = await drivers.doors[name](await drivers.token('admin'));
        assert.equal(r.status, 409, `${name}: a second report for a space already being reported was answered ${r.status} (${r.error ?? 'served'})`);
        assert.match(r.error, /already|running|in progress/i, `${name}: a 409 that does not say why`);
      }
    } finally { release(); }
    const heldRun = await running;
    assert.ok(answered(heldRun), `the held run did not complete once released: ${heldRun.status} ${heldRun.error ?? ''}`);

    door.state.family = door.serveFamily;
    for (const name of DOOR_NAMES) {
      const again = await drivers.doors[name](await drivers.token('admin'));
      assert.ok(answered(again), `${name}: the space stayed busy after its run ended: ${again.status} ${again.error ?? ''}`);
    }
  });

  it('a run that FAILS frees the space as well', async () => {
    door.state.family = (_req, res) => { res.status(500).json({ error: 'scripted' }); };
    const failed = await drivers.doors.route(await drivers.token('admin'));
    assert.ok(answered(failed), 'a peer failure is a row of the report, not a failure of it');
    door.state.family = door.serveFamily;
    const again = await drivers.doors.mcp(await drivers.token('admin'));
    assert.ok(answered(again), `the space stayed busy after a run that met a failing peer: ${again.status} ${again.error ?? ''}`);
  });
});

describe('the row: NOT_AREA_SCOPED with a reason, and no area row on either half', { skip }, () => {
  let NOT_AREA_SCOPED, ROUTE_RIGHTS, TOOL_RIGHTS;
  before(async () => { ({ NOT_AREA_SCOPED, ROUTE_RIGHTS, TOOL_RIGHTS } = await import('../../server/dist/auth/space-rights.js')); });

  it('the dedicated route is NOT_AREA_SCOPED, with the reason that it is instance-admin', () => {
    const rows = NOT_AREA_SCOPED.filter(r => /^\/api\/spaces\/:\w+\/file-stamp-report$/.test(r.route));
    assert.equal(rows.length, 1, `NOT_AREA_SCOPED holds ${rows.length} rows for the file-stamp-report route`);
    assert.ok(typeof rows[0].why === 'string' && rows[0].why.trim().length >= 40, `the row has no reason worth the name: ${JSON.stringify(rows[0].why)}`);
    assert.match(rows[0].why, /instance[- ]admin/i);
  });

  it('there is no ROUTE_RIGHTS row for it (a files row would area-scope what the design says is not), and no TOOL_RIGHTS row for the tool', async () => {
    // Beside the row that exists: "no area row" is only evidence about a route that is priced somewhere.
    assert.ok(NOT_AREA_SCOPED.some(r => /file-stamp-report/.test(r.route)), 'the route is in NOT_AREA_SCOPED nowhere, so "no area row" says nothing about it');
    const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
    assert.ok(TOOLS_BY_NAME.has('file_stamp_report'), 'there is no file_stamp_report tool, so "no TOOL_RIGHTS row" says nothing about it');
    assert.deepEqual(ROUTE_RIGHTS.filter(r => /file-stamp-report/.test(r.route)).map(r => r.route), []);
    assert.deepEqual(TOOL_RIGHTS.filter(r => r.tool === 'file_stamp_report'), [],
      'the tool is gated by `admin: true`; a TOOL_RIGHTS row prices it a second time, at an area');
  });

  it('the tool is instance-admin, space-required and not mutating', async () => {
    const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
    const tool = TOOLS_BY_NAME.get('file_stamp_report');
    assert.ok(tool, 'there is no file_stamp_report tool');
    assert.equal(tool.admin, true);
    assert.equal(tool.spaceRequired, true);
    assert.ok(!tool.mutating, 'the report writes nothing on this instance but its audit entry: it is not a mutating tool');
  });
});
