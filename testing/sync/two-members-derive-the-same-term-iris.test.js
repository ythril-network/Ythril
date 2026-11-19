/**
 * Two members of a network name one schema's types and properties alike, and nothing a network sends moves a base a member holds (Q-748,
 * slice A, design r4 §8 SY).
 *
 * On a closed network of A and B, A switches RDF on for a shared space with a base and a schema whose types carry and omit an `iri`. Once B
 * has the meta, the two members hold one base, and the one resolver (`server/src/rdf/term-iri.ts`, pure) gives the same address for each type
 * and property from each member's own meta. Then a settings round from A carrying ANOTHER base changes nothing on either member: the base
 * moves only by a `space_rebase` round. Last, A holds a higher epoch B missed (written into A's config, as a landing writes it): B is told
 * through the `rdfBases` A serves beside its vote list, keeps its base until its admin accepts the offered one, and the conflict clears.
 *
 * Run: node --test testing/sync/two-members-derive-the-same-term-iris.test.js (the sync stack up, built from this branch)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, get, patch, post, waitFor, mirroredNetwork, delWithBody, dockerExec, readContainerConfig, reloadConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const SPACE = `rdf-names-${Date.now()}`;
const BASE = `https://names.example.org/ld/${SPACE}/`;
const SCHEMA = {
  entity: { person: { iri: 'https://schema.org/Person', propertySchemas: { email: { type: 'string', iri: 'https://schema.org/email' }, 'nick name': { type: 'string' } } } },
  edge: { knows: { propertySchemas: { since: { type: 'date' } } } },
};
let tokenA, tokenB, net, termIri;

const metaOf = async (base, token) => ((await get(base, token, `/api/spaces/${SPACE}`)).body?.space ?? {}).meta ?? {};
const syncBoth = async () => {
  await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
  await post(INSTANCES.a, tokenA, `/api/networks/${net.networkId}/sync?wait=true`, {}).catch(() => {});
};
/** Propose a meta change from A on the closed network and pass it with B's yes. */
async function passMetaChange(meta) {
  const w = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta });
  assert.ok([200, 202].includes(w.status), JSON.stringify(w.body));
  const roundId = w.body?.rounds?.[0]?.roundId;
  if (!roundId) return;
  await waitFor(async () => {
    await syncBoth();
    const v = await get(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes`);
    return (v.body?.rounds ?? []).some(r => r.roundId === roundId);
  }, 60_000, 1_000, () => 'B never learned the round');
  const yes = await post(INSTANCES.b, tokenB, `/api/networks/${net.networkId}/votes/${roundId}`, { vote: 'yes' });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
}

before(async () => {
  termIri = await import('../../server/dist/rdf/term-iri.js');
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  }
  net = await mirroredNetwork({ label: SPACE, spaces: [SPACE], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB] });
});

after(async () => {
  await net?.remove();
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('two members derive the same term IRIs', () => {
  it('A switches RDF on with a base and a schema; both members hold one base', async () => {
    await passMetaChange({ rdf: { enabled: true, base: BASE }, typeSchemas: SCHEMA });
    await waitFor(async () => {
      await syncBoth();
      const [a, b] = [await metaOf(INSTANCES.a, tokenA), await metaOf(INSTANCES.b, tokenB)];
      return a.rdf?.base === BASE && b.rdf?.base === BASE && b.typeSchemas?.entity?.person;
    }, 120_000, 2_000, () => 'the two members never held one base and the schema');
  });

  it('the one resolver gives each type and property one address on both members', async () => {
    const [a, b] = [await metaOf(INSTANCES.a, tokenA), await metaOf(INSTANCES.b, tokenB)];
    assert.deepEqual(b.rdf, a.rdf, 'the two members hold different RDF settings');
    const terms = [['entity', 'person'], ['entity', 'person', 'email'], ['entity', 'person', 'nick name'], ['edge', 'knows'], ['edge', 'knows', 'since']];
    for (const [kind, type, prop] of terms) {
      assert.equal(termIri.resolveTermIri(b, kind, type, prop), termIri.resolveTermIri(a, kind, type, prop), `${kind}/${type}/${prop ?? ''}`);
    }
    assert.equal(termIri.resolveTermIri(a, 'entity', 'person'), 'https://schema.org/Person');
    assert.equal(termIri.resolveTermIri(a, 'entity', 'person', 'nick name'), `${BASE}vocab/entity/person/nick%20name`);
    assert.equal(termIri.recordIri(b, 'entity', 'x y'), termIri.recordIri(a, 'entity', 'x y'));
  });

  it('a settings round carrying another base moves it on neither member', async () => {
    const w = await patch(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true, base: 'https://other.example.org/ld/x/' } } });
    assert.equal(w.status, 409, `a different base without rebase is frozen at the door: ${JSON.stringify(w.body)}`);
    await passMetaChange({ purpose: 'a purpose after the base was set' });
    await syncBoth();
    const [a, b] = [await metaOf(INSTANCES.a, tokenA), await metaOf(INSTANCES.b, tokenB)];
    assert.equal(a.rdf?.base, BASE);
    assert.equal(b.rdf?.base, BASE);
    assert.equal(b.rdfBaseConflict, undefined, 'no conflict is recorded where the members agree');
  });

  it('a member that missed a rebase is told through the served rdfBases, and its admin accepts the base (owner, 2026-11-19)', async () => {
    // What a landed rebase B missed leaves on A: the new base at epoch 1, written into A's own config as the landing writes it.
    const NEXT = `https://next.example.org/ld/${SPACE}/`;
    const script = `const fs=require('fs');const p='/config/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));`
      + `for(const s of c.spaces){if(s.id===${JSON.stringify(SPACE)}){const r={enabled:true,base:${JSON.stringify(NEXT)},vocab:${JSON.stringify(`${NEXT}vocab/`)},baseEpoch:1};`
      + `s.meta={...s.meta,rdf:r};if(s.ownMeta)s.ownMeta={...s.ownMeta,rdf:r};}}fs.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600});`;
    dockerExec(`docker exec ythril-a node -e "${script.replace(/"/g, '\\"')}"`);
    await reloadConfig(INSTANCES.a, tokenA);
    await waitFor(async () => {
      await syncBoth();
      const cfg = readContainerConfig('ythril-b');
      return cfg.networks?.find(n => n.id === net.networkId)?.rdfBaseConflicts?.[SPACE]?.offered?.[0]?.base === NEXT;
    }, 60_000, 2_000, () => 'B never recorded the higher base A serves');
    assert.equal((await metaOf(INSTANCES.b, tokenB)).rdf?.base, BASE, 'the served base moved B by itself');
    const accepted = await patch(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { meta: { rdf: { enabled: true, base: NEXT, rebase: true } } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual((await metaOf(INSTANCES.b, tokenB)).rdf, { enabled: true, base: NEXT, vocab: `${NEXT}vocab/`, baseEpoch: 1 });
    assert.equal(readContainerConfig('ythril-b').networks?.find(n => n.id === net.networkId)?.rdfBaseConflicts, undefined);
  });
});
