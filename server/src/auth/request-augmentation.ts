/**
 * The fields the server adds to Express's `Request` and `Locals`: a global augmentation, in a file of its own that imports only the two
 * record types its `authToken` names (bundle-270, Q-754).
 *
 * ## What it prevents
 *
 * The augmentation lived in `auth/middleware.ts`, so every module that reads one of these fields without reaching the guards (the audit
 * middleware reads `req.recallOutcome`, `req.auditSnapshots` and others on `res.finish`) had to name that whole module to compile, and the
 * type-only edge `audit/middleware.ts -> auth/middleware.ts` held 179 modules in the server's largest import cycle. A reader names this file
 * instead; it reaches nothing back.
 */
import type { TokenRecord } from '../config/types.js';
import type { OidcTokenRecord } from './oidc.js';

declare global {
  namespace Express {
    interface Request {
      authToken?: Omit<TokenRecord, 'hash'> | OidcTokenRecord;
      /**
       * The credential a guard resolved, set the moment it resolves and before the guard decides anything else. A guard that refuses
       * (a rung the token lacks, a space it does not reach, a second factor) answers before it attaches `authToken`, which means "let in", so the
       * audit row of a refused call read no token and said nobody called (Q-754 D1). The audit middleware names this one for the row; the
       * activity counters and every other reader still ask `authToken` alone.
       */
      resolvedToken?: Omit<TokenRecord, 'hash'> | OidcTokenRecord;
      resolvedSpaceId?: string;
      /**
       * The personal view a path-scoped READ door accepted for this caller, and the spaces it reads (`viewReadMembers`, in the route's area, at
       * request time). Set by the space guards; a handler reads its member loop from here and never from the view record.
       */
      viewRead?: { id: string; spaces: string[]; construct?: string };
      /**
       * The spaces a body-scoped route was AUTHORISED for, resolved once by `requireBodyScopedSpace`.
       *
       * A handler on such a route reads this and never `req.body.space`. Reading the body again is the
       * defect the whole mechanism exists to prevent: the two readings are spelled identically, so nothing
       * in a diff shows that the value acted on is not the value that was checked.
       */
      authorisedSpaces?: string[];
      /** Bearer exchanged from a single-use SSE ticket, cached so multiple auth middlewares in the same
       *  request (e.g. a router-level requireAuth + a route-level requireAdmin) don't each try to consume
       *  it. `null` means the ticket was invalid; `undefined` means not yet exchanged. */
      sseTicketBearer?: string | null;
      /**
       * Before/after snapshots a route offers the audit log, so the entry can say WHAT changed rather
       * than only that something did. The audit middleware runs on `res.finish` and cannot see resource
       * state, so the handler must hand it over.
       *
       * Handing them over does NOT publish them: `audit-changes.ts` reads only the fields allowlisted for
       * that operation and ignores everything else, so a handler may pass a whole record without auditing
       * its secrets.
       */
      auditSnapshots?: { before?: unknown; after?: unknown };
      /**
       * The entry's `changes` built EXPLICITLY by the act, for an act whose before and after snapshots differ in nothing the diff records (Review's
       * resolve: `kind`, `keep` and the parent are the same before and after, and the bodies are objects; Q-624 R12). Wins over `auditSnapshots`.
       */
      auditChangesExplicit?: Array<{ field: string; from?: string | number | boolean | null; to?: string | number | boolean | null }>;
      /**
       * The record a request acted on when the PATH cannot name it — a create has no id in its URL, and a create
       * whose record landed and whose connections then failed is still a write of that record (`Q-170`). Set by the
       * error handler that answers it; the audit middleware prefers it to the path's own.
       */
      auditEntryId?: string;
      /**
       * Whether a recall actually came back with something, and how good the best hit was.
       *
       * Set by the recall handler, read by the audit middleware on `res.finish` for the per-space usefulness
       * counters. It has to travel this way: only the handler knows what the answer contained, and only the
       * middleware knows how long the whole request took and which space it was attributed to.
       *
       * This is the field that separates a useful space from one that is merely asked a lot — a space queried
       * five hundred times that answers nothing looks identical to a popular one in a call count.
       */
      recallOutcome?: { answered: boolean; topScore?: number };
      /**
       * The tool door recorded this request's audit row (`restToolCaller`'s `onAudited`, Q-444), so the route rule writes none.
       * Set by the tool recorder, read by the audit middleware on `res.finish`.
       */
      auditedByTool?: boolean;
    }
    /** What a request's middleware hands the ones after it (`res.locals`). */
    interface Locals {
      /**
       * `attachToken` admitted this request to the token's OWN limiter (`tokenRateLimit`), so that limit bounds it; the limiter's own `429`
       * resets this to false. `ipFloodBackstop` gives such a request back to its count (Q-693) and counts every other.
       */
      meteredByToken?: boolean;
    }
  }
}

export {};
