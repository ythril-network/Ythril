/**
 * Starting a sync cycle from a request, once, for every door that offers it.
 *
 * ## Why this exists
 *
 * Three routes trigger a sync and they had drifted into three different answers to the same questions.
 * `POST /api/networks/:id/sync` could only fire and forget, and swallowed the cycle's failure with a bare
 * `void`. `POST /api/notify/trigger` grew `wait`, `timeoutMs` and `peerId`, and accepted ANY valid token
 * for as long as it did — the guard was wrong because the ROUTER was wrong, and the router was wrong
 * because a sync trigger had been put on the peer notification channel.
 *
 * Owner, 2026-09-09: *"merge if the goal is the same. then use the strong sides of each."* The goal is the
 * same. The strong sides are the existence check and the global limiter from the networks route, and
 * `wait` / `timeoutMs` / a peer subject from the trigger. This module is where they meet, so a fourth door
 * cannot invent a fourth set of semantics.
 *
 * ## What it deliberately keeps different between the two subjects
 *
 * A NETWORK cycle races a timeout because it can span many peers and a stuck one would hang the request.
 * A PEER cycle does not: it is bounded by that peer's own request timeouts, and racing it would report a
 * timeout for something already bounded. That asymmetry is real and is preserved here rather than
 * flattened into one code path that pretends the two are the same shape.
 *
 * ## Why every answer carries `ok` as well as `status`
 *
 * `ok` is the one-bit summary and `status` is the detail. It is not redundancy: the UI's "Sync now" button
 * reads `r.ok` to colour a banner, and `POST /api/networks/:id/sync` used to answer `{ ok: true }` and
 * nothing else. Dropping it while enriching the response would have made every SUCCESSFUL sync render as
 * "failed" — caught by reading the consumer, not by any test, because the client types the field it wants
 * and an absent one is merely `undefined`. Any integrator reading `ok` on either door is in the same
 * position.
 *
 * ## The failure that has to survive refactoring
 *
 * The cycle OUTLIVES the response on the fire-and-forget path. A rejection therefore has nowhere to go
 * unless something catches it — and when `/api/networks/:id/sync` did not, a failed sync from the UI's
 * "Sync now" button produced no log line, no audit entry, an `ok: true` already sent, and an unhandled
 * rejection at the process level. Every path below attaches a `.catch`, which is the whole reason a
 * fire-and-forget helper is worth having rather than two lines at each call site.
 */
import type { Response } from 'express';
import { log } from '../util/log.js';

/** Distinguishes "the race timed out" from "the cycle threw", which need different status codes. */
const TIMEOUT = Symbol('sync-trigger-timeout');

/** The `?timeoutMs` bound: caller's value, clamped, defaulting to 30s. */
export function syncTimeoutMs(raw: unknown): number {
  return Math.min(Math.max(parseInt(String(raw ?? ''), 10) || 30_000, 1_000), 120_000);
}

/**
 * Run a cycle for ONE NETWORK and answer the request.
 *
 * `wait` false answers `triggered` immediately and logs any later failure. `wait` true races the cycle
 * against `timeoutMs` and answers `completed`, `timeout` (504, still running) or `error` (500).
 */
export async function triggerNetworkSync(
  res: Response, networkId: string, opts: { wait: boolean; timeoutMs: number },
): Promise<void> {
  const { runSyncForNetwork } = await import('./engine.js');

  if (!opts.wait) {
    void runSyncForNetwork(networkId)
      .catch(err => log.error(`Triggered sync for network ${networkId} failed: ${err}`));
    res.json({ ok: true, status: 'triggered', networkId });
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT), opts.timeoutMs);
  });
  try {
    const r = await Promise.race([runSyncForNetwork(networkId), timeout]);
    res.json({ ok: true, status: 'completed', networkId, synced: r.synced, errors: r.errors });
  } catch (err) {
    if (err === TIMEOUT) {
      // 504 and NOT an error: the cycle is still running, and saying "failed" would send an operator
      // looking for a fault that does not exist.
      res.status(504).json({ ok: false, status: 'timeout', networkId, timeoutMs: opts.timeoutMs });
    } else {
      log.error(`Synchronous trigger for network ${networkId} failed: ${err}`);
      res.status(500).json({ ok: false, status: 'error', networkId, error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a cycle for ONE PEER, across every network it belongs to, and answer the request.
 *
 * No timeout race — see the note at the top of this file. `networksSynced` rather than `synced`, because
 * the unit a peer cycle reports is networks touched.
 */
export async function triggerPeerSync(
  res: Response, peerId: string, opts: { wait: boolean },
): Promise<void> {
  const { runSyncForPeer } = await import('./engine.js');

  if (!opts.wait) {
    void runSyncForPeer(peerId).catch(err => log.error(`Triggered sync for peer ${peerId} failed: ${err}`));
    res.json({ ok: true, status: 'triggered', peerId });
    return;
  }
  try {
    const r = await runSyncForPeer(peerId);
    res.json({ ok: true, status: 'completed', peerId, networksSynced: r.networksSynced, errors: r.errors });
  } catch (err) {
    log.error(`Synchronous trigger for peer ${peerId} failed: ${err}`);
    res.status(500).json({ ok: false, status: 'error', peerId, error: err instanceof Error ? err.message : String(err) });
  }
}
