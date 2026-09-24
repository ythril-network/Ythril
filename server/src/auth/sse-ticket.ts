/**
 * Short-lived, single-use tickets for browser Server-Sent Events streams.
 *
 * The browser `EventSource` API cannot set an `Authorization` header, so SSE endpoints historically
 * accepted the bearer token in the URL query string (`?token=`). A token in a URL leaks into server and
 * proxy **access logs**, browser **history**, and the `Referer` header — a real credential-exposure
 * problem for a long-lived PAT. This module replaces that for the browser streams: the client first does
 * an authenticated `POST …/ticket` (normal `Authorization` header), receives an opaque single-use ticket,
 * and connects the stream with `?ticket=<t>`. The ticket is a transient alias for the bearer — the auth
 * layer exchanges it back to the bearer and resolves it exactly as a header would, so space-scope, MFA and
 * all downstream checks are unchanged; only the URL exposure is gone.
 *
 * Properties: opaque 256-bit CSPRNG value; ≤ TTL_MS lifetime; consumed on first use (single-use);
 * bound to the exact stream path it was minted for (so a brain-space ticket can't open another space's
 * stream or the admin log stream). In-memory + per-process: the browser mints and connects to the same
 * instance (same-origin), so no shared store is needed. NOT used for the `/mcp` transport, which is an
 * external-agent protocol with a different threat model (the agent already holds the token).
 */
import { randomBytes } from 'node:crypto';

/** Ticket lifetime. Long enough for the client to mint-then-connect (incl. a reconnect), short enough
 *  that a leaked ticket is near-useless. */
const TTL_MS = 60_000;

interface TicketEntry {
  /** The bearer this ticket aliases (PAT plaintext or OIDC JWT) — resolved normally on exchange. */
  bearer: string;
  /** The exact stream path the ticket is valid for, e.g. `/api/brain/spaces/work/events`. */
  path: string;
  /** Absolute expiry (ms epoch). */
  exp: number;
}

const tickets = new Map<string, TicketEntry>();

/** Drop expired entries. Cheap (called on mint); the map only holds unconsumed, unexpired tickets. */
function sweep(now: number): void {
  for (const [t, e] of tickets) {
    if (e.exp <= now) tickets.delete(t);
  }
}

/**
 * Mint a single-use ticket that aliases `bearer` for the stream at `path`. The caller must already be
 * authenticated for that path (the mint route runs the normal auth middleware first).
 */
export function mintSseTicket(bearer: string, path: string, now: number = Date.now()): { ticket: string; expiresInMs: number } {
  sweep(now);
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { bearer, path, exp: now + TTL_MS });
  return { ticket, expiresInMs: TTL_MS };
}

/**
 * Exchange a ticket back to its bearer, consuming it. Returns null (and consumes any match) when the
 * ticket is unknown, expired, or was minted for a different path. Single-use: a matched ticket is always
 * removed, so a replay finds nothing.
 */
export function consumeSseTicket(ticket: string, path: string, now: number = Date.now()): string | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // single-use — remove on any match, valid or not
  if (entry.exp <= now || entry.path !== path) return null;
  return entry.bearer;
}

