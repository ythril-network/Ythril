/**
 * A peer names a space by the NETWORK's id; this instance may carry it under another (`Q-51`).
 *
 * `join-remote` records `spaceMap` (network id → local id) when an operator maps a network space onto a space of a
 * different name, and this instance's own engine translates both ways (`sync/space-map.ts`). The inbound routes did
 * not: a peer asked for the network's id, `spaceAllowed` looked for it among the local ids and answered 403. Data
 * still arrived through this instance's own cycle, so nothing looked broken here — but the peer's cycle for that space
 * was refused every time, and since `Q-48` it reports the cycle failed.
 *
 * ## Why one middleware and not a fix per route
 *
 * Every sync route reads `spaceId` and then admits, reads and writes by it. Translating in each would be a dozen
 * copies of one rule, and the route added next year would be the one that forgets. Ahead of all of them, the rest of
 * the route never sees the network's id at all.
 *
 * ## What it does not widen
 *
 * It only renames: the translated id still goes through `spaceAllowed`, so a peer reaches exactly what it reached by
 * the local id, and a network without a `spaceMap` is untouched. Express 5 makes `req.query` a getter, so the
 * translated query is set as the request's own property rather than by assignment.
 */
import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config/loader.js';
import { remoteToLocal } from '../../sync/space-map.js';

export function resolveNetworkSpaceAlias(req: Request, _res: Response, next: NextFunction): void {
  const query = req.query as Record<string, unknown>;
  const body = req.body as Record<string, unknown> | undefined;
  const networkId = query['networkId'] ?? body?.['networkId'];
  if (typeof networkId !== 'string') { next(); return; }
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net?.spaceMap) { next(); return; }

  const q = query['spaceId'];
  if (typeof q === 'string' && remoteToLocal(net, q) !== q) {
    Object.defineProperty(req, 'query', { value: { ...query, spaceId: remoteToLocal(net, q) }, writable: true, configurable: true, enumerable: true });
  }
  if (body && typeof body['spaceId'] === 'string') body['spaceId'] = remoteToLocal(net, body['spaceId']);
  next();
}
