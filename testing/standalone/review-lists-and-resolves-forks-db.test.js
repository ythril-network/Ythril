/**
 * Review lists the forks of a space and resolves one, on both doors, with one set of parameters and one set of refusals
 * (bundle-81 test 20; design rev 8 section 5 "Review is a new capability in five places", vet decision 19).
 *
 * ## What it holds
 *
 * Two copies of a fact at one seq whose texts differ are forked: the second is stored under a derived id with `forkOf` naming the
 * parent. Today nothing reads the forks and nothing resolves one. The plan's five places for the capability:
 *
 *  1. REST `GET /api/brain/spaces/:spaceId/forks` (`skip`, `limit`) and `POST .../forks/:forkId/resolve {keep: 'fork' | 'parent'}`;
 *  2. MCP `list_forks {space, skip?, limit?}` and `resolve_fork {space, forkId, keep}`, "same parameters, caps and refusals";
 *  5. rights: `ROUTE_RIGHTS` rows (list: knowledge read; resolve: knowledge write) and `TOOL_RIGHTS` rows for the two tools.
 *
 * (Docs, the user guide page and the surface matrix are the other places; a capability map gate holds those.)
 *
 * ## What a resolve is
 *
 * The kept body is written as a LOCAL EDIT of the parent id, stamped above both the parent's and the fork's version; the fork is
 * deleted by a tombstone this instance issues (`issuedHere`); every edge and link that points at the fork id is repointed to the parent,
 * and none is left pointing at the fork. Either side may be kept: keeping the parent still writes the parent, still deletes the fork.
 *
 * ## The rule, over the whole set it governs
 *
 * Every case runs through every door that exists: the named REST route (found on the brain router by its path, whatever file declares
 * it), the MCP tool, and the generic REST tool door `POST /api/<tool>` (which exists for free once the tool does). The doors are
 * compared on what they answer, identity by identity (fork ids, bodies), and on the SENTENCE of each refusal, which must be one string.
 * Rights are held by the tables the plan names, and by a read-only token being refused a resolve through the tool doors.
 *
 * The plan names no response body for either door. The test reads the rows from the first array a body holds, and a fork's id from
 * `_id`, `id` or `forkId`; the report names this as the shape to settle.
 *
 * Run: node --test testing/standalone/review-lists-and-resolves-forks-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { handlerFor, fakeRes } from './_vote-round-instance.mjs';

const skip = await mongoSkipReason();
const S = 'b81forks';

/** The first array a body holds, or the body when it is one. */
const rowsOf = (body) => (Array.isArray(body) ? body : Object.values(body ?? {}).find(Array.isArray) ?? []);
const idOf = (r) => String(r?._id ?? r?.id ?? r?.forkId ?? r?.fork?._id ?? r?.fork?.id);

/** A route by path and method anywhere under a router, however deeply sub-routers nest it. */
function findHandler(router, method, routePath) {
  const walk = (r) => {
    for (const layer of r.stack ?? []) {
      if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
      if (layer.handle?.stack) { const hit = walk(layer.handle); if (hit) return hit; }
    }
    return undefined;
  };
  return walk(router);
}

describe('Review lists and resolves forks, on both doors', { skip }, () => {
  let door; let brainRouter; let toolsRouter; let callTool; let forkIdFor; let edgeIdFor; let linkIdFor; let adminRights; let readerRights;

  before(async () => {
    door = await openPushDoor({ suite: 'b81tD_forks', spaces: [{ id: S, label: 'Forks', folders: [], meta: {} }] });
    ({ brainRouter } = await import('../../server/dist/api/brain/index.js'));
    ({ toolsRouter } = await import('../../server/dist/api/tools.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ forkIdFor } = await import('../../server/dist/sync/upsert-plan.js'));
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const floorOf = (rung) => Object.fromEntries(SPACE_AREAS.map(a => [a, rung]));
    adminRights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: floorOf('admin') };
    readerRights = { instanceAdmin: false, createSpaces: false, perSpace: {}, floor: floorOf('read'), spaceAdmin: { floor: false, spaces: [] } };
  });
  after(async () => { await door?.close(); });

  /** Parent `f` (seq 5, text "mine"), two forks of it, a parent `g` with one fork, and a plain fact `plain`. Edges and a link point at fork `f1`. */
  let ids;
  beforeEach(async () => {
    await door.wipe(S);
    const f1 = forkIdFor('f', 5, 'theirs one'); const f2 = forkIdFor('f', 5, 'theirs two'); const g1 = forkIdFor('g', 7, 'theirs g');
    ids = { f1, f2, g1 };
    await door.coll(S, 'facts').insertMany([
      build.fact(S, 'f', 5, { fact: 'mine' }),
      build.fact(S, f1, 5, { fact: 'theirs one', forkOf: 'f' }),
      build.fact(S, f2, 5, { fact: 'theirs two', forkOf: 'f' }),
      build.fact(S, 'g', 7, { fact: 'mine g' }),
      build.fact(S, g1, 7, { fact: 'theirs g', forkOf: 'g' }),
      build.fact(S, 'plain', 3, { fact: 'not a fork' }),
    ]);
    await door.coll(S, 'entities').insertOne(build.entity(S, 'e1', 2));
    await door.coll(S, 'edges').insertOne(build.edge(S, edgeIdFor(f1, 'e1', 'about', 'fact', 'entity'), 6, { from: f1, fromKind: 'fact', to: 'e1', toKind: 'entity', label: 'about' }));
    await door.coll(S, 'links').insertOne(build.link(S, linkIdFor(f1, 'fact', 'e1', 'entity'), 6, { from: f1, fromKind: 'fact', to: 'e1', toKind: 'entity' }));
  });

  // ── the doors ───────────────────────────────────────────────────────────────────────────────────────────────────
  const restRoute = async (method, routePath, { params = {}, body = {}, query = {}, rights = adminRights } = {}) => {
    const handler = findHandler(brainRouter, method, routePath);
    assert.ok(handler, `no ${method.toUpperCase()} ${routePath} on the brain router: the capability's REST door does not exist`);
    const res = { ...fakeRes(), end() { this.sent = true; return this; } };
    await handler({ method: method.toUpperCase(), params, body, query, authToken: { rights }, headers: {}, get: () => undefined }, res);
    assert.ok(res.sent, `${method} ${routePath} settled without answering`);
    return { ok: res.code < 400, body: res.body, sentence: res.body?.error };
  };
  let serial = 0;
  const caller = (rights, transport) => { const id = `b81d-${++serial}`; return { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: id, tokenLabel: id }; };
  const mcp = async (name, args, rights = adminRights) => {
    const out = await callTool({ name, args, caller: caller(rights, 'mcp') });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('');
    // The `Error: ` an MCP refusal opens with is the transport's framing of a thrown message (every both-doors test strips it); the sentence is what follows.
    return { ok: !out.result.isError, body: out.result.structuredContent ?? null, sentence: out.result.isError ? text.replace(/^Error: /, '') : undefined, text };
  };
  const toolDoor = async (name, args, rights = adminRights) => {
    const res = { ...fakeRes(), end() { this.sent = true; return this; }, setHeader() { return this; }, set() { return this; }, send(b) { this.body = b; this.sent = true; return this; } };
    await handlerFor(toolsRouter, 'post', '/:tool')({ method: 'POST', params: { tool: name }, body: args, query: {}, authToken: { rights }, ip: '127.0.0.1', headers: {}, get: () => undefined }, res);
    return { ok: res.code < 400, body: res.body?.data ?? null, sentence: typeof res.body?.error === 'string' ? res.body.error.replace(/^Error: /, '') : res.body?.error };
  };
  const doors = {
    list: {
      REST: (q = {}) => restRoute('get', '/spaces/:spaceId/forks', { params: { spaceId: S }, query: q }),
      MCP: (q = {}) => mcp('list_forks', { space: S, ...q }),
      TOOLDOOR: (q = {}) => toolDoor('list_forks', { space: S, ...q }),
    },
    // Q-624 re-anchor (design §9, D5): `kind`, `forkId`, `keep`, `ifMatchSeq` and `ifMatchParentSeq` are ALL required on both doors, so every resolve
    // here states them, the two versions read from the store at the moment of the call. (`?? 0` keeps the request complete for an id that is not
    // stored, so the refusals below are still the ones about the id and the keep.)
    resolve: {
      REST: async (forkId, keep) => restRoute('post', '/spaces/:spaceId/forks/:forkId/resolve', { params: { spaceId: S, forkId }, body: await resolveBody(forkId, keep) }),
      MCP: async (forkId, keep) => mcp('resolve_fork', { space: S, forkId, ...await resolveBody(forkId, keep) }),
      TOOLDOOR: async (forkId, keep) => toolDoor('resolve_fork', { space: S, forkId, ...await resolveBody(forkId, keep) }),
    },
  };
  const resolveBody = async (forkId, keep) => {
    const fork = await door.coll(S, 'facts').findOne({ _id: forkId });
    const parent = fork?.forkOf ? await door.coll(S, 'facts').findOne({ _id: fork.forkOf }) : null;
    return { kind: 'fact', keep, ifMatchSeq: fork?.seq ?? 0, ifMatchParentSeq: parent?.seq ?? 0 };
  };

  // ── the rule ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('every door lists the same forks, each beside its parent, and never a record that is not a fork', async () => {
      const answers = {};
      for (const [name, door1] of Object.entries(doors.list)) {
        const r = await door1();
        assert.ok(r.ok, `${name}: list_forks refused: ${r.sentence}`);
        answers[name] = rowsOf(r.body);
        assert.deepEqual(answers[name].map(idOf).sort(), [ids.f1, ids.f2, ids.g1].sort(), `${name}: the forks listed are not the forks stored`);
        const text = JSON.stringify(answers[name]);
        assert.ok(text.includes('mine') && text.includes('theirs one'), `${name}: a fork is not shown beside its parent's text`);
        assert.ok(!text.includes('not a fork'), `${name}: a record that is no fork is listed`);
      }
      assert.deepEqual(answers.REST.map(idOf), answers.MCP.map(idOf), 'REST and MCP list the forks in a different order');
      assert.deepEqual(answers.TOOLDOOR.map(idOf), answers.MCP.map(idOf), 'the REST tool door and MCP list the forks in a different order');
    });

    it('skip and limit page the list without a repeat or a gap, on every door', async () => {
      for (const [name, door1] of Object.entries(doors.list)) {
        const a = rowsOf((await door1({ limit: 2, skip: 0 })).body).map(idOf);
        const b = rowsOf((await door1({ limit: 2, skip: 2 })).body).map(idOf);
        assert.equal(a.length, 2, `${name}: limit 2 answered ${a.length} rows`);
        assert.equal(b.length, 1, `${name}: skip 2 of 3 answered ${b.length} rows`);
        assert.deepEqual([...a, ...b].sort(), [ids.f1, ids.f2, ids.g1].sort(), `${name}: the pages repeat or miss a fork`);
      }
    });
  });

  describe('resolve', () => {
    /** The doors take turns, one fork each, so every case of the rule is held on every door and the others' data is untouched. */
    const turn = { REST: () => ids.f1, MCP: () => ids.f2, TOOLDOOR: () => ids.g1 };

    for (const keep of ['fork', 'parent']) {
      it(`keep '${keep}': the parent is written above both versions, the fork is gone behind a tombstone this instance issued, nothing points at the fork`, async () => {
        const door1 = doors.resolve.MCP;
        const forkId = ids.f1;
        const before = { parent: await door.coll(S, 'facts').findOne({ _id: 'f' }), fork: await door.coll(S, 'facts').findOne({ _id: forkId }) };
        const r = await door1(forkId, keep);
        assert.ok(r.ok, `resolve_fork refused: ${r.sentence}`);
        const parent = await door.coll(S, 'facts').findOne({ _id: 'f' });
        assert.equal(parent.fact, keep === 'fork' ? before.fork.fact : before.parent.fact, `keep '${keep}' left the wrong text on the parent`);
        assert.ok(parent.seq > Math.max(before.parent.seq, before.fork.seq), `the parent is at ${parent.seq}: not above both ${before.parent.seq} and ${before.fork.seq}, so a peer holding either keeps it`);
        assert.equal(parent.forkOf, undefined, 'the parent became a fork');
        assert.equal(await door.coll(S, 'facts').countDocuments({ _id: forkId }), 0, 'the fork is still stored');
        const tomb = await door.coll(S, 'tombstones').findOne({ _id: forkId });
        assert.ok(tomb, 'no tombstone for the deleted fork, so peers keep it');
        assert.equal(tomb.issuedHere, true, 'the fork\'s tombstone is not marked as issued here, so mesh peers never receive the deletion');
        assert.equal(await door.coll(S, 'facts').countDocuments({ _id: ids.f2 }), 1, 'a sibling fork was resolved with it');
        // Edges and links: none left on the fork id, exactly one on the parent, to the same other end.
        assert.equal(await door.coll(S, 'edges').countDocuments({ $or: [{ from: forkId }, { to: forkId }] }), 0, 'an edge still points at the fork');
        assert.equal(await door.coll(S, 'links').countDocuments({ $or: [{ from: forkId }, { to: forkId }] }), 0, 'a link still points at the fork');
        const edges = await door.coll(S, 'edges').find({ from: 'f', to: 'e1' }).toArray();
        const links = await door.coll(S, 'links').find({ from: 'f', to: 'e1' }).toArray();
        assert.equal(edges.length, 1, `${edges.length} edge(s) from the parent to e1, expected the repointed one`);
        assert.equal(links.length, 1, `${links.length} link(s) from the parent to e1, expected the repointed one`);
        assert.equal(edges[0]._id, edgeIdFor('f', 'e1', 'about', 'fact', 'entity'), 'the repointed edge keeps the fork\'s derived id, which no longer matches its endpoints');
      });
    }

    it('REST, MCP and the tool door each resolve a fork, and each answers as the others do', async () => {
      const answers = {};
      for (const name of Object.keys(doors.resolve)) {
        const forkId = turn[name]();
        const r = await doors.resolve[name](forkId, 'parent');
        assert.ok(r.ok, `${name}: resolve refused: ${r.sentence}`);
        answers[name] = r.body;
        assert.equal(await door.coll(S, 'facts').countDocuments({ _id: forkId }), 0, `${name}: the fork it resolved is still stored`);
      }
      const shape = (b) => Object.keys(b ?? {}).sort();
      assert.deepEqual(shape(answers.REST), shape(answers.MCP), 'REST and MCP answer a resolve in different shapes');
    });

    it('the refusals are the same sentence on every door: an id that is no fork, an unknown id, a bad `keep`', async () => {
      const cases = [
        ['a record that is no fork', 'plain', 'parent'],
        ['an id that is not stored', 'no-such-record', 'fork'],
        ['a keep that is neither side', ids.f1, 'both'],
      ];
      for (const [what, forkId, keep] of cases) {
        const got = {};
        for (const name of Object.keys(doors.resolve)) {
          const r = await doors.resolve[name](forkId, keep);
          assert.equal(r.ok, false, `${name}: resolving ${what} was accepted`);
          assert.ok(typeof r.sentence === 'string' && r.sentence.length > 0, `${name}: the refusal of ${what} carries no sentence`);
          got[name] = r.sentence;
        }
        assert.equal(got.REST, got.MCP, `${what}: REST says "${got.REST}", MCP says "${got.MCP}"`);
        assert.equal(got.TOOLDOOR, got.MCP, `${what}: the tool door says "${got.TOOLDOOR}", MCP says "${got.MCP}"`);
        assert.equal(await door.coll(S, 'facts').countDocuments({ _id: 'plain' }), 1, 'a refused resolve deleted a record');
        assert.equal(await door.coll(S, 'facts').countDocuments({ _id: ids.f1 }), 1, 'a refused resolve deleted the fork');
      }
    });

    it('a token that may only read lists the forks and may not resolve one, on both tool doors', async () => {
      assert.ok((await mcp('list_forks', { space: S }, readerRights)).ok, 'a reader is refused the list');
      assert.ok((await toolDoor('list_forks', { space: S }, readerRights)).ok, 'a reader is refused the list on the tool door');
      for (const [name, call] of [['MCP', mcp], ['TOOLDOOR', toolDoor]]) {
        const r = await call('resolve_fork', { space: S, forkId: ids.f1, keep: 'parent' }, readerRights);
        assert.equal(r.ok, false, `${name}: a read-only token resolved a fork`);
      }
      assert.equal(await door.coll(S, 'facts').countDocuments({ _id: ids.f1 }), 1, 'a refused resolve deleted the fork');
    });
  });

  /**
   * Q-624 (design §9, §10, test 10): one capability, EVERY kind, both doors, the same refusals. Driven through `reviewDoors`
   * (`_fork-kinds.mjs`), which states the five parameters from the store; `over` replaces any of them.
   *
   * Not driven, and why: "a fork tombstone with the fork re-delivered at another seq in between" is a race INSIDE the resolve's transaction, and
   * the design names no seam to hold it open: the stale `ifMatchSeq` case below is its outside view. The REST door's audit entry is written by the
   * audit middleware, which a direct handler call does not run, so the audit read-back is held on MCP only.
   */
  describe('every kind, both doors (Q-624)', () => {
    let rd; let fx; let forkMods;
    before(async () => {
      fx = await import('./_fork-kinds.mjs');
      await fx.initForkFixtures();
      rd = await fx.reviewDoors(door, S);
      forkMods = await import('../../server/dist/brain/forks.js');
    });
    beforeEach(async () => { await door.wipe(S); });
    const KINDS = ['fact', 'entity', 'chrono', 'edge'];
    const subjectOf = async (kind, extra = {}) => {
      const k = fx.FORK_KINDS[kind];
      const id = `p-${kind}`;
      await door.coll(S, k.family).insertOne(k.row(S, id, 5, { pos: 5, posAtSeq: 5, ...extra }));
      return id;
    };
    const both = async (call) => { const out = {}; for (const n of ['REST', 'MCP']) out[n] = await call(n); return out; };

    for (const kind of KINDS) {
      it(`${kind}: each of the five resolve parameters missing is a 400 with one sentence on both doors, and nothing is written`, async () => {
        const k = fx.FORK_KINDS[kind];
        const parent = await subjectOf(kind);
        const fork = await fx.seedFork(door, S, kind, parent, 5, k.alt);
        for (const missing of ['kind', 'forkId', 'keep', 'ifMatchSeq', 'ifMatchParentSeq']) {
          const answers = await both((n) => (missing === 'forkId'
            ? (n === 'REST' ? rd.rest('post', '/spaces/:spaceId/forks/:forkId/resolve', { params: { spaceId: S, forkId: ' ' }, body: { kind, keep: 'parent', ifMatchSeq: fork.seq, ifMatchParentSeq: 5 } }) : rd.mcp('resolve_fork', { space: S, kind, keep: 'parent', ifMatchSeq: fork.seq, ifMatchParentSeq: 5 }))
            : rd.resolve[n](kind, fork._id, 'parent', { [missing]: undefined })));
          for (const [n, r] of Object.entries(answers)) assert.equal(r.ok, false, `${kind}/${missing}: ${n} accepted a resolve without it`);
          assert.equal(answers.REST.status, 400, `${kind}/${missing}: REST answered ${answers.REST.status}`);
          assert.equal(answers.REST.sentence, answers.MCP.sentence, `${kind}/${missing}: REST says "${answers.REST.sentence}", MCP says "${answers.MCP.sentence}"`);
        }
        assert.equal(await door.coll(S, k.family).countDocuments({ _id: fork._id }), 1, 'a refused resolve deleted the fork');
      });

      it(`${kind}: a stale ifMatchSeq or ifMatchParentSeq is a 409 and nothing is written`, async () => {
        const k = fx.FORK_KINDS[kind];
        const parent = await subjectOf(kind);
        const fork = await fx.seedFork(door, S, kind, parent, 5, k.alt);
        for (const over of [{ ifMatchSeq: fork.seq + 1 }, { ifMatchParentSeq: 4 }]) {
          for (const n of ['REST', 'MCP']) {
            const r = await rd.resolve[n](kind, fork._id, 'fork', over);
            assert.equal(r.ok, false, `${kind}: ${n} resolved against a stale ${Object.keys(over)[0]}`);
            assert.equal(r.status, 409, `${kind}: ${n} answered ${r.status}`);
          }
        }
        assert.equal((await door.coll(S, k.family).findOne({ _id: parent })).seq, 5, 'a refused resolve rewrote the parent');
      });

      it(`${kind}: a planted fork whose id does not derive from its body is a 409 on both doors`, async () => {
        const k = fx.FORK_KINDS[kind];
        const parent = await subjectOf(kind);
        const planted = { ...k.row(S, `planted-${kind}`, 5, { pos: 5, posAtSeq: 5, ...k.alt }), forkOf: parent };
        await door.coll(S, k.family).insertOne(planted).catch((err) => { throw new Error(`a fork edge cannot be stored beside its subject (the identity index is not partial): ${err.message}`); });
        const answers = await both((n) => rd.resolve[n](kind, planted._id, 'fork'));
        for (const [n, r] of Object.entries(answers)) { assert.equal(r.status, 409, `${kind}: ${n} answered ${r.status}`); assert.equal(r.ok, false); }
        assert.equal(answers.REST.sentence, answers.MCP.sentence, 'the two doors word the refusal differently');
        assert.equal((await door.coll(S, k.family).findOne({ _id: parent })).seq, 5, 'a planted fork directed a write at its parent');
      });

      it(`${kind}: an orphan is listed, and both orphan resolves work (the edge keep leaves no forkOf)`, async () => {
        const k = fx.FORK_KINDS[kind];
        const orphan = await fx.seedFork(door, S, kind, `gone-${kind}`, 5, k.alt);
        const listed = fx.rowsOf((await rd.list.MCP({ kind })).body).find(r => fx.forkIdOfRow(r) === orphan._id);
        assert.ok(listed, `${kind}: an orphaned fork is not listed`);
        assert.equal(listed.orphaned, true, 'the row does not say it is orphaned');
        assert.equal(listed.parent ?? null, null, 'an orphan names a parent');
        const keepFork = await rd.resolve.REST(kind, orphan._id, 'fork', { ifMatchParentSeq: 0 });
        assert.ok(keepFork.ok, `${kind}: keeping an orphan was refused: ${keepFork.sentence}`);
        const stored = await door.coll(S, k.family).findOne({ _id: orphan._id }) ?? await door.coll(S, k.family).findOne({ [k.main]: k.alt[k.main] });
        assert.ok(stored, `${kind}: keeping an orphan lost its body`);
        assert.equal(stored.forkOf, undefined, `${kind}: the kept orphan still says it is a fork`);
      });
    }

    it('an entity resolve re-points its edges, fork edges and links; a chrono resolve re-points edges and links', async () => {
      for (const kind of ['entity', 'chrono']) {
        await door.wipe(S);
        const k = fx.FORK_KINDS[kind];
        const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
        const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
        const parent = await subjectOf(kind);
        const fork = await fx.seedFork(door, S, kind, parent, 5, k.alt);
        await door.coll(S, 'entities').insertOne(build.entity(S, 'other', 3));
        await door.coll(S, 'edges').insertOne(build.edge(S, edgeIdFor(fork._id, 'other', 'about', kind, 'entity'), 6, { from: fork._id, fromKind: kind, to: 'other', toKind: 'entity', label: 'about' }));
        await door.coll(S, 'links').insertOne(build.link(S, linkIdFor(fork._id, kind, 'other', 'entity'), 6, { from: fork._id, fromKind: kind, to: 'other', toKind: 'entity' }));
        const r = await rd.resolve.MCP(kind, fork._id, 'parent');
        assert.ok(r.ok, `${kind}: ${r.sentence}`);
        assert.equal(await door.coll(S, 'edges').countDocuments({ $or: [{ from: fork._id }, { to: fork._id }] }), 0, `${kind}: an edge still points at the fork`);
        assert.equal(await door.coll(S, 'links').countDocuments({ $or: [{ from: fork._id }, { to: fork._id }] }), 0, `${kind}: a link still points at the fork`);
        assert.equal(await door.coll(S, 'edges').countDocuments({ from: parent, to: 'other' }), 1, `${kind}: the edge was not re-pointed to the parent`);
        assert.equal(await door.coll(S, 'links').countDocuments({ from: parent, to: 'other' }), 1, `${kind}: the link was not re-pointed to the parent`);
      }
    });

    it('siblings with one body go together', async () => {
      const k = fx.FORK_KINDS.fact;
      const parent = await subjectOf('fact');
      const one = await fx.seedFork(door, S, 'fact', parent, 5, k.alt);
      // The same body under a second id: the pre-6.0 text-derived id a legacy fact fork carries.
      const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
      const legacy = { ...one, _id: forkIdFor(parent, 5, one.fact) };
      await door.coll(S, 'facts').insertOne(legacy);
      const r = await rd.resolve.MCP('fact', one._id, 'parent');
      assert.ok(r.ok, r.sentence);
      assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: parent }), 0, 'a sibling holding the resolved body is still listed');
    });

    it('the audit entry records kind, keep, parent, fork and both bodies, read back from the audit log', async () => {
      const k = fx.FORK_KINDS.entity;
      const parent = await subjectOf('entity');
      const fork = await fx.seedFork(door, S, 'entity', parent, 5, k.alt);
      const before = await door.mongo.col('audit_log').countDocuments({});
      const r = await rd.resolve.MCP('entity', fork._id, 'parent');
      assert.ok(r.ok, r.sentence);
      // The audit row is written after the call answers (`logAuditEntry` is not awaited by the door), so it is read until it lands, for at most 2 s.
      let entry;
      for (let i = 0; i < 40 && !entry; i++) {
        const rows = (await door.mongo.col('audit_log').find({}).toArray()).slice(before);
        entry = rows.find(x => JSON.stringify(x).includes('fork.resolve'));
        if (!entry) await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(entry, 'no fork.resolve row in the audit log');
      const text = JSON.stringify(entry);
      for (const part of [fork._id, parent, 'entity', 'parent', k.alt.name, `Entity ${parent}`]) assert.ok(text.includes(part), `the audit row does not carry ${part}: ${text.slice(0, 400)}`);
    });

    it('the list returns resolvedElsewhere with `kept` derived the same on both doors', async () => {
      const k = fx.FORK_KINDS.fact;
      const parent = await subjectOf('fact', { author: { instanceId: 'peer-a', instanceLabel: 'A' } });
      const fork = await fx.seedFork(door, S, 'fact', parent, 5, k.alt);
      await door.coll(S, 'facts').updateOne({ _id: fork._id }, { $set: { _resolvedElsewhere: [{ by: 'peer-a', at: '2026-10-25T00:00:00.000Z', seq: 9, proven: true }] } });
      // Peer A's version of the parent has landed: above the fork's seq, and saying what the parent said (A kept the original).
      await door.coll(S, 'facts').updateOne({ _id: parent }, { $set: { seq: 9 } });
      const answers = await both((n) => rd.list[n]({ kind: 'fact' }));
      for (const [n, r] of Object.entries(answers)) {
        const row = fx.rowsOf(r.body).find(x => fx.forkIdOfRow(x) === fork._id);
        assert.ok(row, `${n}: the marked fork is not listed`);
        assert.deepEqual(row.resolvedElsewhere?.map(m => [m.by, m.proven, m.kept]), [['peer-a', true, 'original']], `${n}: ${JSON.stringify(row.resolvedElsewhere)}`);
      }
      assert.equal(typeof forkMods.parseResolveParams, 'function', 'brain/forks.js exports no parseResolveParams (the one builder of the 400 sentence, design §9)');
    });
  });

  describe('rights (place 5)', () => {
    let rights;
    before(async () => { rights = await import('../../server/dist/auth/space-rights.js'); });

    it('the route rows: list needs knowledge read, resolve needs knowledge write', () => {
      const row = (route, method) => rights.ROUTE_RIGHTS.find(r => r.route === route && r.method === method);
      const list = row('/api/brain/spaces/:spaceId/forks', 'GET');
      const resolve = row('/api/brain/spaces/:spaceId/forks/:forkId/resolve', 'POST');
      assert.ok(list, 'ROUTE_RIGHTS has no row for GET /api/brain/spaces/:spaceId/forks');
      assert.ok(resolve, 'ROUTE_RIGHTS has no row for POST .../forks/:forkId/resolve');
      assert.deepEqual([list.area, list.needs, resolve.area, resolve.needs], ['knowledge', 'read', 'knowledge', 'write']);
    });

    it('the tool rows: list_forks needs knowledge read, resolve_fork needs knowledge write', () => {
      const row = (tool) => rights.TOOL_RIGHTS.find(r => r.tool === tool);
      assert.ok(row('list_forks') && row('resolve_fork'), 'TOOL_RIGHTS has no row for list_forks and resolve_fork');
      assert.deepEqual([row('list_forks').area, row('list_forks').needs, row('resolve_fork').area, row('resolve_fork').needs], ['knowledge', 'read', 'knowledge', 'write']);
    });
  });
});
