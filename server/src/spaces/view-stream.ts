/**
 * Does a live stream on a personal view still hold: is its owner still who it was, and does the view still read what it read (Q-531)?
 *
 * A stream on a view is opened with a snapshot: the token that opened it, the view, and the spaces the view read for that token then. Any of
 * the three can change while it is open - the token revoked or expired, the view deleted or its members changed, the token's rights
 * narrowed - and a stream that went on delivering changes of a space the view no longer reads would be a way round all of them. So the
 * stream asks this at each event. Apart from the token's expiry, which passes with no write and is compared at every event, a config
 * write is the only thing that can change the answer: the question is cheap (an expiry and a generation compare) unless a write happened
 * since the last answer, and then it is recomputed from the stored token and view exactly as the door resolved them. When it no longer holds the stream ENDS and the client reconnects and recomputes; no rights bus is invented.
 */
import { configWriteGeneration, getConfig } from '../config/loader.js';
import { tokenIsLive } from '../auth/token-liveness.js';
import { peerBoundTo } from '../auth/peer-bound.js';
import { isOidc } from '../auth/oidc-caller.js';
import { resolveOwnView, viewOwnerOf, viewReadMembers, type ViewOwnerSource } from '../config/views.js';
import type { TokenRights } from '../config/rights-shape.js';

export interface ViewStreamSnapshot {
  /** The token record the stream was opened with (a PAT row, or an OIDC session). */
  token: ViewOwnerSource & { rights?: TokenRights | null };
  viewId: string;
  /** The spaces the view read when the stream opened. */
  spaces: readonly string[];
}

/**
 * A checker bound to one stream: `holds()` answers whether the stream may go on. Remembers the config generation it last judged, so an
 * unrelated event costs a number compare.
 */
export function viewStreamGuard(snapshot: ViewStreamSnapshot): { holds(): boolean } {
  let judgedAt = configWriteGeneration();
  const opened = [...snapshot.spaces].sort();
  /** The expiry of the token as last judged: expiry is not a config write, so the generation compare alone would never see it pass. */
  const expiryOf = (stored: { expiresAt?: string | null } | undefined): { expiresAt: string | null } =>
    ({ expiresAt: stored?.expiresAt ?? (snapshot.token as { expiresAt?: string | null }).expiresAt ?? null });
  let expiry = expiryOf(getConfig().tokens.find(t => t.id === snapshot.token.id));
  return {
    holds(): boolean {
      if (!tokenIsLive(expiry)) return false;
      const generation = configWriteGeneration();
      if (generation === judgedAt) return true;
      const cfg = getConfig();
      // A stored token must still exist and be live; an OIDC session has no stored row and is judged by the identity it carried.
      const stored = cfg.tokens.find(t => t.id === snapshot.token.id);
      expiry = expiryOf(stored);
      const isSession = isOidc(snapshot.token);
      if (!isSession && (!stored || !tokenIsLive(stored))) return false;
      const owner = viewOwnerOf(snapshot.token);
      const view = resolveOwnView(owner, snapshot.viewId, cfg);
      if (!view) return false;
      const rights = (stored?.rights ?? snapshot.token.rights) ?? undefined;
      const now = viewReadMembers({ rights, view, area: 'knowledge', needs: 'read', peerId: peerBoundTo(stored ?? snapshot.token), config: cfg }).sort();
      if (now.length !== opened.length || now.some((id, i) => id !== opened[i])) return false;
      judgedAt = generation;
      return true;
    },
  };
}
