/**
 * The shape of one stored audit row.
 *
 * ## Why it lives here and not in `config/types.ts`
 *
 * It was there, and `no-new-god-files.test.js` refused the one-line addition that would have made it 580 code
 * lines with the reason this file exists: *"the failure mode of a god-file is not its size on any given day — it
 * is that every change lands in the same place because that is where the code already is."* An audit row is not
 * configuration. It was in the config types only because that file was where types went.
 *
 * Moving it took 34 lines OUT of a frozen file rather than adding one to it, and there was exactly one importer
 * plus one gate to repoint — which is the argument for doing it at the moment the ratchet asks rather than
 * raising the number.
 */

export interface AuditLogEntry {
  _id: string;
  timestamp: string;       // ISO8601
  _expireAt?: Date;        // BSON Date for TTL index — set at write time
  /**
   * The `X-Request-Id` of the request that produced this entry — the value that joins this row to the server
   * log lines the same request wrote.
   *
   * OPTIONAL because entries written before this field existed do not have it, and that is the only reason.
   * Every audit entry has a request behind it, so an absent id means "this row predates the field" and never
   * "no request" — anything rendering it has to say which, or a blank reads as an answer.
   */
  requestId?: string;
  tokenId: string | null;
  tokenLabel: string | null;
  authMethod: 'pat' | 'oidc' | null;
  oidcSubject: string | null;
  ip: string;
  method: string;          // HTTP method
  path: string;            // request path
  spaceId: string | null;
  operation: string;       // structured event name
  status: number;          // HTTP status code
  entryId: string | null;
  durationMs: number;
  /** The spaces a read through a personal view read; such an entry has `spaceId: null` (Q-531). */
  spaces?: string[];
  /** A personal view's lifecycle row: its owner key and member count, never its name or members (Q-531). */
  view?: { ownerKey: string; memberCount: number };
  /**
   * What the request actually changed, when the operation has an allowlist in `audit/audit-changes.ts`.
   *
   * Absent for everything else, by design: an operation with no allowlist records nothing, so a route
   * added later is silent rather than leaking. Values are scalars only — see that module for why a
   * denylist would be the wrong shape here.
   */
  changes?: { field: string; from?: string | number | boolean | null; to?: string | number | boolean | null }[];
}
