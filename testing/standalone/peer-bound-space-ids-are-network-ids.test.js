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
import { enclosingBlockAround } from './_structural-window.mjs';

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
  const ROUND = /type:\s*'(space_deletion|space_wipe)'/g;
  const rounds = sources.flatMap(f => {
    const src = read(f);
    return [...src.matchAll(new RegExp(ROUND))].map(m => ({ f, src, at: m.index, type: m[1] }));
  });

  it('both round kinds are found', () => {
    assert.deepEqual([...new Set(rounds.map(r => r.type))].sort(), ['space_deletion', 'space_wipe']);
  });

  for (const { f, src, at, type } of rounds) {
    it(`${type} in ${f} carries networkSpaceId`, () => {
      const object = enclosingBlockAround(src, at, `${f} ${type}`);
      assert.match(object, /\bspaceId\b/, 'the spaceId older peers read is gone');
      assert.match(object, /\bnetworkSpaceId:\s*localToRemote\(/,
        `${type} names its space only by this instance's local id; a member that calls it something else cannot act on it`);
    });
  }
});

describe('the member self-record has one builder', () => {
  it('no second hand-built self-record, and both directions call the builder', () => {
    const literal = sources.filter(f => f !== 'server/src/networks/self-record.ts' && /version:\s*SERVER_VERSION/.test(read(f)));
    assert.deepEqual(literal, [], 'a self-record is built by hand here, so a field on one direction can miss the other');
    const callers = sources.filter(f => /\bselfRecordFor\(/.test(read(f)) && f !== 'server/src/networks/self-record.ts');
    assert.ok(callers.length >= 2, `only ${callers.length} caller(s) of selfRecordFor — the exchange has two directions`);
  });
});
