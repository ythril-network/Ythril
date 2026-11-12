/**
 * `GET /api/sync/schema-snapshot?spaceId=&networkId=&fp=` hands a peer one schema version this server keeps privately (Q-738, bundle-265): the member
 * that received a record stamped with a fingerprint it holds no snapshot of asks the sender for it (`sync/schema-snapshot-fetch.ts`).
 *
 * Registered on `syncMetaRouter` (`registerSchemaSnapshotRoute`, called from `meta.ts`), which `syncRouter` mounts: the peer-authenticated surface, so
 * the route needs no row of its own in the route-guard exemptions. A schema is not data, so like `GET /meta` this door asks reach and the schema rung
 * and never the hold (a wipe changes no schema).
 *
 * ## The answers, in the order they are decided
 *
 * 1. `400 { code: 'bad_fingerprint' }` unless `fp` is 64 lowercase hex;
 * 2. `410 { code: 'lost_space' }` for a space this instance does not have: the existence rule comes first on every route that names a space
 *    (`answeredUnknownSpace`), and a receiver must tell "the member lost the space" from "the member has no such route", which a bare 404 does not say;
 * 3. `403` for a caller that does not reach the space (`refusePeerReach`), before the rung and before the row is looked at;
 * 4. `403 { code: 'schema_rung' }` for a token that may not read the schema (`refuseSchemaRung`, the check `GET /meta` asks too);
 * 5. `404 { code: 'unknown_fingerprint' }` for a fingerprint no row holds. The only 404 that carries a code: a receiver reads a 404 WITHOUT one as
 *    "this member has no such route" and stops asking it;
 * 6. `409 { code: 'not_shared' }` for a row built from a layer of a network the asking peer does not share with this space (`servableTo`): a variation
 *    over a layer of N2 holds N2's definitions, which `GET /meta` never sends to N1;
 * 7. `200 { fp, text, links, layerOf? }`, the links cut to the shared networks. A caller that is no peer (an admin or a local token) shares by reach and is
 *    served the row whole.
 *
 * The empty schema's fingerprint has no row on any instance (every instance knows it held) and is answered from its constant.
 */
import type { Router } from 'express';
import { schemaFingerprintTextOf } from '@ythril-network/schema/internal';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { peerBoundTo } from '../../auth/peer-bound.js';
import { getConfig } from '../../config/loader.js';
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { networksHolding } from '../../spaces/wipe-vote.js';
import { servableTo } from '../../spaces/schema-snapshot.js';
import { EMPTY_SCHEMA_FINGERPRINT } from '../../spaces/schema-stamp.js';
import type { SnapshotRow } from '../../spaces/schema-snapshot-store.js';
import { sendCaughtFailure } from '../send-failure.js';
import { unknownSpaceSentence } from '../../spaces/unknown-space.js';
import { peerMemberNetworks, refusePeerReach, refuseSchemaRung } from './_shared.js';

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** The networks the asking peer and this server both hold `spaceId` in; `undefined` for a caller that is no peer (it shares by reach). */
function sharedNetworksOf(spaceId: string, authToken: unknown): Set<string> | undefined {
  const peerId = peerBoundTo(authToken as Record<string, unknown> | undefined);
  if (!peerId) return undefined;
  return new Set(networksHolding(spaceId, { networks: peerMemberNetworks(peerId) }).map(n => n.id));
}

/** Register `GET /schema-snapshot` on `router` (the sync meta router). */
export function registerSchemaSnapshotRoute(router: Router): void {
  router.get('/schema-snapshot', syncRateLimit, requireAuth, async (req, res) => {
    try {
      const { spaceId, networkId, fp } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (typeof fp !== 'string' || !FINGERPRINT.test(fp)) {
        res.status(400).json({ error: 'fp must be a schema fingerprint: 64 lowercase hex characters', code: 'bad_fingerprint' });
        return;
      }
      if (!getConfig().spaces.some(s => s.id === spaceId)) {
        res.status(410).json({ error: unknownSpaceSentence(spaceId), code: 'lost_space' });
        return;
      }
      if (refusePeerReach(res, spaceId, networkId, req.authToken)) return;
      if (refuseSchemaRung(res, spaceId, req.authToken)) return;
      if (fp === EMPTY_SCHEMA_FINGERPRINT) {
        res.json({ fp, text: schemaFingerprintTextOf(undefined), links: { own: fp, layers: [], served: [] } });
        return;
      }
      const row = await col<SnapshotRow>(spaceCollection(spaceId, 'schemaSnapshots')).findOne(asFilter<SnapshotRow>({ _id: fp }));
      if (!row) { res.status(404).json({ error: 'This instance holds no schema snapshot with that fingerprint', code: 'unknown_fingerprint' }); return; }
      const shared = sharedNetworksOf(spaceId, req.authToken);
      const served = shared ? servableTo(row, shared) : { ok: true as const, links: row.links };
      if (!served.ok) {
        res.status(409).json({ error: 'That schema was built from a network the asking member is not in', code: served.code });
        return;
      }
      res.json({ fp: row._id, text: row.text, links: served.links, ...(row.origin === 'layer' && row.networkId !== undefined ? { layerOf: row.networkId } : {}) });
    } catch (err) {
      sendCaughtFailure(res, 'sync GET /schema-snapshot', err);
    }
  });
}
