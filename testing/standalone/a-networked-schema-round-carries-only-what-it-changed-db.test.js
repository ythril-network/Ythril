/**
 * A networked schema write PROPOSES only what it changed, and a member applies a round whole or not at all (`Q-216`; R6-6).
 *
 * ## What was found
 *
 * **The leak (pre-existing, found by the data-integrity lens as S3).** A schema write on a networked space merged the caller's types over
 * the space's EFFECTIVE meta — own definitions plus every network's layer — and put that whole snapshot in the round (`pendingMeta`).
 * Conclusion then merged every type of the snapshot into the proposer's own definitions and into the voted network's layer. So a one-type
 * edit copied each other network's types into this network's layer, and the network's types into this instance's own definitions, where
 * they are served to every network the space is in ("nothing mixed is sent on", owner, 2026-09-25).
 *
 * **The partial apply.** A passed round was stored by `commitOwnMetaEdit` / `storeNetworkLayer` without a parse. `effectiveMeta` then
 * re-parsed the layer and, if it no longer parsed, silently skipped the WHOLE layer. So one bad type stopped every type that came with it —
 * and a layer that held an old risky pattern (stored before the rule existed) wedged every later round into the same layer. `sync-protocol.md`
 * promises the opposite of a partial apply: a meta that does not parse is *refused whole, never in part*.
 *
 * ## What holds
 *
 * - a networked write's round carries ONLY the types and fields it changed, diffed against the effective meta it read;
 * - the proposer's own definitions take only those parts, and the voted network's layer takes only those parts;
 * - a round whose changed parts a member cannot parse is applied NOWHERE on that member — not the parts that would parse either;
 * - a legacy wholesale round (no `metaChangedFields`) is compared with the stored meta to find its parts, so a type it merely repeats
 *   unchanged — even one a stricter body would refuse today — does not make the round unparseable.
 *
 * Run: node --test testing/standalone/a-networked-schema-round-carries-only-what-it-changed-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { bootInstance, tempInstanceDir, removeInstanceDir } from './_vote-round-instance.mjs';
import { NET_ID, SELF, P1, scenario, decide } from './_vote-round-sites.mjs';
import { REDOS_PATTERN } from './_invalid-schema-fixtures.mjs';

const dir = tempInstanceDir('ythril-round-changed-');
const skip = await mongoSkipReason();

const member = (instanceId) => ({ instanceId, label: `member ${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both' });
const entityTypes = (meta) => Object.keys(meta?.typeSchemas?.entity ?? {}).sort();

describe('a networked schema round carries only what it changed', { skip }, () => {
  before(async () => { await openTestMongo('round_changed_parts'); });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  describe('the proposer', () => {
    /** A club (one yes passes a round) whose space holds an own type and a network-supplied one. */
    const boot = () => bootInstance(dir, {
      instanceId: SELF,
      spaces: [{
        id: 'notes', label: 'Notes', folders: [],
        meta: { validationMode: 'strict', typeSchemas: { entity: { OwnType: { namingPattern: '^o' }, LayerType: { namingPattern: '^l' } } } },
        ownMeta: { validationMode: 'strict', typeSchemas: { entity: { OwnType: { namingPattern: '^o' } } } },
      }],
      networks: [{
        id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: ['notes'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [member(P1)], pendingRounds: [],
        schemaLayers: { notes: { typeSchemas: { entity: { LayerType: { namingPattern: '^l' } } } } },
      }],
    });

    it('proposes the one type it changed, and neither its own other types nor the network\'s', async () => {
      const loader = await boot();
      const { planSpaceMetaUpdate, applySpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js');
      const space = loader.getConfig().spaces.find(s => s.id === 'notes');
      const decision = planSpaceMetaUpdate({ spaceId: 'notes', space, body: { meta: { typeSchemas: { entity: { NewType: { namingPattern: '^n' } } } } }, ifMatch: undefined });
      assert.equal(decision.ok, true, JSON.stringify(decision.refusal));
      await applySpaceMetaUpdate(decision.plan);

      const net = loader.getConfig().networks.find(n => n.id === NET_ID);
      const round = net.pendingRounds.find(r => r.type === 'meta_change');
      assert.ok(round, 'no meta_change round was opened for a schema write on a networked space');
      assert.deepEqual(entityTypes(round.pendingMeta), ['NewType'],
        'the round carries types the edit did not change: it will copy the other network\'s types into this network\'s layer and the layer\'s into the own definitions');
    });

    it('lands the change in its own definitions and the voted layer, and copies nothing between them', async () => {
      const loader = await boot();
      const { planSpaceMetaUpdate, applySpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js');
      const space = loader.getConfig().spaces.find(s => s.id === 'notes');
      const decision = planSpaceMetaUpdate({ spaceId: 'notes', space, body: { meta: { typeSchemas: { entity: { NewType: { namingPattern: '^n' } } } } }, ifMatch: undefined });
      await applySpaceMetaUpdate(decision.plan);

      const held = loader.getConfig().spaces.find(s => s.id === 'notes');
      const layer = loader.getConfig().networks.find(n => n.id === NET_ID).schemaLayers.notes;
      assert.deepEqual(entityTypes(held.ownMeta), ['NewType', 'OwnType'], `the own definitions took a type the edit did not make: ${JSON.stringify(entityTypes(held.ownMeta))} (LayerType is the network\'s, not this instance\'s)`);
      assert.deepEqual(entityTypes(layer), ['LayerType', 'NewType'], `the network's layer took a type the edit did not make: ${JSON.stringify(entityTypes(layer))} (OwnType is this instance's, never sent on)`);
      assert.deepEqual(entityTypes(held.meta), ['LayerType', 'NewType', 'OwnType'], 'the effective meta lost a type');
    });
  });

  describe('a member applies a round whole or not at all', () => {
    /** The relayed-cast scenario with a custom round, on a space that already holds `layer` as the network's layer. */
    const run = async ({ pendingMeta, metaChangedFields, baseMetaVersion, layer, meta }) => {
      const scen = scenario('meta_change', 'closed', 'relay', 'http://127.0.0.1:9');
      scen.round.pendingMeta = pendingMeta;
      if (metaChangedFields === undefined) { delete scen.round.metaChangedFields; delete scen.round.baseMetaVersion; }
      else { scen.round.metaChangedFields = metaChangedFields; scen.round.baseMetaVersion = baseMetaVersion; }
      scen.wire = { ...scen.round, votes: [...scen.round.votes, scen.decidingCast], concluded: false };
      if (layer) scen.net.schemaLayers = { notes: layer };
      const loader = await bootInstance(dir, {
        instanceId: SELF,
        spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, { id: 'notes', label: 'Notes', folders: [], meta: meta ?? { validationMode: 'strict' } }],
        networks: [scen.net], peerTokens: { [P1]: 'token-p1' },
      });
      await decide('relay', loader, scen, { seen: [] });
      return {
        layer: loader.getConfig().networks.find(n => n.id === NET_ID).schemaLayers?.notes,
        meta: loader.getConfig().spaces.find(s => s.id === 'notes').meta,
      };
    };

    it('a round with one unparseable changed part and one good one applies neither', async () => {
      const after = await run({
        pendingMeta: { typeSchemas: { entity: { Good: { namingPattern: '^g' }, Bad: { namingPattern: REDOS_PATTERN } } } },
        metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      });
      assert.deepEqual(entityTypes(after.layer), [], `the member applied part of a round it could not parse: layer holds ${JSON.stringify(entityTypes(after.layer))}. Refused whole, never in part.`);
      assert.deepEqual(entityTypes(after.meta), [], 'the effective meta took part of a round that does not parse');
    });

    it('the same round with both parts good IS applied (the control: the refusal above is the parse, not the harness)', async () => {
      const after = await run({
        pendingMeta: { typeSchemas: { entity: { Good: { namingPattern: '^g' }, AlsoGood: { namingPattern: '^a' } } } },
        metaChangedFields: ['typeSchemas'], baseMetaVersion: 0,
      });
      assert.deepEqual(entityTypes(after.layer), ['AlsoGood', 'Good']);
      assert.deepEqual(entityTypes(after.meta), ['AlsoGood', 'Good']);
    });

    it('a legacy wholesale round repeating a type unchanged does not wedge on it (it is compared with what is stored)', async () => {
      // The legacy layer was stored before the pattern rule existed. The round (no metaChangedFields: a peer predating field-merge) repeats
      // it unchanged beside a genuinely new type and a new purpose.
      const legacy = { typeSchemas: { entity: { Legacy: { namingPattern: REDOS_PATTERN } } } };
      const after = await run({
        layer: legacy,
        meta: { validationMode: 'strict', typeSchemas: legacy.typeSchemas },
        pendingMeta: { purpose: 'a purpose the network chose', typeSchemas: { entity: { Legacy: { namingPattern: REDOS_PATTERN }, Added: { namingPattern: '^a' } } } },
      });
      assert.ok(entityTypes(after.meta).includes('Added'),
        `the wholesale round was lost because it repeated a stored type a stricter body refuses: the effective meta holds ${JSON.stringify(entityTypes(after.meta))}`);
      assert.equal(after.meta.purpose, 'a purpose the network chose', 'the parseable change in the same round was lost');
    });
  });
});
