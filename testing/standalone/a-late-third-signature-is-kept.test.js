/**
 * A proposer's `csig` that reaches a member AFTER the same cast arrived without it is kept, and a relayer can never take one away
 * (`Q-745`, bundle-284 design r5 section 2.4).
 *
 * ## What it prevents
 *
 * A member applies a round's conversion steps only when the proposer's cast carries a `csig` that verifies over them. A cast can first reach a
 * member through a relayer of an older release, which drops what it does not know, so it arrives with `sig` and `bsig` and no `csig`. The
 * served-rounds merge replaced a stored cast only when the vote or one of the two older signatures differed, so the same cast arriving later
 * WITH its `csig` changed nothing: the member kept the stripped copy, read the steps as unsigned and refused them for ever. The opposite must
 * hold just as firmly: a stripped copy arriving after the full one must not replace it.
 *
 * ## What holds (through `takeServedRounds`, the one merge of a served vote list)
 *
 * - a cast stored without `csig`, then served with a `csig` that verifies: the stored cast gains it;
 * - a cast stored with its `csig`, then served without it: the stored cast keeps it;
 * - a cast served with a `csig` that does not verify never replaces one that does;
 * - a different vote still replaces the stored cast.
 *
 * Run: node --test testing/standalone/a-late-third-signature-is-kept.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, bootInstance, removeInstanceDir } from './_vote-round-instance.mjs';
import { SELF, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-late-csig-');
const NET = '55555555-5555-4555-8555-555555555555';
const STEPS = { steps: [{ op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' }] };

let signing, served;

before(async () => {
  await bootInstance(dir, { instanceId: SELF, spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }] });
  signing = await import('../../server/dist/util/signing.js');
  served = await import('../../server/dist/sync/served-rounds.js');
  assert.ok(signing.ensureInstanceKeypair(), 'the booted instance has no signing keypair');
});
after(() => { removeInstanceDir(dir); });

const relayer = { instanceId: P1, label: 'relayer', url: 'https://relayer.example', tokenHash: 'h', direction: 'both' };

/** This instance's own open schema round carrying steps (it is the proposer, so its key is the one a `csig` is checked against). */
function roundOf() {
  const now = Date.now();
  return {
    roundId: `round-csig-${now}-${Math.random()}`, type: 'meta_change', subjectInstanceId: SELF, subjectLabel: 'self', subjectUrl: '',
    openedAt: new Date(now).toISOString(), deadline: new Date(now + 86_400_000).toISOString(), votes: [],
    spaceId: 'people', changedTypes: ['entity:Person'], metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
    pendingMeta: { typeSchemas: { entity: { Person: { propertySchemas: { name: { type: 'string' } } } } } },
    convertRecords: STEPS,
  };
}

/** A network holding `local` as its stored round, `stored` its one cast. */
function netWith(local, stored) {
  return {
    id: NET, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['people'], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [relayer], roundOutcomes: [],
    pendingRounds: [{ ...local, votes: stored ? [stored] : [] }],
  };
}

const withoutCsig = ({ csig: _gone, ...rest }) => rest;
/** Serve `round` with `cast` as its one vote, through the merge, as reported by the relayer. */
function serve(net, round, cast) {
  return served.takeServedRounds(net, [{ ...round, votes: [cast] }], relayer, Date.now());
}

describe('a late third signature is kept', () => {
  it('a cast stored without csig, then served with one that verifies, gains it', () => {
    const round = roundOf();
    const full = signing.makeSignedOwnCast(NET, round, SELF, 'yes');
    assert.ok(full.csig, 'precondition: the proposer\'s cast carries a csig');
    const net = netWith(round, withoutCsig(full));
    assert.equal(signing.convertRecordsSignedByProposer(net, net.pendingRounds[0]), false, 'precondition: the stripped copy reads as unsigned');

    const out = serve(net, round, full);
    const kept = net.pendingRounds[0].votes.find(v => v.instanceId === SELF);
    assert.equal(kept.csig, full.csig, 'the cast that arrived with its csig did not replace the stripped copy');
    assert.equal(out.changed, true);
    assert.equal(signing.convertRecordsSignedByProposer(net, net.pendingRounds[0]), true, 'the steps still read as unsigned');
  });

  it('a cast stored with its csig, then served without it, keeps it', () => {
    const round = roundOf();
    const full = signing.makeSignedOwnCast(NET, round, SELF, 'yes');
    const net = netWith(round, full);
    serve(net, round, withoutCsig(full));
    const kept = net.pendingRounds[0].votes.find(v => v.instanceId === SELF);
    assert.equal(kept.csig, full.csig, 'a relayer took the csig away');
    assert.equal(signing.convertRecordsSignedByProposer(net, net.pendingRounds[0]), true);
  });

  it('a csig that does not verify never replaces one that does', () => {
    const round = roundOf();
    const full = signing.makeSignedOwnCast(NET, round, SELF, 'yes');
    const net = netWith(round, full);
    const forged = { ...full, csig: Buffer.from('not a signature over these steps').toString('base64') };
    serve(net, round, forged);
    assert.equal(net.pendingRounds[0].votes.find(v => v.instanceId === SELF).csig, full.csig, 'a forged csig replaced the proposer\'s');
  });

  it('a different vote still replaces the stored cast', () => {
    const round = roundOf();
    const yes = signing.makeSignedOwnCast(NET, round, SELF, 'yes');
    const net = netWith(round, yes);
    const veto = withoutCsig(signing.makeSignedOwnCast(NET, round, SELF, 'veto'));
    const out = serve(net, round, veto);
    const kept = net.pendingRounds[0].votes.find(v => v.instanceId === SELF);
    assert.equal(kept.vote, 'veto', 'a changed vote did not replace the stored cast');
    assert.equal(out.changed, true);
  });
});
