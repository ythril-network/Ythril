/**
 * What a test of bundle-265's schema snapshot fetch needs and no helper had: snapshot texts that are canonical by the
 * server's own function, rows of the private snapshot collection, and a peer that answers `GET /api/sync/schema-snapshot`
 * as a case scripts it, in front of the fake peer of `_pull-door.mjs`.
 *
 * ## Why a proxy and not a hook in the fake peer
 *
 * `_pull-door.mjs` builds its express app inside `openPullDoor`, and every route it does not know answers `404 { error }` with
 * NO `code` - which is, on purpose, exactly what an older peer answers for a route it lacks (`route_missing`). A snapshot route
 * added to it would be an edit of a helper other slices use (`_b81b-wire.mjs` says the same), and the default has to stay a
 * route that is missing. So this puts a small HTTP server in front of the fake peer: the snapshot route is answered by the case
 * (`peer.snapshot = (ask) => ({ status, body })`; unset, the proxy forwards it to the fake peer, which 404s without a code),
 * everything else is forwarded untouched, and every request is logged in arrival order so "asked after the pull, before the
 * files leg" and "never asked" are read off what the peer saw.
 *
 * Usage: `const peer = await openSnapshotPeer(door); ... await peer.close();` (`close` puts the member's url back).
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { privateHostAddress } from './_private-address.mjs';
import { elapse } from '../_shared/sleep.mjs';

export const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** The cap a snapshot may not exceed: the JSON body limit, 10 MiB of UTF-8 bytes (design 3.4, P1: bytes, never `length`). */
export const TEN_MIB = 10 * 1024 * 1024;

/**
 * A snapshot as the server writes it: `canonicalJson({ format: 1, typeSchemas, rules })` and its sha256 (the fingerprint), by the
 * server's own canonical function, so a case that wants a served text to verify builds it here and one that wants it refused
 * edits it afterwards. `typeSchemas` takes the stored shape (`{ entity: { project: { propertySchemas: {...} } } }`).
 */
export async function snapshotOf({ typeSchemas = {}, rules = {} } = {}) {
  const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
  const text = canonicalJson({ format: 1, typeSchemas, rules });
  return { text, fp: sha256(text) };
}

/** A distinct valid schema per label: the label names the one type, so two labels never give one fingerprint. */
export const snapshotNamed = (label) => snapshotOf({ typeSchemas: { entity: { [label]: { propertySchemas: { note: { type: 'string' } } } } } });

/** `links` as the design writes them: `{ own, layers: [{ networkId, fp }], served: [{ networkId, fp }] }`. */
export const linksOf = (own, layers = [], served = []) => ({ own, layers, served });

/** A row of `<space>_schema_snapshots` (Q-735: `_id` = fingerprint; `origin` own | layer | fetched; `networkId` on a layer row; `from` on a fetched one). */
export const snapshotRow = ({ fp, text, origin = 'own', networkId, from, links = null, at = '2026-11-12T00:00:00.000Z' }) => ({
  _id: fp, text, origin, ...(networkId ? { networkId } : {}), ...(from ? { from } : {}), links, at,
});

/** The private collection of a space (`SPACE_COLLECTIONS.schemaSnapshots`). */
export const snapshotsOf = (mongo, spaceId) => mongo.col(`${spaceId}_schema_snapshots`);

/**
 * A fact a peer wrote under the schema `fp`: the smallest `IncomingFactDoc` plus the stamp. Whether the receiver keeps the stamp
 * is Q-737's question (it declares it on the four Incoming schemas); here it is the record that OWES the snapshot.
 */
export const stampedFact = (build, space, id, seq, fp) => build.fact(space, id, seq, { schemaFingerprint: fp });

/**
 * Open the snapshot peer in front of a pull door's fake peer and point the door's member at it.
 *
 * `peer.snapshot` is `({ n, fp, spaceId, networkId, query }) => { status?, body?, delayMs?, chunked?, headers? } | undefined`
 * (`n` counts the snapshot requests since `reset`); `body` is JSON (an object, or a string written as given when `raw` is set).
 * `peer.requests` is every snapshot request, `peer.log` every request of any route in arrival order.
 */
export async function openSnapshotPeer(door) {
  const host = privateHostAddress();
  const target = new URL(door.url);
  const originalUrl = door.member().url;
  const peer = { snapshot: null, requests: [], log: [], url: '', reset, close };
  function reset() { peer.snapshot = null; peer.requests.length = 0; peer.log.length = 0; }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const asked = new URL(req.url, 'http://proxy.invalid');
      peer.log.push({ method: req.method, path: asked.pathname, query: Object.fromEntries(asked.searchParams) });
      if (asked.pathname === '/api/sync/schema-snapshot' && req.method === 'GET' && peer.snapshot) {
        const query = Object.fromEntries(asked.searchParams);
        const ask = { n: peer.requests.length + 1, fp: query.fp, spaceId: query.spaceId, networkId: query.networkId, query, headers: req.headers };
        peer.requests.push(ask);
        const answer = (await peer.snapshot(ask)) ?? { status: 404, body: { error: 'scripted: nothing' } };
        if (answer.delayMs) await elapse(answer.delayMs, 'simulated latency: a peer that is slow to answer a snapshot');
        const payload = Buffer.from(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}), 'utf8');
        const headers = { 'content-type': 'application/json', ...(answer.headers ?? {}) };
        if (!answer.chunked) headers['content-length'] = String(payload.length);
        res.writeHead(answer.status ?? 200, headers);
        if (answer.chunked) { for (let i = 0; i < payload.length; i += 65536) res.write(payload.subarray(i, i + 65536)); }
        res.end(answer.chunked ? undefined : payload);
        return;
      }
      const headers = { ...req.headers, host: target.host };
      const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.end(Buffer.concat(chunks));
    });
  });
  // own-listener: the engine's peer client refuses loopback, so the proxy binds the LAN address the fake peer does.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  peer.url = `http://${host}:${server.address().port}`;
  door.member().url = peer.url;
  async function close() {
    door.member().url = originalUrl;
    await new Promise(r => server.close(r));
  }
  return peer;
}

/** The value of `ythril_schema_snapshot_total{outcome=...}` (Q6: one family, one label), 0 while the series is absent. */
export async function snapshotCount(outcome) {
  const { register } = await import('../../server/dist/metrics/registry.js');
  let total = 0;
  for (const line of (await register.metrics()).split('\n')) {
    const m = /^ythril_schema_snapshot_total\{([^}]*)\}\s+(\S+)$/.exec(line);
    if (m && m[1].includes(`outcome="${outcome}"`)) total += Number(m[2]);
  }
  return total;
}
