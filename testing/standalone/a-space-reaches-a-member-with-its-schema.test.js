/**
 * A space added to a network reaches its members with its schema and posture, and a proposer sees its own change
 * (`Q-60`).
 *
 * Found 2026-09-26: y-tickets and its siblings, created on dev with their schema and then added to a network, were
 * adopted on home EMPTY (no types, no validation mode) until an unrelated schema change opened a round. Three causes:
 *
 *   1. a schema-library `$ref` left the sender as-is, and a member without that entry refused the WHOLE schema
 *      (the meta pull) or stored a reference to nothing (a passed round);
 *   2. a voted network (club, closed, democratic) has no meta pull, and a `space_addition` round carried no schema;
 *   3. the proposer of a club round wrote its change into its own definitions while every other member wrote it
 *      into the network's layer — and the layer outranks own definitions, so the proposer went on seeing the old
 *      value. Seen on ythril-home's `y-flows-feedback` usage notes.
 *
 * Source gates: each fix lives at the one door its data leaves or arrives by, and these hold the doors to it.
 *
 * Run: node --test testing/standalone/a-space-reaches-a-member-with-its-schema.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const read = f => stripComments(readFileSync(f, 'utf8'));
const body = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at > -1, `${head} is gone — re-anchor this gate`);
  return src.slice(at, src.indexOf('\nexport ', at + head.length));
};

describe('a library reference travels resolved', () => {
  it('both doors a meta leaves by inline the references this instance can resolve', () => {
    assert.match(read('server/src/api/sync/meta.ts'), /inlineResolvableRefs\(replicatedMetaOf\(/);
    assert.match(body(read('server/src/networks/round-local-state.ts'), 'export function roundForPeer'), /inlineResolvableRefs\(copy\.pendingMeta\)/);
  });
  it('an arriving layer leaves out only the types it cannot resolve, not the whole schema', () => {
    const accept = body(read('server/src/sync/space-meta-pull.ts'), 'export function acceptNetworkLayer');
    assert.match(accept, /withoutBrokenLibraryRefs\(/);
    assert.doesNotMatch(accept, /refused whole: it references/, 'the whole-schema refusal for a missing entry is back');
  });
});

describe('a voted network carries the schema on the round', () => {
  it('adding a space puts its schema on the space_addition round', () => {
    const add = body(read('server/src/networks/network-acts.ts'), 'export function addNetworkSpaceAct');
    assert.match(add, /layerOnAdd/);
    assert.match(add, /pendingMeta: layerOnAdd/);
  });
  it('a member that adds the space from a passed round keeps that schema as the layer, through the one accept', () => {
    const apply = body(read('server/src/networks/network-spaces.ts'), 'export function applySpaceAdditionRound');
    assert.match(apply, /acceptNetworkLayer\(net\.id, entry\.localId, round\.pendingMeta/);
  });
});

describe('a space that waits as pending keeps the schema its round carried', () => {
  it('the round path holds the schema on the pending entry, and an accept applies it', () => {
    assert.match(body(read('server/src/networks/network-spaces.ts'), 'export function applySpaceAdditionRound'), /meta: round\.pendingMeta/);
    const accept = body(read('server/src/networks/network-acts.ts'), 'export async function resolvePendingSpaceAct');
    assert.match(accept, /acceptNetworkLayer\(netAfter\.id, localId, entry\.meta/);
  });
});

describe('the proposer sees its own passed change', () => {
  it('a proposer holding a layer for the network updates it too', () => {
    const gov = read('server/src/sync/governance.ts');
    const at = gov.indexOf('if (round.proposedHere && !round.proposesLayer) {');
    assert.ok(at > -1, 'the proposer branch is gone — re-anchor this gate');
    const branch = gov.slice(at, gov.indexOf('} else {', at));
    assert.match(branch, /commitOwnMetaEdit\(/);
    assert.match(branch, /storeNetworkLayer\(net\.id, localSpace, applyMetaRound\(layer,/);
  });
});
