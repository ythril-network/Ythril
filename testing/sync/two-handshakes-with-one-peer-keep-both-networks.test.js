/**
 * Two networks joined from the same peer keep both reachable, whatever order the handshakes land in (`Q-53`).
 *
 * An instance keeps ONE token per peer, and each handshake hands over a new one that replaces the last. Each was
 * minted at apply as the networks the pair shared at that moment, so a handshake whose apply landed before another's
 * finalize minted a token without the other network — and the network it left out answered 403 until the next
 * handshake. Whichever token a side ends up holding, it has to reach every network the pair shares: so every peer
 * token either side keeps for the other must reach both networks' spaces once both joins are done.
 *
 * The two joins run at once, which is the case that raced. Run in sequence the assertion still holds the rule: the
 * first handshake's token must learn the second network too, since nothing says it is not the one kept.
 *
 * Run: node --test testing/sync/two-handshakes-with-one-peer-keep-both-networks.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACES = [`q53-one-${RUN}`, `q53-two-${RUN}`];
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

let tA, tB, idA, idB;
const nets = [];

before(async () => {
  [tA, tB] = ['a', 'b'].map(token);
  idA = (await get(INSTANCES.a, tA, '/api/about')).body.instanceId;
  idB = (await get(INSTANCES.b, tB, '/api/about')).body.instanceId;
  const bundles = [];
  for (const s of SPACES) {
    assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: s, label: s })).status, 201);
    const n = await post(INSTANCES.a, tA, '/api/networks', { label: `${s}-net`, type: 'club', spaces: [s] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    nets.push(n.body.id);
    const inv = await post(INSTANCES.a, tA, '/api/invite/generate', { networkId: n.body.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    bundles.push({ handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
      rsaPublicKeyPem: inv.body.rsaPublicKeyPem, networkId: n.body.id, myUrl: 'http://ythril-b:3200' });
  }
  // At once: both applies can land before either finalize, which is the order that raced.
  const joins = await Promise.all(bundles.map(b => post(INSTANCES.b, tB, '/api/networks/join-remote', b)));
  for (const j of joins) assert.equal(j.status, 200, JSON.stringify(j.body));
});

after(async () => {
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
    for (const id of nets) await del(base, tok, `/api/networks/${id}`).catch(() => {});
    for (const s of SPACES) await delWithBody(base, tok, `/api/spaces/${s}`, { confirm: true }).catch(() => {});
  }
});

/** Every token `base` keeps for `peer`, with the spaces of `SPACES` each one does not reach. */
async function shortTokens(base, tok, peer) {
  const r = await get(base, tok, '/api/tokens');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const all = Array.isArray(r.body) ? r.body : r.body.tokens;
  // The tokens a HANDSHAKE minted for the peer — `peer:<label>` on both sides — because those are what a side hands
  // over and keeps. A token another suite minted by hand for the same peer (`join-governance` mints `s9-peer-*`) is
  // not one this rule is about, and counting it made this file fail whenever that suite ran first.
  const mine = all.filter(t => t.peerInstanceId === peer && /^peer:/.test(t.name));
  assert.ok(mine.length > 0, `no peer token for ${peer} on ${base}`);
  return mine
    .map(t => ({ name: t.name, missing: SPACES.filter(s => !t.rights?.perSpace?.[s]) }))
    .filter(t => t.missing.length);
}

describe('two handshakes with one peer', () => {
  it('every token the inviter keeps for the joiner reaches both networks', async () => {
    assert.deepEqual(await shortTokens(INSTANCES.a, tA, idB), []);
  });

  it('every token the joiner keeps for the inviter reaches both networks', async () => {
    assert.deepEqual(await shortTokens(INSTANCES.b, tB, idA), []);
  });
});
