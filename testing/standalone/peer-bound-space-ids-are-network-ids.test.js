/**
 * Every space id handed to a peer is the NETWORK's id, or travels beside it (`Q-133`).
 *
 * A space may be called one thing here and another by the network — a rename keeps the old id as the network's.
 * A peer can only resolve the network's id, so a site that hands a peer this instance's local name alone hands it a
 * name that means nothing there, or means a different space. That is how a renamed space reached new joiners twice.
 *
 * Three rules, each DERIVED from the source rather than listed:
 *
 * 1. An object literal that hands a network's local space list (`spaces: <net>.spaces`) to a peer also carries
 *    `networkSpaces` — the invite answers keep the local names on purpose, because an older joiner reads `spaces`,
 *    and the network ids ride beside them. Anywhere else the list is sent through `announcedSpaces`.
 * 2. A space round (`space_deletion`, `space_wipe`) carries `networkSpaceId` beside its `spaceId` — kept as it was,
 *    because a 5.0/5.1 peer applies `spaceId` raw.
 * 3. The member self-record is built in ONE place and both directions of the exchange call it, so a field added
 *    for one direction cannot be missing from the other (the defect `engine.ts` already warns about).
 *
 * Run: node --test testing/standalone/peer-bound-space-ids-are-network-ids.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { enclosingBlockAround, argumentsOf } from './_structural-window.mjs';

const sources = trackedSources('server/src').filter(f => f.endsWith('.ts'));
const read = (f) => stripComments(readFileSync(f, 'utf8'));

describe('a network\'s local space list never reaches a peer without the network ids', () => {
  // `<something naming a network>.spaces` — a NetworkConfig's carried list. Token and webhook `spaces` are other
  // questions (a token's reach, a subscription filter) and are not a network's.
  const NET_SPACES = /\bspaces:\s*(\w*[Nn]et\w*)\.spaces\b(?!\.)/g;
  const sites = sources.flatMap(f => {
    const src = read(f);
    return [...src.matchAll(new RegExp(NET_SPACES))].map(m => ({ f, src, at: m.index }));
  });

  it('the sites are found, or this rule is about nothing', () => {
    assert.ok(sites.length >= 2, `only ${sites.length} site(s) hand a network's space list to anyone — the scan is wrong`);
  });

  for (const { f, src, at } of sites) {
    it(`${f} at ${at}: the network ids travel beside it`, () => {
      const object = enclosingBlockAround(src, at, `${f} space list`);
      assert.match(object, /\bnetworkSpaces:\s*announcedSpaces\(/,
        `${f} hands a peer this instance's local space names alone; after a rename they are not what the network calls them`);
    });
  }
});

describe('a space round names its space by the network id too', () => {
  /*
   * The rounds that reach a peer are the ones OPENED through `proposeRound`, so the subjects are the proposal each call hands it — derived
   * from the calls, not from a `type: 'space_…'` text anywhere in the tree. That text also names a function's parameter type (a notice's
   * wording) and the scratch round the forecast evaluates (`networks/round-forecast.ts`, which is never stored, served or signed): neither is
   * a round a peer reads, and a gate that anchored on the text judged them as if it were.
   */
  const proposals = sources.flatMap(f => {
    const src = read(f);
    // A call, not the declaration `function proposeRound(`.
    return [...src.matchAll(/(?<!\bfunction\s)\bproposeRound\s*\(/g)]
      .map(m => ({ f, proposal: argumentsOf(src, m.index, `${f} proposeRound`)[2] ?? '' }));
  });
  const kinds = (p) => [...p.proposal.matchAll(/\btype:\s*'(space_deletion|space_wipe)'/g)].map(m => m[1]);

  it('the openers are found, both round kinds among them', () => {
    assert.ok(proposals.length >= 3, `only ${proposals.length} call(s) of proposeRound found — the scan is wrong`);
    assert.deepEqual([...new Set(proposals.flatMap(kinds))].sort(), ['space_deletion', 'space_wipe']);
  });

  for (const p of proposals) {
    for (const type of kinds(p)) {
      it(`${type} opened in ${p.f} carries spaceId and networkSpaceId`, () => {
        assert.match(p.proposal, /\bspaceId\b/, 'the spaceId older peers read is gone');
        assert.match(p.proposal, /\bnetworkSpaceId:\s*localToRemote\(/,
          `${type} names its space only by this instance's local id; a member that calls it something else cannot act on it`);
      });
    }
  }

  it('proposeRound itself refuses a deletion or wipe that names its space only once', async () => {
    // The guard is inside the opener, so an opener that forgot a field cannot open the round (the source gate above sees only the openers that exist today).
    const { proposeRound } = await import('../../server/dist/networks/propose-round.js');
    const net = { id: 'n', votingDeadlineHours: 24, members: [], spaces: [], pendingRounds: [] };
    for (const type of ['space_deletion', 'space_wipe']) {
      const base = { type, subjectInstanceId: 'a', subjectLabel: 'a', subjectUrl: '' };
      assert.throws(() => proposeRound(net, {}, { ...base, spaceId: 'x' }), /networkSpaceId/, `${type} without networkSpaceId was opened`);
      assert.throws(() => proposeRound(net, {}, { ...base, networkSpaceId: 'x' }), /spaceId/, `${type} without spaceId was opened`);
    }
    assert.equal(net.pendingRounds.length, 0, 'a refused proposal left a round behind');
  });
});

describe('the member self-record has one builder', () => {
  it('no second hand-built self-record, and both directions call the builder', () => {
    const literal = sources.filter(f => f !== 'server/src/networks/self-record.ts' && /version:\s*SERVER_VERSION/.test(read(f)));
    assert.deepEqual(literal, [], 'a self-record is built by hand here, so a field on one direction can miss the other');
    const callers = sources.filter(f => /\bselfRecordFor\(/.test(read(f)) && f !== 'server/src/networks/self-record.ts');
    assert.ok(callers.length >= 2, `only ${callers.length} caller(s) of selfRecordFor — the exchange has two directions`);
  });
});

describe('a network\'s space mapping is written in one module', () => {
  /*
   * `sync/space-map.ts` is where the refusals live: no overwrite of another space's key, no self-alias, no second
   * network id for one space. A write anywhere else skips them, and the one it skips is the one that re-points a
   * synced space at the wrong collection. Read-only uses (`Object.entries(net.spaceMap)`, lookups) are not writes.
   */
  const OWNER = 'server/src/sync/space-map.ts';
  const WRITE = /spaceMap!?\??\.?\[[^\]]+\]\s*=(?!=)|delete\s+[\w.!?]*spaceMap\b|\.spaceMap\s*(?:\?\?)?=(?!=)/g;

  it('the owner itself matches the pattern, so the pattern can see a write', () => {
    assert.ok([...read(OWNER).matchAll(new RegExp(WRITE))].length >= 2, 'the write pattern finds nothing even in space-map.ts');
  });

  it('no other source writes a spaceMap', () => {
    const offenders = sources.filter(f => f !== OWNER).flatMap(f =>
      [...read(f).matchAll(new RegExp(WRITE))].map(m => `${f}: ${m[0]}`));
    assert.deepEqual(offenders, [], 'these write a spaceMap by hand; go through recordSpaceAlias, retargetSpaceAliases or forgetSpaceAliases');
  });
});
