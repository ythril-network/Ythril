/**
 * A brain tombstone a peer delivers is validated, authorised and applied PER ELEMENT, to the space the door
 * ADMITTED — on both doors (`Q-236`, `Q-221`, bundle-46 plan rows 1, 2, 3 and 8).
 *
 * ## The rules, each held on the push door (`POST /api/sync/tombstones`) and the pull door (the engine's tombstone
 * transfer from a peer), because one rule with two doors is where the weaker door wins
 *
 *  1. **The admitted space, never the document's.** The door admits a space — by `req.query.spaceId` after the alias
 *     middleware on push, by the space the cycle is syncing on pull — and the tombstone's own `spaceId` names
 *     whatever the sender wrote. Applied by the document's, a peer admitted to one space deletes from another this
 *     instance has, creates collections for one it does not, and under a `spaceMap` an honest peer's deletions land
 *     in the network id's collections and never reach the local space at all.
 *  2. **Each element is checked on its own.** A seq no counter can carry is refused and logged and never moves the
 *     counter; a malformed element is refused ALONE and the rest of the page applies, with `refused` counted on the
 *     wire; an element of an unknown type (a newer peer's) still answers 400, so the sender holds its watermark.
 *  3. **Authorised before it is stored.** A tombstone for a record another author wrote, or one whose issuer is not
 *     the peer delivering it, is refused and NOT stored — stored, it refuses every later copy of that record from its
 *     real author. And an arriving record is refused by a stored tombstone only when that tombstone's issuer
 *     authored it, so a planted tombstone cannot block another author's record.
 *  4. **The answer.** `applied` keeps its meaning for an honest page; `refused` is additive.
 *
 * ## How the doors are driven
 *
 * The push through `_push-door.mjs` (the alias middleware, then the route's own handler), the pull through
 * `_pull-door.mjs` (the real engine against a fake peer serving the real GET handler). Real Mongo throughout.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-peer-tombstone-is-applied-where-it-was-admitted-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tsadm';            // the admitted space, carried by the network
const V = 'tsvictim';         // a space this instance has, outside the network
const GHOST = 'tsghost';      // a space this instance does not have
const MAP_LOCAL = 'tsmaplocal';
const MAP_NET = 'tsmapnet';   // the network's id for MAP_LOCAL

let door, MAX_INGEST_SEQ;

/**
 * The two doors, each as "deliver these tombstones for this (local) space" — the push names the space the way a peer
 * names it (the network id), the pull serves them for that id. `issuer` is the instance each door authenticates.
 */
const DOORS = {
  push: {
    issuer: PEER_TOKEN.peerInstanceId,
    async deliver(local, tombstones) {
      const spaceId = door.remoteOf(local) ?? local;
      return door.push('/tombstones', { tombstones }, { spaceId, ...(spaceId !== local ? { networkId: door.NET } : {}) });
    },
  },
  pull: {
    issuer: PEER,
    async deliver(local, tombstones) {
      await door.seedPeer(door.remoteOf(local), tombstones);
      return door.sync();
    },
  },
};

const tomb = (space, id, seq, issuer, extra = {}) => build.tombstone(space, id, 'fact', seq, { instanceId: issuer, ...extra });
const fact = (space, id, seq, author) => build.fact(space, id, seq, { author: { instanceId: author, instanceLabel: author } });
const stored = (space, part, id) => door.coll(space, part).findOne({ _id: id });

describe('a peer tombstone is applied where it was admitted, element by element', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tsadmit', spaces: [S, MAP_LOCAL], spaceMap: { [MAP_NET]: MAP_LOCAL }, extraSpaces: [V] });
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const s of [GHOST, MAP_NET]) await door.wipe(s);
  });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name}: Q-236, the admitted space`, () => {
      it('a tombstone naming another space this instance has deletes and stores in the admitted space only', async () => {
        await door.coll(S, 'facts').insertOne(fact(S, 'x1', 3, d.issuer));
        await door.coll(V, 'facts').insertOne(fact(V, 'x1', 3, d.issuer));
        await d.deliver(S, [tomb(V, 'x1', 20, d.issuer)]);
        assert.ok(await stored(V, 'facts', 'x1'),
          `a peer admitted to '${S}' deleted a record in '${V}' by naming it in the tombstone's spaceId`);
        assert.equal(await door.coll(V, 'tombstones').countDocuments(), 0, `a tombstone was stored in '${V}'`);
        assert.equal(await stored(S, 'facts', 'x1'), null, `the admitted space '${S}' kept the record the tombstone deletes`);
        assert.equal((await stored(S, 'tombstones', 'x1'))?.spaceId, S,
          'the tombstone is not stored in the admitted space, retagged to it');
      });

      it('a tombstone naming a space this instance does not have creates nothing there', async () => {
        await door.coll(S, 'facts').insertOne(fact(S, 'g1', 3, d.issuer));
        await d.deliver(S, [tomb(GHOST, 'g1', 21, d.issuer)]);
        assert.equal(await door.coll(GHOST, 'tombstones').countDocuments(), 0,
          `a tombstone was stored for '${GHOST}', a space this instance does not have`);
        assert.equal(await stored(S, 'facts', 'g1'), null, 'the admitted space kept the record');
        assert.equal((await stored(S, 'tombstones', 'g1'))?.spaceId, S, 'the tombstone is not stored in the admitted space');
      });

      it('under a spaceMap, an honest tombstone lands in and deletes from the LOCAL space', async () => {
        await door.coll(MAP_LOCAL, 'facts').insertOne(fact(MAP_LOCAL, 'm1', 3, d.issuer));
        await d.deliver(MAP_LOCAL, [tomb(MAP_NET, 'm1', 22, d.issuer)]);
        assert.equal(await stored(MAP_LOCAL, 'facts', 'm1'), null,
          `a deletion the peer sent for '${MAP_NET}' (this instance's '${MAP_LOCAL}') never reached the local space`);
        assert.equal((await stored(MAP_LOCAL, 'tombstones', 'm1'))?.spaceId, MAP_LOCAL, 'the tombstone is not stored locally');
        assert.equal(await door.coll(MAP_NET, 'tombstones').countDocuments(), 0,
          `the tombstone was stored under the network id '${MAP_NET}', where no local read sees it`);
      });
    });

    describe(`${name}: Q-221, each element on its own`, () => {
      it('a seq no counter can carry is refused, logged, and does not move the counter', async () => {
        const poison = MAX_INGEST_SEQ + 5;
        const page = [tomb(S, 'p-ok', 5, d.issuer), tomb(S, 'p-poison', name === 'push' ? poison : 6, d.issuer)];
        if (name === 'pull') {
          door.state.tamper = (body) => ({ ...body, facts: body.facts.map(t => (t._id === 'p-poison' ? { ...t, seq: poison } : t)) });
        }
        const { result, lines } = await door.logsDuring(() => d.deliver(S, page));
        assert.ok(await door.counter(S) < 1000,
          `a tombstone at seq ${poison} moved the counter to ${await door.counter(S)}: every later local write sits in the `
          + 'ceiling reserve, and a tombstone that high refuses every later copy of its record');
        assert.equal(await stored(S, 'tombstones', 'p-poison'), null, 'the implausible tombstone was stored');
        assert.ok(await stored(S, 'tombstones', 'p-ok'), 'the plausible tombstone beside it was not applied');
        assert.ok(lines.some(l => l.includes('p-poison')), `the refusal is not logged by id:\n${lines.join('\n')}`);
        if (name === 'push') assert.equal(result.body?.refused, 1, `the refusal is not counted on the wire: ${JSON.stringify(result.body)}`);
      });

      it('a malformed element is refused alone and the rest of the page applies', async () => {
        const malformed = { _id: 'm-bad', type: 'fact', seq: 8 };   // no spaceId, deletedAt or instanceId
        const page = [tomb(S, 'm-a', 7, d.issuer), tomb(S, 'm-b', 9, d.issuer)];
        let result;
        if (name === 'push') {
          result = await d.deliver(S, [page[0], malformed, page[1]]);
          assert.equal(result.code, 200, `one malformed element refused the whole page: ${JSON.stringify(result.body)}`);
          assert.deepEqual([result.body.applied, result.body.refused], [2, 1], JSON.stringify(result.body));
        } else {
          door.state.tamper = (body) => ({ ...body, facts: [body.facts[0], malformed, ...body.facts.slice(1)] });
          await d.deliver(S, page);
        }
        for (const t of page) assert.ok(await stored(S, 'tombstones', t._id), `${t._id} beside the malformed element was not applied`);
        assert.equal(await stored(S, 'tombstones', 'm-bad'), null, 'the malformed element was stored');
        assert.equal(await door.mongo.col('undefined_tombstones').countDocuments(), 0,
          'the malformed element was stored under a space named by its missing spaceId');
      });
    });

    describe(`${name}: authorised before it is stored`, () => {
      it('a tombstone for another author\'s record is refused and NOT stored', async () => {
        await door.coll(S, 'facts').insertOne(fact(S, 'o1', 3, 'someone-else'));
        await d.deliver(S, [tomb(S, 'o1', 30, d.issuer)]);
        assert.ok(await stored(S, 'facts', 'o1'), 'a peer deleted a record another author wrote');
        assert.equal(await stored(S, 'tombstones', 'o1'), null,
          'the refused tombstone was stored anyway, so it refuses every later copy of the record from its real author');
      });

      it('a tombstone whose issuer is not the delivering peer is refused and NOT stored', async () => {
        await door.coll(S, 'facts').insertOne(fact(S, 'v1', 3, 'victim-instance'));
        await d.deliver(S, [tomb(S, 'v1', 31, 'victim-instance')]);
        assert.ok(await stored(S, 'facts', 'v1'), 'a forged issuer deleted the victim\'s record');
        assert.equal(await stored(S, 'tombstones', 'v1'), null, 'the forged tombstone was stored');
      });

      it('a tombstone whose target is absent is stored (the control)', async () => {
        await d.deliver(S, [tomb(S, 'absent', 32, d.issuer)]);
        assert.ok(await stored(S, 'tombstones', 'absent'), 'a tombstone for a record not held here was not stored');
      });
    });
  }

  describe('the accept rule for an arriving record honours authorship', () => {
    it('a stored tombstone from a DIFFERENT issuer does not refuse the record', async () => {
      await door.coll(S, 'tombstones').insertOne(tomb(S, 'r1', 50, 'third-party'));
      const res = await door.push('/batch-upsert', { facts: [build.fact(S, 'r1', 10)] }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(res.body.facts.inserted, 1,
        `a tombstone issued by 'third-party' refused a record '${PEER_TOKEN.peerInstanceId}' authored: ${JSON.stringify(res.body.facts)}`);
    });

    it('a stored tombstone from the record\'s own author still refuses it (the control)', async () => {
      await door.coll(S, 'tombstones').insertOne(tomb(S, 'r2', 50, PEER_TOKEN.peerInstanceId));
      const res = await door.push('/batch-upsert', { facts: [build.fact(S, 'r2', 10)] }, { spaceId: S });
      assert.equal(res.body.facts.tombstoned, 1, JSON.stringify(res.body.facts));
    });

    /*
     * WHO IS PROVEN THE AUTHOR (5.6.3, plan S1 / T3). The exemption above holds only when the PUSHER is proven to be
     * the record's author: the authenticated peer id of the token, never the document's own `author` field, which any
     * sender can write. An admin token proves no instance, and a peer pushing a record another instance wrote is not
     * its author — both still meet a stored tombstone of a third issuer, or a relay could resurrect any deleted record
     * by naming its author. The first three rows are controls that hold before the change and must keep holding; the
     * single-route row is the rule, red until `pushVerdict` takes the proven pusher on every door.
     */
    const ADMIN_TOKEN = Object.freeze({ rights: { instanceAdmin: true, perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } });
    const authoredBy = (id, a) => build.fact(S, id, 10, { author: { instanceId: a, instanceLabel: a } });

    it('control: an admin token pushing a record another instance authored still meets a third issuer\'s tombstone', async () => {
      await door.coll(S, 'tombstones').insertOne(tomb(S, 'adm1', 50, 'third-party'));
      const res = await door.push('/batch-upsert', { facts: [authoredBy('adm1', 'author-x')] }, { spaceId: S, token: ADMIN_TOKEN });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(res.body.facts.tombstoned, 1,
        `an admin token, which proves no instance, landed a record over a third issuer's tombstone: ${JSON.stringify(res.body.facts)}`);
      assert.equal(await stored(S, 'facts', 'adm1'), null, 'the tombstoned record was stored');
    });

    it('control: a peer pushing a record another instance authored still meets a third issuer\'s tombstone', async () => {
      await door.coll(S, 'tombstones').insertOne(tomb(S, 'rel1', 50, 'third-party'));
      const res = await door.push('/batch-upsert', { facts: [authoredBy('rel1', 'author-x')] }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(res.body.facts.tombstoned, 1,
        `'${PEER_TOKEN.peerInstanceId}' relayed a record 'author-x' wrote past a third issuer's tombstone: ${JSON.stringify(res.body.facts)}`);
      assert.equal(await stored(S, 'facts', 'rel1'), null, 'the tombstoned record was stored');
    });

    it('control: a stored tombstone with no issuer still refuses a record its proven author pushes', async () => {
      // A tombstone written before `instanceId` was required: unknown issuer, so it keeps governing.
      const { instanceId: _drop, ...noIssuer } = tomb(S, 'old1', 50, 'ignored');
      await door.coll(S, 'tombstones').insertOne(noIssuer);
      const res = await door.push('/batch-upsert', { facts: [build.fact(S, 'old1', 10)] }, { spaceId: S });
      assert.equal(res.body.facts.tombstoned, 1, `a tombstone with no issuer stopped governing: ${JSON.stringify(res.body.facts)}`);
    });

    it('the single route: the proven author lands its record over a third issuer\'s tombstone (POST /facts)', async () => {
      await door.coll(S, 'tombstones').insertOne(tomb(S, 'one1', 50, 'third-party'));
      const res = await door.push('/facts', build.fact(S, 'one1', 10), { spaceId: S });
      assert.ok(res.code < 300, JSON.stringify(res.body));
      assert.equal((await stored(S, 'facts', 'one1'))?.seq, 10,
        `POST /facts refused a record its proven author '${PEER_TOKEN.peerInstanceId}' pushed, over a tombstone 'third-party' `
        + `issued (answered ${JSON.stringify(res.body)}): the single route does not take the proven pusher`);
      assert.ok(await stored(S, 'tombstones', 'one1'), 'the third issuer\'s tombstone was dropped; it governs records it authored');
    });

    /*
     * THE PULL, CHARACTERISED — not a rule. The pull's arrival path (`writeArrivals`) consults no stored tombstone at
     * all: the planner's tombstone check is the push's, and giving the pull one is `Q-204`, outside this bundle (plan
     * decision 3). So both rows pin what the pull does today — a pulled record lands whoever issued the stored
     * tombstone — and they go red if this bundle adds a pull-side tombstone refusal the plan does not make.
     */
    for (const [label, issuer] of [['a DIFFERENT issuer', 'third-party'], ['the record\'s own author', PEER]]) {
      it(`pull, characterised: a stored tombstone from ${label} does not refuse a pulled record (Q-204 is open)`, async () => {
        const id = `pulled-${issuer}`;
        await door.coll(S, 'tombstones').insertOne(tomb(S, id, 50, issuer));
        door.state.records[S] = { facts: [build.fact(S, id, 10, { author: { instanceId: PEER, instanceLabel: PEER } })] };
        await door.sync();
        assert.equal((await stored(S, 'facts', id))?.seq, 10,
          `a pulled record was refused by a stored tombstone issued by '${issuer}' — a pull-side tombstone check arrived, `
          + 'which is Q-204 and not this bundle');
      });
    }
  });

  describe('the push answer', () => {
    it('applied keeps its meaning for an honest page; refused is additive', async () => {
      const res = await door.push('/tombstones', { tombstones: [tomb(S, 'h1', 40, PEER_TOKEN.peerInstanceId),
        tomb(S, 'h2', 41, PEER_TOKEN.peerInstanceId)] }, { spaceId: S });
      assert.deepEqual([res.code, res.body], [200, { applied: 2, refused: 0 }]);
    });

    it('an element of an unknown type answers 400, so the sender holds and re-sends after an upgrade', async () => {
      const res = await door.push('/tombstones', { tombstones: [tomb(S, 'u1', 42, PEER_TOKEN.peerInstanceId),
        { ...tomb(S, 'u2', 43, PEER_TOKEN.peerInstanceId), type: 'a-newer-peers-type' }] }, { spaceId: S });
      assert.equal(res.code, 400, JSON.stringify(res.body));
      assert.equal(await stored(S, 'tombstones', 'u1'), null, 'a page answered 400 applied part of itself');
    });
  });
});
