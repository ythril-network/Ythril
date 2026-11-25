/**
 * One club for the Q-966 specs: a space on A that holds a schema BEFORE anybody joins, a club of `type` carrying it, and members
 * joining through the instance each is told to join through.
 *
 * It answers "how does a spec stand up a voted network whose schema exists before its members do, and read what each member holds as
 * that network's layer", asked by every Q-966 spec; a club needs no vote to admit a member, so a third member is cheap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { INSTANCES, post, patch, get, del, delWithBody, readContainerConfig } from './helpers.js';

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs');
export const tokenOf = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
export const SCHEMA = { validationMode: 'strict', typeSchemas: { entity: { person: { propertySchemas: { tier: { type: 'number' } } } } } };

/** The schema as a member must hold it: the type and the validation mode. */
export const holdsSchema = (meta) => meta?.validationMode === 'strict' && meta?.typeSchemas?.entity?.person?.propertySchemas?.tier?.type === 'number';

export const layerOn = (x, networkId, space) => readContainerConfig(`ythril-${x}`).networks.find(n => n.id === networkId)?.schemaLayers?.[space];
export const networkOn = (x, networkId) => readContainerConfig(`ythril-${x}`).networks.find(n => n.id === networkId);
export const metaOn = async (x, space) => (await get(INSTANCES[x], tokenOf(x), `/api/spaces/${space}/meta`)).body ?? {};

/** A creates `space` with the schema and a club carrying it. */
export async function createClub(tag, type = 'club') {
  const space = `q966-${tag}-${Date.now()}`;
  const tA = tokenOf('a');
  assert.equal((await post(INSTANCES.a, tA, '/api/spaces', { id: space, label: space })).status, 201);
  const m = await patch(INSTANCES.a, tA, `/api/spaces/${space}`, { meta: SCHEMA });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const n = await post(INSTANCES.a, tA, '/api/networks', { label: space, type, spaces: [space], votingDeadlineHours: 1 });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  return { space, networkId: n.body.id, joined: [] };
}

/** `joiner` joins the network through `through`'s invite. */
export async function joinThrough(club, joiner, through = 'a') {
  const inv = await post(INSTANCES[through], tokenOf(through), '/api/invite/generate', { networkId: club.networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const j = await post(INSTANCES[joiner], tokenOf(joiner), '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: `http://ythril-${through}:3200/api/invite/apply`, rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId: club.networkId, myUrl: `http://ythril-${joiner}:3200`,
  });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  if (!club.joined.includes(joiner)) club.joined.push(joiner);
  return j;
}

/** Remove the club and its space from every instance that held them. */
export async function tearDown(clubs) {
  for (const club of clubs) {
    for (const x of ['c', 'b', 'a']) {
      await del(INSTANCES[x], tokenOf(x), `/api/networks/${club.networkId}`).catch(() => {});
      await delWithBody(INSTANCES[x], tokenOf(x), `/api/spaces/${club.space}`, { confirm: true }).catch(() => {});
    }
  }
}
