/**
 * How long the HTTP server keeps an idle keep-alive connection open (`Q-73`).
 *
 * Node's default is 5 s, and it checks that timer BEFORE it reads what arrived on the socket. So after the event loop
 * was blocked for a few seconds — a text job, a large parse — the server woke, found a pooled connection idle past
 * 5 s by its own clock, and closed it with a request the client had already sent on it: "other side closed" for the
 * caller, nothing in the log. Every client pools with an idle limit of its own (undici 4 s), and a reverse proxy
 * holds upstream connections for much longer, so the server must be the side that gives up LAST.
 *
 * 95 s sits above the common proxy defaults for idle upstream connections — Traefik 90 s, nginx 60 s — and far above
 * any client's pool. A proxy set to hold idle connections longer than this reopens the same race; the hosting guide
 * says so.
 */
import type { Server } from 'node:http';

export const KEEP_ALIVE_TIMEOUT_MS = 95_000;

export function configureConnections(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
}
