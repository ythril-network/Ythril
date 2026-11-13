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
 * 1. `400 { code: 'bad_fingerprint' }` unless `fp` is 64 lowercase hex (it names nothing, so it is asked first);
 * 2. `403` for a caller that does not reach the space (`refusePeerReach`), before the rung and before the space is looked up: a caller that may not
 *    reach a space is told nothing of whether it exists, the same order `GET /meta` decides in;
 * 3. `403 { code: 'schema_rung' }` for a token that may not read the schema (`refuseSchemaRung`, the check `GET /meta` asks too);
 * 4. the answer `sendLostSpace` gives for a space this instance does not have (the one call `GET /meta` makes, so the two doors answer a lost space
 *    alike): `410 space_retired` for a retired id, otherwise `404` with the sentence `unknownSpaceSentence` spells and no code. The receiver tells it
 *    from a missing route by those words (`sync/schema-snapshot-fetch.ts`);
 * 5. `404 { code: 'unknown_fingerprint' }` for a fingerprint no row holds. The only 404 that carries a code: a receiver reads a 404 WITHOUT one as
 *    "this member has no such route" and stops asking it;
 * 6. `409 { code: 'not_shared' }` for a row built from a layer of a network the asking peer does not share with this space (`servableTo`): a variation
 *    over a layer of N2 holds N2's definitions, which the sync door's `GET /api/sync/meta` never sends to N1;
 * 7. `200 { fp, text, links, layerOf? }`, the links cut to the shared networks. A caller that is no peer (an admin or a local token) shares by reach and is
 *    served the row whole.
 *
 * The empty schema's fingerprint has no row on any instance (every instance knows it held) and is answered from its constant.
 */
import type { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { asFilter } from '../../db/mongo.js';
import { networkIdsSharedWithCaller } from '../../networks/network-spaces.js';
import { servableTo } from '../../spaces/schema-snapshot.js';
import { EMPTY_SCHEMA_FINGERPRINT, EMPTY_SCHEMA_STAMP, isSchemaFingerprint } from '../../spaces/schema-stamp.js';
import { snapshots, type SnapshotRow } from '../../spaces/schema-snapshot-store.js';
import { isConfiguredSpace } from '../../spaces/space-lookup.js';
import { sendCaughtFailure } from '../send-failure.js';
import { BAD_FINGERPRINT, UNKNOWN_FINGERPRINT, badFingerprintSentence } from '../../util/errors.js';
import { sendLostSpace } from '../write-target-answer.js';
import { refusePeerReach, refuseSchemaRung } from './_shared.js';

/**
 * Register `GET /schema-snapshot` on the sync meta router. The parameter is spelled as the caller spells the router (`syncMetaRouter`), as
 * `spaces-reembed.ts` does: the surface matrix's static extraction resolves a route's prefix by the name it is registered on, and a bare `router`
 * takes the prefix of whichever other register function names its parameter `router` (here it read `/api/files`).
 */
export function registerSchemaSnapshotRoute(syncMetaRouter: Router): void {
  syncMetaRouter.get('/schema-snapshot', syncRateLimit, requireAuth, async (req, res) => {
    try {
      const { spaceId, networkId, fp } = req.query as Record<string, string>;
      if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
      if (!isSchemaFingerprint(fp)) {
        res.status(400).json({ error: badFingerprintSentence('fp'), code: BAD_FINGERPRINT });
        return;
      }
      if (refusePeerReach(res, spaceId, networkId, req.authToken)) return;
      if (refuseSchemaRung(res, spaceId, req.authToken)) return;
      if (!isConfiguredSpace(spaceId)) { sendLostSpace(req, res, spaceId); return; }
      if (fp === EMPTY_SCHEMA_FINGERPRINT) {
        res.json({ fp, text: EMPTY_SCHEMA_STAMP.text, links: { own: fp, layers: [], served: [] } });
        return;
      }
      const row = await snapshots(spaceId).findOne(asFilter<SnapshotRow>({ _id: fp }));
      if (!row) { res.status(404).json({ error: 'This instance holds no schema snapshot with that fingerprint', code: UNKNOWN_FINGERPRINT }); return; }
      const shared = networkIdsSharedWithCaller(spaceId, req.authToken as object | undefined);
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
