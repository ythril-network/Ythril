/**
 * Embedding (portal / iframe) origin allowlist.
 *
 * Cross-origin embedding is OFF by default. An operator opts in by listing exact
 * origins under `embed.allowedOrigins` in config.json, which grants those
 * origins two rights together:
 *
 *   1. permission to frame Ythril  (CSP `frame-ancestors`), and
 *   2. permission to push runtime theme tokens (`ythril:theme` postMessage).
 *
 * Both are deliberately gated behind the SAME list: an origin you trust to render
 * Ythril inside its chrome is exactly the origin you trust to restyle it. Framing is
 * a clickjacking primitive and theming can be used to spoof UI, so the integrator is
 * accepting responsibility for every origin they add here.
 *
 * Validation is strict and fail-closed — an entry that is not an exact, scheme-
 * qualified, path-less origin is dropped with a warning rather than being coerced:
 *   - must parse as a URL and have a real host
 *   - must be `https:` (or `http:` on localhost/127.0.0.1, for development)
 *   - must carry no path, query, fragment, or credentials
 *   - `*` (and any wildcard) is never accepted — there is no "allow everything" mode
 */

import { getConfig } from './loader.js';
import { log, peerText, peerList } from '../util/log.js';

/** True if `raw` is an exact, scheme-qualified origin we are willing to trust. */
export function isValidEmbedOrigin(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value || value.includes('*')) return false; // no wildcards, ever

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  // No path/query/fragment — an origin is scheme + host + port and nothing else.
  // (The URL parser normalises a bare origin's pathname to '/'.)
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return false;
  // Reject a trailing path the parser would have swallowed, e.g. "https://a.com/x".
  if (value.replace(/\/$/, '') !== url.origin) return false;

  const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isLocalDev) return true;
  return false;
}

/**
 * The validated list of origins allowed to embed and theme this instance.
 * Returns `[]` when the operator has not opted in (the default).
 */
export function getAllowedEmbedOrigins(): string[] {
  let configured: unknown;
  try {
    configured = getConfig().embed?.allowedOrigins;
  } catch {
    return []; // config not loaded yet (pre-setup) — same-origin only
  }
  if (!Array.isArray(configured) || configured.length === 0) return [];

  const valid: string[] = [];
  for (const entry of configured) {
    if (isValidEmbedOrigin(entry)) {
      // Normalise to the canonical origin so the CSP header and the postMessage
      // check compare identical strings.
      valid.push(new URL(entry.trim()).origin);
    } else {
      log.warn(
        `embed.allowedOrigins: ignoring invalid entry ${peerText(JSON.stringify(entry))} — ` +
        `expected an exact https origin with no path (e.g. "https://portal.example.com"); ` +
        `wildcards are not supported.`,
      );
    }
  }
  return [...new Set(valid)];
}

/** The `frame-ancestors` source list for the CSP header — always includes 'self'. */
export function frameAncestorsDirective(): string {
  const origins = getAllowedEmbedOrigins();
  return ["'self'", ...origins].join(' ');
}

/** Log once at startup so an operator can see that cross-origin embedding is enabled. */
export function warnIfEmbeddingEnabled(): void {
  const origins = getAllowedEmbedOrigins();
  if (origins.length === 0) return;
  log.warn(
    `EMBEDDING ENABLED: cross-origin framing and runtime theming are permitted for ` +
    `${peerList(origins)}. These origins can iframe this instance and restyle its UI. ` +
    `Ensure you control them.`,
  );
}
