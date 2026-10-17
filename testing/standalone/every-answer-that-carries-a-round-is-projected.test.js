/**
 * Every door that OPENS a vote round answers the round as the operator's list shows it — driven for real, REST and MCP
 * (Q-456, R14; design v5 section 5.3, the half that runs the doors).
 *
 * ## What it holds
 *
 * Each door of `_round-answer-doors.mjs` is called on a network where the round STAYS open (`202`), through the REST route's own
 * handler and through the MCP tool (`callTool`, `structuredContent` and the text both). The body is walked to every depth:
 *
 * - **any object carrying `roundId` and `type` is a round** and carries none of the fields the server names `NOT_FOR_AN_OPERATOR` (read from
 *   `networks/vote-acts.ts`, never listed here), and a `meta_change` round carries a `summary` equal to the one `GET /api/networks/:id/votes`
 *   shows for the same `roundId` — R14, the opening answer says what the list says;
 * - **any object carrying `roundId` and no `type` is a pointer** and must sit in a body that also carries the projected round with that
 *   `roundId` — the operator is never made to ask a second time what a round is about;
 * - **a floor of rounds found per door**: a door that stopped answering a round cannot pass by answering nothing.
 *
 * The admin wipe route is registered inline in `app.ts` (`POST /api/admin/spaces/:spaceId/wipe`), so it has no router to call: the app's own router is handed to
 * `callRoute`, so the handler that runs is production's. (Over HTTP it also runs the audit middleware, which writes to the database: that is the
 * `-db` half's.)
 *
 * What this half does not drive: the rounds that PASS at open and the deletions and wipes they carry out, which need a database and arrive
 * with the change that makes them pass (`-db`).
 *
 * Run: node --test testing/standalone/every-answer-that-carries-a-round-is-projected.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempInstanceDir, removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';
import { DOORS, DRIVERS, NOT_FOR_AN_OPERATOR_FLOOR } from './_round-answer-doors.mjs';
import { stripComments } from './_strip-comments.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const PEER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const NEW_PEER = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const NEWER_PEER = 'aaaaaaaa-0000-4000-8000-0000000000e2';
const NET = 'net-a';
const INVITE_KEY = 'a-single-use-invite-key';
const dir = tempInstanceDir('ythril-round-answers-');
const ADMIN = { rights: { instanceAdmin: true } };

/** Where each MCP tool a door is called through is defined; the tool is the module's `<name>Tool` export. */
const TOOL_MODULES = {
  network_add_space: 'networks', update_space: 'spaces', schema_update: 'spaces', delete_space_data: 'spaces',
  network_member_add: 'network-join', network_member_remove: 'network-join', network_member_admit: 'network-topology',
};
/**
 * The tool's own handler, as an administrator, answering `{ status, structured, text }` — `status` is 202 for an answer that is not an error
 * (`callTool` itself writes an audit row to the database, which is the `-db` half's to drive).
 */
async function callMcp(name, args) {
  const tool = (await import(`../../server/dist/mcp/tools/${TOOL_MODULES[name]}.js`))[`${name}Tool`];
  assert.ok(tool?.handle, `no ${name}Tool export on mcp/tools/${TOOL_MODULES[name]}.js — re-anchor this gate`);
  const out = await tool.handle({ args, rights: ADMIN.rights, callSpace: args['space'] });
  return { status: out.isError ? 'error' : 202, structured: out.structuredContent, text: (out.content ?? []).map(c => c.text ?? '').join('\n') };
}

/** The fields a round carries that are not for an operator, read from the server so a field added to its list is in this check. */
const notForAnOperator = (() => {
  const src = stripComments(fs.readFileSync('server/src/networks/vote-acts.ts', 'utf8'));
  const list = /const NOT_FOR_AN_OPERATOR = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  const fields = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const f of NOT_FOR_AN_OPERATOR_FLOOR) assert.ok(fields.includes(f), `NOT_FOR_AN_OPERATOR no longer names ${f}: re-anchor this gate`);
  return fields;
})();

const member = (instanceId) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example.com`, tokenHash: 'h', direction: 'both' });

/**
 * A closed network carrying `notes` with two other members, so no round passes at open: every opening door answers 202. Two, not one
 * (D-36): with the proposer and the subject the only members, a removal of that subject passes at open on the proposer's own yes.
 */
async function fresh(loader) {
  const bcrypt = (await import('bcrypt')).default;
  const cfg = loader.getConfig();
  cfg.spaces = [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }, { id: 'extra', label: 'Extra', folders: [], meta: { purpose: 'a space with a schema layer of its own' } }];
  cfg.networks = [{
    id: NET, label: 'Net A', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general', 'notes'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [member(PEER), member('aaaaaaaa-0000-4000-8000-0000000000a2')], pendingRounds: [],
    inviteKeyHash: await bcrypt.hash(INVITE_KEY, 4),
  }];
}

const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : Array.isArray(o) ? o.map(sortKeys) : o);

/** Every object of a body, at every depth, with its path. */
function* objectsOf(value, path = '$') {
  if (Array.isArray(value)) { for (const [i, v] of value.entries()) yield* objectsOf(v, `${path}[${i}]`); return; }
  if (value && typeof value === 'object') {
    yield { value, path };
    for (const [k, v] of Object.entries(value)) yield* objectsOf(v, `${path}.${k}`);
  }
}

/**
 * What a door's answer holds, as the rules say: the rounds found, any leak, and the pointers with no projected round beside them.
 * `listed(roundId)` is what the operator's vote list shows for that round.
 */
function judge(what, body, listed) {
  const rounds = [];
  const problems = [];
  const objs = [...objectsOf(body)];
  for (const { value, path } of objs) {
    if (typeof value.roundId !== 'string') continue;
    if (typeof value.type === 'string') {
      rounds.push(value.roundId);
      for (const f of notForAnOperator) if (f in value) problems.push(`${what} ${path}: a round carries ${f}`);
      // The round IS the one the list shows: every projected field, the local space id and the summary included.
      const shownInList = listed(value.roundId);
      if (!shownInList) problems.push(`${what} ${path}: the vote list does not show round ${value.roundId}`);
      else if (JSON.stringify(sortKeys(value)) !== JSON.stringify(sortKeys(shownInList))) problems.push(`${what} ${path}: the round is not the one the list shows (${Object.keys(value).filter(k => JSON.stringify(value[k]) !== JSON.stringify(shownInList[k])).join(', ') || 'keys differ'})`);
      if (value.type === 'meta_change') {
        const shown = listed(value.roundId)?.summary;
        if (typeof value.summary !== 'string' || value.summary === '') problems.push(`${what} ${path}: a meta_change round carries no summary`);
        else if (value.summary !== shown) problems.push(`${what} ${path}: summary "${value.summary}" is not the list's "${shown}"`);
      }
    }
  }
  for (const { value, path } of objs) {
    if (typeof value.roundId === 'string' && typeof value.type !== 'string' && !rounds.includes(value.roundId)) {
      problems.push(`${what} ${path}: a pointer ({ roundId }) with no projected round of that id in the answer`);
    }
  }
  return { rounds, problems };
}

describe('every door that opens a round answers the round the list shows', () => {
  let loader;
  let listOpenVotes;
  before(async () => {
    loader = await bootInstance(dir, { instanceId: SELF, networks: [], extra: { instanceLabel: 'self' } });
    ({ listOpenVotesAct: listOpenVotes } = await import('../../server/dist/networks/vote-acts.js'));
  });
  after(() => removeInstanceDir(dir));

  const listed = (roundId) => listOpenVotes(NET).body.rounds.find(r => r.roundId === roundId);
  const results = [];

  /**
   * The doors, each as a list of calls `[what, call]`: REST first, then MCP. A call answers `[code, body]`. Each runs on a fresh network
   * and is judged before the next starts, so what the vote list shows is read while the round it opened is still there.
   */
  const DRIVE = {
    'add-space': async () => {
      const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
      return [
        ['POST /api/networks/:id/spaces', async () => { const r = await callRoute(crudRouter, 'post', '/:id/spaces', { params: { id: NET }, body: { spaceId: 'extra' }, authToken: ADMIN }); return [r.code, r.body]; }],
        ['network_add_space (structured)', async () => { const m = await callMcp('network_add_space', { id: NET, spaceId: 'extra' }); return [m.status, m.structured]; }],
        ['network_add_space (text)', async () => { const m = await callMcp('network_add_space', { id: NET, spaceId: 'extra' }); return [m.status, safeJson(m.text)]; }],
      ];
    },
    'meta-update': async () => {
      const { spacesRouter } = await import('../../server/dist/api/spaces.js');
      const purpose = 'a purpose the network votes on';
      return [
        ['PATCH /api/spaces/:id', async () => { const r = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: 'notes' }, body: { meta: { purpose } }, authToken: ADMIN }); return [r.code, r.body]; }],
        ['update_space (structured)', async () => { const m = await callMcp('update_space', { space: 'notes', purpose }); return [m.status, m.structured]; }],
        ['schema_update (structured)', async () => { const m = await callMcp('schema_update', { space: 'notes', purpose }); return [m.status, m.structured]; }],
      ];
    },
    'delete-space': async () => {
      const { spacesRouter } = await import('../../server/dist/api/spaces.js');
      return [['DELETE /api/spaces/:id', async () => { const r = await callRoute(spacesRouter, 'delete', '/:id', { params: { id: 'notes' }, body: { confirm: true }, authToken: ADMIN }); return [r.code, r.body]; }]];
    },
    'wipe': async () => [
      ['POST /api/admin/spaces/:spaceId/wipe', async () => {
        // Registered on the app itself, so the app's own router is the one handed to `callRoute`: the handler that runs is production's.
        const { createApp } = await import('../../server/dist/app.js');
        const router = createApp().router ?? createApp()._router;
        const r = await callRoute(router, 'post', '/api/admin/spaces/:spaceId/wipe', { params: { spaceId: 'notes' }, body: { confirm: true }, authToken: ADMIN });
        return [r.code, r.body];
      }],
      ['delete_space_data (structured)', async () => { const m = await callMcp('delete_space_data', { space: 'notes', confirm: true }); return [m.status, m.structured]; }],
    ],
    'member-add': async () => {
      const { membersRouter } = await import('../../server/dist/api/networks/members.js');
      const body = { instanceId: NEW_PEER, label: 'New peer', url: 'https://new-peer.example.com', token: 'peer-token', direction: 'both' };
      return [
        ['POST /api/networks/:id/members', async () => { const r = await callRoute(membersRouter, 'post', '/:id/members', { params: { id: NET }, body, authToken: ADMIN }); return [r.code, r.body]; }],
        ['network_member_add (structured)', async () => { const m = await callMcp('network_member_add', { id: NET, ...body, instanceId: NEWER_PEER }); return [m.status, m.structured]; }],
      ];
    },
    'member-remove': async () => {
      const { membersRouter } = await import('../../server/dist/api/networks/members.js');
      return [
        ['DELETE /api/networks/:id/members/:instanceId', async () => { const r = await callRoute(membersRouter, 'delete', '/:id/members/:instanceId', { params: { id: NET, instanceId: PEER }, authToken: ADMIN }); return [r.code, r.body]; }],
        ['network_member_remove (structured)', async () => { const m = await callMcp('network_member_remove', { id: NET, instanceId: PEER }); return [m.status, m.structured]; }],
      ];
    },
    'invite-key-join': async () => {
      const { joinRouter } = await import('../../server/dist/api/networks/join.js');
      const body = { inviteKey: INVITE_KEY, instanceId: NEW_PEER, label: 'Joiner', url: 'https://joiner.example.com', token: 'joiner-token', direction: 'both' };
      return [
        ['POST /api/networks/:id/join', async () => { const r = await callRoute(joinRouter, 'post', '/:id/join', { params: { id: NET }, body, authToken: ADMIN }); return [r.code, r.body]; }],
        ['network_member_admit (structured)', async () => { const m = await callMcp('network_member_admit', { id: NET, ...body, instanceId: NEWER_PEER }); return [m.status, m.structured]; }],
      ];
    },
  };
  const safeJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

  it('every driver the door table names is implemented here, and every implemented driver is named by a row', () => {
    assert.deepEqual(Object.keys(DRIVE).sort(), [...DRIVERS].sort());
    assert.ok(DOORS.every(d => d.driver || d.exempt), 'a row with neither a driver nor a reason');
  });

  for (const driver of DRIVERS) {
    it(`${driver}: each call answers 202 with the projected round and no pointer beside nothing`, async () => {
      const calls = await DRIVE[driver]();
      const bad = [];
      for (const [what, call] of calls) {
        await fresh(loader);
        const [code, body] = await call();
        assert.equal(code, 202, `${what} answered ${code} ${JSON.stringify(body)?.slice(0, 300)} — the fixture must leave the round open, or this checks a different answer`);
        assert.ok(body && typeof body === 'object', `${what} answered no body`);
        const { rounds, problems } = judge(what, body, listed);
        if (rounds.length === 0) problems.push(`${what}: no round found in the answer — a door that answers no round cannot pass`);
        bad.push(...problems);
        results.push({ driver, what, rounds: rounds.length });
      }
      assert.deepEqual(bad, []);
    });
  }

  it('R14: the meta door\'s 202 round says what the vote list says about it', async () => {
    await fresh(loader);
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    const res = await callRoute(spacesRouter, 'patch', '/:id', { params: { id: 'notes' }, body: { meta: { purpose: 'compare me' } }, authToken: ADMIN });
    assert.equal(res.code, 202, JSON.stringify(res.body));
    const first = res.body.rounds?.[0];
    assert.ok(first?.round, `the 202 carries no projected round: ${JSON.stringify(res.body.rounds)}`);
    assert.ok(typeof first.round.summary === 'string' && first.round.summary, 'the opening answer of a meta_change round carries its summary');
    assert.equal(first.round.summary, listed(first.roundId ?? first.round.roundId)?.summary, 'the summary equals the one GET /api/networks/:id/votes shows');
  });
});
