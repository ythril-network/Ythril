/**
 * A vote round nobody touches still ends at its deadline: the expiry job concludes it, records how, and prunes it.
 *
 * ## What was true before
 *
 * A round past its deadline stayed `concluded: false` until a cast, a peer relay or a gossip pass happened to touch it.
 * Until then the operator list and the space chip showed it as open, a cast on it was taken, and on a quiet network it
 * stayed for ever. Nothing recorded how a round ended once the prune removed it.
 *
 * ## What the job does (`networks/round-expiry.ts`, `runRoundExpiryTick(now)`)
 *
 * Its tick is SYNCHRONOUS — no await between reading the config and saving it, so a reload cannot land in between and
 * be overwritten by a stale snapshot — and walks the networks through `eachNetwork` and, inside each, the rounds as
 * units, so one poison round never stops the rest. Each round past its deadline is concluded through
 * `concludeRoundIfReady` (never by setting fields), what concluded is applied through `applyRoundConclusion`, then
 * whatever is prunable is pruned (recording it first), and the config is saved once if anything changed. A failure is said
 * once per network per window and counted in `ythril_round_expiry_failures_total`.
 *
 * What an EXPIRED round does, by round type and network type: nothing — except a failed JOIN, whose provisioned
 * credentials are revoked once nothing else references the instance (as a vetoed or expired join always did).
 *
 * Run: node --test testing/standalone/a-round-past-its-deadline-is-concluded-by-the-job.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempInstanceDir, removeInstanceDir, bootInstance, settled, counterTotal, counterDeclared } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const JOINER = 'aaaaaaaa-0000-4000-8000-0000000000b1';

const dir = tempInstanceDir('ythril-round-expiry-');
const CONFIG = process.env['CONFIG_PATH'];
after(() => removeInstanceDir(dir));

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const PAST = iso(NOW - 60_000);
const FUTURE = iso(NOW + 3_600_000);
const NET_TYPES = ['closed', 'democratic', 'club', 'braintree', 'pubsub'];
const ROUND_TYPES = ['join', 'remove', 'space_deletion', 'space_wipe', 'meta_change', 'space_addition'];
const SPACES = [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [] }];

const member = (instanceId, extra = {}) => ({ instanceId, label: instanceId.slice(-2), url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });
const round = (type, over = {}) => ({
  roundId: `r-${type}`, type, subjectInstanceId: type === 'join' ? JOINER : P1, subjectLabel: 'Subject', subjectUrl: 'https://subject.example',
  openedAt: iso(NOW - 7_200_000), deadline: PAST, votes: [], concluded: false,
  ...(type === 'join' ? { pendingMember: member(JOINER) } : {}),
  ...(type.startsWith('space_') || type === 'meta_change' ? { spaceId: type === 'space_addition' ? 'fresh' : 'notes' } : {}),
  ...(type === 'meta_change' ? { pendingMeta: { purpose: 'a new purpose' }, metaChangedFields: ['purpose'], baseMetaVersion: 0 } : {}),
  ...over,
});
const network = (type, rounds, over = {}) => ({
  id: `net-${type}`, label: `Net ${type}`, type, origin: 'created', syncSchedule: '', spaces: ['general', 'notes'],
  members: [member(P1), member(P2, type === 'braintree' ? { parentInstanceId: P1 } : {})], votingDeadlineHours: 24,
  ...(type === 'braintree' ? { myParentInstanceId: P1 } : {}), createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: rounds, ...over,
});

const tick = async (now = NOW) => (await import('../../server/dist/networks/round-expiry.js')).runRoundExpiryTick(now);
const cfg = (loader) => loader.getConfig();
const ids = (rs) => (rs ?? []).map(r => r.roundId);

describe('the job concludes an expired round of every type on every network type, and does nothing else to it', () => {
  for (const type of NET_TYPES) {
    describe(`on a ${type} network`, () => {
      let loader, net;
      before(async () => {
        loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network(type, ROUND_TYPES.map(t => round(t)))] });
        await tick();
        await settled(() => cfg(loader).networks);
        net = cfg(loader).networks[0];
      });

      for (const roundType of ROUND_TYPES) {
        it(`${roundType}: concluded as expired, recorded, pruned, and acted on by nobody`, () => {
          assert.ok(!ids(net.pendingRounds).includes(`r-${roundType}`), `${roundType} is still held after its deadline passed`);
          const entry = (net.roundOutcomes ?? []).find(e => e.roundId === `r-${roundType}`);
          assert.ok(entry, `no outcome was recorded for the expired ${roundType} round`);
          assert.equal(entry.outcome, 'expired');
          assert.equal(entry.type, roundType);
          assert.equal(entry.concludedAt, iso(NOW), 'concludedAt is the tick\'s `now`');
          assert.deepEqual([entry.yes, entry.veto], [0, 0]);
          assert.ok(Number.isInteger(entry.eligible) && entry.eligible >= 1, `eligible is ${entry.eligible}`);
        });
      }

      it('changed nothing the rounds were about: members, spaces, layers, pending spaces', () => {
        assert.deepEqual(net.members.map(m => m.instanceId), [P1, P2], 'an expired round changed the roster');
        assert.deepEqual(net.spaces, ['general', 'notes']);
        assert.equal(Object.keys(net.schemaLayers ?? {}).length, 0, 'an expired meta_change landed in the network layer');
        assert.equal((net.pendingSpaces ?? []).length, 0, 'an expired space_addition was held as pending');
        assert.equal((net.introductions ?? []).length, 0);
      });
    });
  }
});

describe('what the job leaves alone, and what it only records', () => {
  it('an open round within its deadline, and a concluded one still within it, are untouched', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [
      round('remove', { roundId: 'open-future', deadline: FUTURE }),
      round('remove', { roundId: 'concluded-future', deadline: FUTURE, concluded: true, passed: false }),
    ])] });
    await tick();
    const net = cfg(loader).networks[0];
    assert.deepEqual(ids(net.pendingRounds), ['open-future', 'concluded-future']);
    assert.equal(net.pendingRounds[0].concluded, false);
    assert.equal((net.roundOutcomes ?? []).length, 0);
  });

  it('at the deadline instant the round is open; one millisecond later it is expired', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [round('remove', { roundId: 'edge', deadline: iso(NOW) })])] });
    await tick(NOW);
    assert.deepEqual(ids(cfg(loader).networks[0].pendingRounds), ['edge'], 'a round closed AT its deadline instant');
    assert.notEqual(cfg(loader).networks[0].pendingRounds[0].concluded, true);
    await tick(NOW + 1);
    assert.deepEqual(ids(cfg(loader).networks[0].pendingRounds), []);
    assert.equal(cfg(loader).networks[0].roundOutcomes[0].outcome, 'expired');
  });

  it('a round that was concluded before this version and has lapsed is pruned and recorded as ended', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [
      round('remove', { roundId: 'legacy', concluded: true, passed: false, deadline: PAST }),
    ])] });
    await tick();
    const net = cfg(loader).networks[0];
    assert.deepEqual(ids(net.pendingRounds), []);
    assert.deepEqual(net.roundOutcomes.map(e => [e.roundId, e.outcome]), [['legacy', 'ended']]);
  });

  it('a round with a veto on it that nobody evaluated ends vetoed, not expired', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('democratic', [
      round('space_deletion', { roundId: 'vetoed', votes: [{ instanceId: P1, vote: 'veto', castAt: iso(NOW + 86_400_000) }] }),
    ])] });
    await tick();
    const e = cfg(loader).networks[0].roundOutcomes[0];
    assert.equal(e.outcome, 'vetoed');
    assert.deepEqual([e.yes, e.veto], [0, 1]);
  });

  it('a round whose deadline cannot be read is concluded, not left open for ever', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [
      round('remove', { roundId: 'undatable', deadline: 'whenever' }),
      round('remove', { roundId: 'blank', deadline: '' }),
    ])] });
    await tick();
    const net = cfg(loader).networks[0];
    assert.deepEqual(ids(net.pendingRounds), []);
    assert.deepEqual(net.roundOutcomes.map(e => e.outcome).sort(), ['expired', 'expired']);
  });

  it('an idle tick writes nothing: the config file is byte for byte what it was', async () => {
    await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [round('remove', { roundId: 'open-future', deadline: FUTURE })])] });
    const before = fs.readFileSync(CONFIG);
    const mtime = fs.statSync(CONFIG).mtimeMs;
    await tick();
    assert.ok(before.equals(fs.readFileSync(CONFIG)) && fs.statSync(CONFIG).mtimeMs === mtime, 'a tick with nothing to do rewrote config.json');
  });
});

describe('a failed join loses its provisioned credentials, and only a failed join does', () => {
  it('the outbound token held for an expired joiner is dropped once nothing else references it', async () => {
    const loader = await bootInstance(dir, {
      instanceId: SELF, spaces: SPACES, peerTokens: { [JOINER]: 'outbound-token', [P1]: 'member-token' },
      networks: [network('closed', [round('join', { roundId: 'r-join' }), round('remove', { roundId: 'r-remove' })])],
    });
    await tick();
    await settled(() => loader.getSecrets().peerTokens);
    const tokens = loader.getSecrets().peerTokens;
    assert.equal(tokens[JOINER], undefined, 'the credential of a join that expired is still held');
    assert.equal(tokens[P1], 'member-token', 'a member\'s credential was revoked by an expired round about someone else');
  });
});

describe('the tick is synchronous and reads the config as it is NOW', () => {
  it('its effect is on disk before the first await — it returns no promise', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [round('remove', { roundId: 'sync-one' })])] });
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const result = runRoundExpiryTick(NOW);
    assert.ok(!(result && typeof result.then === 'function'), 'the tick returned a promise: an await inside it opens the window a reload lands in');
    const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).networks[0];
    assert.deepEqual(ids(onDisk.pendingRounds), [], 'the conclusion was not on disk when the tick returned');
    assert.deepEqual((onDisk.roundOutcomes ?? []).map(e => e.roundId), ['sync-one']);
    assert.ok(loader.getConfig());
  });

  it('a config reloaded from disk between two ticks is the one the second tick works on (no stale snapshot is saved back)', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [round('remove', { roundId: 'first' })])] });
    const held = loader.getConfig();
    await tick();
    assert.deepEqual(held.networks[0].roundOutcomes.map(e => e.roundId), ['first']);
    // An operator edits config.json by hand and the watcher reloads it: a second expired round appears.
    const edited = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    edited.networks[0].pendingRounds.push(round('remove', { roundId: 'second' }));
    edited.instanceLabel = 'edited by hand';
    fs.writeFileSync(CONFIG, JSON.stringify(edited), { mode: 0o600 });
    loader.reloadConfig();
    await tick();
    const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    assert.deepEqual(onDisk.networks[0].roundOutcomes.map(e => e.roundId).sort(), ['first', 'second']);
    assert.equal(onDisk.instanceLabel, 'edited by hand', 'the tick saved a snapshot that predates the reload');
    assert.deepEqual(ids(onDisk.networks[0].pendingRounds), []);
  });
});

describe('one bad round or one bad network never stops the rest, and the failure is counted', () => {
  const FAILURES = 'ythril_round_expiry_failures_total';

  it('the counter is declared before anything has failed', async () => {
    await import('../../server/dist/networks/round-expiry.js');
    assert.ok(await counterDeclared(FAILURES), `${FAILURES} is not in the registry — a first failure would be the first time it existed`);
  });

  it('a round whose casts are not a list is counted, and the healthy round beside it still concludes', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [
      round('remove', { roundId: 'poison', votes: 'not-an-array' }),
      round('remove', { roundId: 'healthy' }),
    ])] });
    const before = await counterTotal(FAILURES);
    await tick();
    const net = cfg(loader).networks[0];
    assert.ok(net.roundOutcomes?.some(e => e.roundId === 'healthy' && e.outcome === 'expired'), 'one poison round stopped the rest of the network');
    assert.ok(!ids(net.pendingRounds).includes('healthy'));
    assert.ok(await counterTotal(FAILURES) > before, 'the poison round failed and nothing counted it');
  });

  it('a network whose members are not a list is counted, and the next network is still done', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [
      network('closed', [round('remove', { roundId: 'in-broken' })], { id: 'broken', members: null }),
      network('club', [round('remove', { roundId: 'in-good' })], { id: 'good' }),
    ] });
    const before = await counterTotal(FAILURES);
    await tick();
    const good = cfg(loader).networks.find(n => n.id === 'good');
    assert.ok(good.roundOutcomes?.some(e => e.roundId === 'in-good'), 'a broken network stopped the walk');
    assert.ok(await counterTotal(FAILURES) > before);
  });

  it('a config with no pendingRounds or no roundOutcomes key is walked without a throw', async () => {
    const bare = network('closed', [], { id: 'bare' }); delete bare.pendingRounds;
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [bare, network('club', [round('remove', { roundId: 'next' })], { id: 'next-net' })] });
    const before = await counterTotal(FAILURES);
    await assert.doesNotReject(async () => { await tick(); });
    assert.ok(cfg(loader).networks.find(n => n.id === 'next-net').roundOutcomes?.some(e => e.roundId === 'next'));
    assert.equal(await counterTotal(FAILURES), before, 'a network that simply has no rounds was reported as a failure');
  });

  it('a save that fails is counted, and does not make the tick throw out of the job', async () => {
    const loader = await bootInstance(dir, { instanceId: SELF, spaces: SPACES, networks: [network('closed', [round('remove', { roundId: 'unsaved' })])] });
    // A directory where the file belongs: the atomic rename onto it fails.
    fs.rmSync(CONFIG);
    fs.mkdirSync(CONFIG);
    fs.writeFileSync(path.join(CONFIG, 'keep'), 'x');
    const before = await counterTotal(FAILURES);
    try { await tick(); } catch { /* the tick may surface it; what must hold is that it was counted */ }
    const counted = await counterTotal(FAILURES);
    fs.rmSync(CONFIG, { recursive: true, force: true });
    fs.writeFileSync(CONFIG, JSON.stringify(loader.getConfig()), { mode: 0o600 });
    assert.ok(counted > before, 'a config save failed during the tick and nothing counted it');
  });
});

describe('eachNetwork: the per-network walk, beside the per-space one', () => {
  const walk = () => import('../../server/dist/util/housekeeping-walk.js');

  it('runs every unit, survives a throwing one, and finishes before it returns', async () => {
    const { eachNetwork } = await walk();
    assert.equal(typeof eachNetwork, 'function', 'util/housekeeping-walk.ts exports no eachNetwork');
    const seen = [];
    const result = eachNetwork('Test network walk', ['a', 'b', 'c'], (unit) => {
      seen.push(unit);
      if (unit === 'b') throw new Error('b is broken');
    });
    assert.ok(!(result && typeof result.then === 'function'), 'the walk is async: it would open the window a config reload lands in');
    assert.deepEqual(seen, ['a', 'b', 'c'], 'a unit after the failing one never ran');
  });

  it('is handed networks and rounds alike: any list of units, named for the failure line', async () => {
    const { eachNetwork } = await walk();
    const seen = [];
    eachNetwork('Test round walk', [{ id: 'x' }, { roundId: 'y' }], (u) => { seen.push(u); });
    assert.equal(seen.length, 2);
  });
});
