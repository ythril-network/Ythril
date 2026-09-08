/**
 * Express middleware that captures audit log entries for authenticated API
 * requests.  Installed globally in app.ts, it runs after the auth middleware
 * has resolved the token and after the response finishes.
 *
 * Write and admin operations are always logged.
 * Read operations are logged only when `audit.logReads` is enabled.
 */

import type { Request, Response, NextFunction } from 'express';
import { logAuditEntry } from './audit.js';
import { auditChanges } from './audit-changes.js';
import { getConfig } from '../config/loader.js';
import { classifyOperation, recordSpaceCall } from '../metrics/space-activity.js';
import { currentRequestId } from '../util/log.js';
import type { OidcTokenRecord } from '../auth/oidc.js';

// ── Operation mapping ──────────────────────────────────────────────────────

export interface RouteRule {
  method: string;
  pattern: RegExp;
  operation: string;
  /** Extract spaceId from the path match groups */
  spaceGroup?: number;
  /** Extract entryId from the path match groups */
  entryGroup?: number;
  /** If true, this is a read operation (only logged when logReads is on) */
  read?: boolean;
}

export const ROUTE_RULES: RouteRule[] = [
  // ── Memory CRUD ──────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/memories$/,   operation: 'memory.create',  spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/memories\/([^/]+)$/, operation: 'memory.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/memories\/([^/]+)$/, operation: 'memory.delete', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/memories$/,   operation: 'memory.delete',  spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/memories/,    operation: 'memory.list',    spaceGroup: 1, read: true },

  // ── Entity CRUD ──────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities\/([^/]+)\/merge\/([^/]+)$/, operation: 'entity.merge', spaceGroup: 1, entryGroup: 2 },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities$/,   operation: 'entity.create',  spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities\/([^/]+)$/, operation: 'entity.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities\/([^/]+)$/, operation: 'entity.delete', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities$/,   operation: 'entity.delete',  spaceGroup: 1 },
  // `F-17`: the cascade PREVIEW, before the generic entities GET below it — order matters here, since that
  // one has no `$` and would swallow this path as a list.
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities\/([^/]+)\/cascade-preview$/, operation: 'entity.cascade_preview', spaceGroup: 1, entryGroup: 2, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities/,    operation: 'entity.list',    spaceGroup: 1, read: true },

  // ── Edge CRUD ────────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges$/,      operation: 'edge.create',    spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges\/([^/]+)$/, operation: 'edge.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges\/([^/]+)$/, operation: 'edge.delete', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges$/,      operation: 'edge.delete',    spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges/,       operation: 'edge.list',      spaceGroup: 1, read: true },

  // ── Links ────────────────────────────────────────────────────────────────
  // No `link.list`: links are read through `/query` like any other collection, so the read is already
  // audited under that route rather than under a second one that does not exist.
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/links\/convert-preflight$/, operation: 'link.convert_preflight', spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/links$/,      operation: 'link.create',    spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/links\/([^/]+)$/, operation: 'link.delete', spaceGroup: 1, entryGroup: 2 },

  // ── Chrono CRUD ──────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono$/,     operation: 'chrono.create',  spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.delete', spaceGroup: 1, entryGroup: 2 },
  // Bulk chrono delete had no rule — memories/entities/edges all had one, chrono did not.
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono$/,     operation: 'chrono.delete',  spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono/,      operation: 'chrono.list',    spaceGroup: 1, read: true },

  // ── File operations ──────────────────────────────────────────────────────
  //
  // NOTE: the file routes put the path in the QUERY STRING (`/api/files/:spaceId?path=…`),
  // and this middleware strips the query before matching. The rules here previously required
  // a trailing slash after the space segment (`/api/files/([^/]+)\/`) and, for upload, an
  // `/upload` segment that has never existed — so they matched NOTHING and every file upload,
  // delete and move went completely UNAUDITED. Anchor on the space segment instead.
  { method: 'POST',   pattern: /^\/api\/files\/([^/]+)\/mkdir$/,                   operation: 'file.mkdir',     spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/files\/([^/]+)\/retry_embedding$/,         operation: 'file.retry_embedding', spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/files\/([^/]+)$/,                          operation: 'file.create',    spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/files\/([^/]+)$/,                          operation: 'file.delete',    spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/files\/([^/]+)$/,                          operation: 'file.update',    spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/files\/([^/]+)$/,                          operation: 'file.read',      spaceGroup: 1, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/files/,       operation: 'file.list',      spaceGroup: 1, read: true },
  // File METADATA mutations live on the brain router and had no rules at all.
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/files$/,      operation: 'file.meta.delete', spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/files$/,      operation: 'file.meta.update', spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/reindex$/,    operation: 'space.reindex',  spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/brain\/spaces\/([^/]+)\/embedding-queue\/media\/retry-failed$/, operation: 'file.retry_embedding_all', spaceGroup: 1 },
  // A record retry is audited because it is the operator saying "embed this again" about a record that already gave
  // up, and the snapshot is the only place the failure it was retried FROM survives: a successful retry clears
  // `lastError`, so without this row the reason the job failed is gone the moment someone fixes it.
  { method: 'POST',   pattern: /^\/api\/brain\/spaces\/([^/]+)\/embedding-queue\/records\/retry$/, operation: 'brain.retry_embedding', spaceGroup: 1 },

  // ── Space operations ─────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/spaces$/,                                  operation: 'space.create' },
  { method: 'POST',   pattern: /^\/api\/spaces\/reorder$/,                         operation: 'space.reorder' },
  // A rename is `PATCH /api/spaces/:id/rename`, which the anchored `…/([^/]+)$` rule below
  // does not match — so space renames were unaudited. Given a rename can hide a space's data
  // if it goes wrong (see the stale-spaceId fixes), that is exactly the operation you want a
  // record of. It must be listed BEFORE the generic space.update rule so it wins.
  { method: 'PATCH',  pattern: /^\/api\/spaces\/([^/]+)\/rename$/,                 operation: 'space.rename',   spaceGroup: 1 },
  // Clearing a space's recorded usage. Audited because the panel reads zero either way afterwards, so nothing
  // on screen distinguishes a reset from a genuinely idle space — and an operator asking "was this reset, or has
  // it really been quiet?" has no other place to look. The deleted count is in the snapshot.
  { method: 'POST',   pattern: /^\/api\/spaces\/([^/]+)\/activity\/reset$/,          operation: 'space.activity.reset', spaceGroup: 1 },
  // Rebuilding vector indexes leaves recall returning empty until the build finishes, so it is an
  // availability-affecting admin action and belongs in the trail alongside rename and wipe.
  { method: 'POST',   pattern: /^\/api\/spaces\/([^/]+)\/rebuild-indexes$/,        operation: 'space.indexes.rebuild', spaceGroup: 1 },
  // Audited even though it only queues work: it changes what a space is findable BY, which is the same class of
  // change as a rebuild, and it is the action an operator takes after turning suppression off. "Who un-suppressed
  // this space and when" is answerable from the meta write; "who then backfilled it" needs this row.
  { method: 'POST',   pattern: /^\/api\/spaces\/([^/]+)\/reembed$/,                 operation: 'space.embeddings.reembed', spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/spaces\/([^/]+)$/,                         operation: 'space.update',   spaceGroup: 1 },
  // There was no PUT rule in the entire table, so every schema write was unaudited.
  { method: 'PUT',    pattern: /^\/api\/spaces\/([^/]+)\/schema$/,                 operation: 'space.schema.update', spaceGroup: 1 },
  { method: 'PUT',    pattern: /^\/api\/spaces\/([^/]+)\/meta\/typeSchemas\//,     operation: 'space.schema.update', spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/spaces\/([^/]+)\/meta\/typeSchemas\//,     operation: 'space.schema.delete', spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/spaces\/([^/]+)$/,                         operation: 'space.delete',   spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/admin\/spaces\/([^/]+)\/wipe$/,            operation: 'space.wipe',     spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/spaces/,                                   operation: 'space.list',     read: true },

  // ── Token operations ─────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/tokens$/,                                  operation: 'token.create' },
  { method: 'DELETE', pattern: /^\/api\/tokens\/([^/]+)$/,                         operation: 'token.delete' },
  { method: 'PATCH',  pattern: /^\/api\/tokens\/([^/]+)$/,                         operation: 'token.update' },

  { method: 'POST',   pattern: /^\/api\/tokens\/([^/]+)\/regenerate$/,             operation: 'token.regenerate' },

  // ── Sync trigger ─────────────────────────────────────────────────────────
  // `/api/notify` as a whole is exempt in `audit-route-coverage` as "peer notifications + the admin
  // sync trigger — not a data mutation". The peer half is right; the trigger half is not. A sync cycle
  // pulls records from peers and writes them locally, so "who started the run that brought in these
  // records" is a question the log should answer. Only the specific admin route is matched — peer
  // notifications stay out.
  { method: 'POST',   pattern: /^\/api\/notify\/trigger$/,                        operation: 'sync.trigger' },

  // ── MFA ──────────────────────────────────────────────────────────────────
  // Both of these were unaudited, exempted by an entry in `audit-route-coverage` reading "covered by its
  // own auth events". There is exactly one auth event in the whole map — `auth.failed` — so nothing was
  // covering them, and turning off the second factor for every admin mutation left no trace at all.
  //
  // `setup` writes the new secret immediately (the confirm-with-a-code step is client-side), so it IS the
  // enable, and it is also the ROTATE when MFA is already on. One operation name for both: the audit entry
  // records that the secret changed, which is what a reader needs — and distinguishing them would require
  // reading state the middleware does not have.
  { method: 'POST',   pattern: /^\/api\/mfa\/setup$/,                              operation: 'mfa.enable' },
  { method: 'DELETE', pattern: /^\/api\/mfa$/,                                     operation: 'mfa.disable' },

  // ── Audit log export ─────────────────────────────────────────────────────
  // NOT marked `read: true`. Every other read is gated behind `logReads`, which is off by default because one
  // entry per list call would bury the record. Taking a COPY of the entire who-did-what history is not that kind
  // of read: it is the act itself, and an instance that only logs it when an operator happens to have opted into
  // logging reads would not record the one read that matters most.
  { method: 'GET',    pattern: /^\/api\/admin\/audit-log\/export$/,                 operation: 'audit.export' },

  // ── Webhook operations ───────────────────────────────────────────────────
  // These rules used to point at `/api/notify/webhooks`, but the router is mounted at
  // `/api/admin/webhooks` — so webhook CRUD was entirely unaudited. A webhook exfiltrates
  // data to a third party on every change, so creating one is exactly what you want logged.
  { method: 'POST',   pattern: /^\/api\/admin\/webhooks$/,                          operation: 'webhook.create' },
  { method: 'POST',   pattern: /^\/api\/admin\/webhooks\/([^/]+)\/test$/,           operation: 'webhook.test' },
  { method: 'PATCH',  pattern: /^\/api\/admin\/webhooks\/([^/]+)$/,                 operation: 'webhook.update' },
  { method: 'DELETE', pattern: /^\/api\/admin\/webhooks\/([^/]+)$/,                 operation: 'webhook.delete' },

  // ── Network / governance operations ──────────────────────────────────────
  // NONE of this was audited. It is the most security-sensitive surface in the product:
  // adding or removing a member changes who can read the brain, and votes decide it.
  { method: 'POST',   pattern: /^\/api\/networks$/,                                 operation: 'network.create' },
  { method: 'POST',   pattern: /^\/api\/networks\/join-remote$/,                    operation: 'network.join_remote' },
  { method: 'PATCH',  pattern: /^\/api\/networks\/([^/]+)$/,                        operation: 'network.update' },
  { method: 'DELETE', pattern: /^\/api\/networks\/([^/]+)$/,                        operation: 'network.delete' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/members$/,               operation: 'network.member.add' },
  { method: 'DELETE', pattern: /^\/api\/networks\/([^/]+)\/members\/([^/]+)$/,      operation: 'network.member.remove' },

  // ── The invite handshake ──────────────────────────────────────────────────
  //
  // Both of these were unaudited, exempted by an entry in `audit-route-coverage` reading "network invite
  // handshake — peer-facing". That reason is true about WHO CALLS them and irrelevant to WHAT THEY CHANGE, which
  // is the distinction the `/api/notify/trigger` carve-out above already makes: a sync cycle writes peer records
  // locally, so it is audited even though a peer triggers it.
  //
  // `finalize` calls `saveConfig` — it is the moment another instance BECOMES A MEMBER of a network on this
  // instance, or is held for a join vote. That is the most consequential local mutation in the whole flow, and it
  // left no trace. `generate` is an instance admin producing the material that makes it possible, which is a user
  // action with a security consequence by any reading.
  //
  // `apply` stays exempt and its narrowed reason says why: it registers an in-memory handshake session and
  // writes nothing. The exemption is now on that path rather than the whole prefix, so a fourth route added here
  // is unaudited-and-refused rather than silently covered.
  { method: 'POST',   pattern: /^\/api\/invite\/generate$/,                          operation: 'network.invite.generate' },
  { method: 'POST',   pattern: /^\/api\/invite\/finalize$/,                          operation: 'network.member.join' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/members\/([^/]+)\/adopt$/, operation: 'network.member.adopt' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/members\/([^/]+)\/revert-parent$/, operation: 'network.member.revert_parent' },
  { method: 'PUT',    pattern: /^\/api\/networks\/([^/]+)\/members\/([^/]+)\/signing-key$/, operation: 'network.member.signing_key' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/votes\/([^/]+)$/,        operation: 'network.vote' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/invite$/,                operation: 'network.invite' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/join$/,                  operation: 'network.join' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/fork$/,                  operation: 'network.fork' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/reparent-self$/,         operation: 'network.reparent_self' },
  { method: 'POST',   pattern: /^\/api\/networks\/([^/]+)\/sync$/,                  operation: 'network.sync_trigger' },

  // ── Conflict resolution ──────────────────────────────────────────────────
  // Resolving a conflict picks a winning version of a record — a data mutation.
  { method: 'POST',   pattern: /^\/api\/conflicts\/bulk-resolve$/,                  operation: 'conflict.bulk_resolve' },
  { method: 'POST',   pattern: /^\/api\/conflicts\/seed$/,                          operation: 'conflict.seed' },
  { method: 'POST',   pattern: /^\/api\/conflicts\/([^/]+)\/resolve$/,              operation: 'conflict.resolve' },
  { method: 'DELETE', pattern: /^\/api\/conflicts\/link-violations\/?([^/]*)$/,     operation: 'conflict.link_violation.delete' },
  { method: 'DELETE', pattern: /^\/api\/conflicts\/([^/]+)$/,                       operation: 'conflict.delete' },

  // ── Duplicate handling ───────────────────────────────────────────────────
  // A merge REWRITES brain records (and deletes the loser) — squarely a data mutation.
  { method: 'POST',   pattern: /^\/api\/duplicates\/scan$/,                         operation: 'duplicate.scan' },
  { method: 'POST',   pattern: /^\/api\/duplicates\/([^/]+)\/merge$/,               operation: 'duplicate.merge' },
  { method: 'POST',   pattern: /^\/api\/duplicates\/([^/]+)\/dismiss$/,             operation: 'duplicate.dismiss' },
  { method: 'POST',   pattern: /^\/api\/duplicates\/([^/]+)\/reopen$/,              operation: 'duplicate.reopen' },
  // Contradiction review (F-REVIEW). Same shape as duplicates: reviewing a record-QA finding is a
  // decision about the knowledge base, so it belongs in the trail alongside the merge/dismiss actions.
  { method: 'POST',   pattern: /^\/api\/contradictions\/scan$/,                     operation: 'contradiction.scan' },
  { method: 'POST',   pattern: /^\/api\/contradictions\/([^/]+)\/dismiss$/,         operation: 'contradiction.dismiss' },
  { method: 'POST',   pattern: /^\/api\/contradictions\/([^/]+)\/reopen$/,          operation: 'contradiction.reopen' },
  { method: 'POST',   pattern: /^\/api\/contradictions\/([^/]+)\/resolve$/,         operation: 'contradiction.resolve' },


  // ── Schema library ───────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/schema-library$/,                           operation: 'schema_library.create' },
  { method: 'PUT',    pattern: /^\/api\/schema-library\/([^/]+)$/,                  operation: 'schema_library.update' },
  { method: 'DELETE', pattern: /^\/api\/schema-library\/([^/]+)$/,                  operation: 'schema_library.delete' },
  // The merge verb shares `schema_library.update` with PUT: both change what every space that `$ref`s the
  // entry validates against, which is the fact an auditor is looking for, and a reader filtering the log for
  // "who changed this schema" must not have to know which verb the caller happened to use. The change list
  // records what actually moved either way.
  //
  // `/publish` stays a separate operation because it changes visibility rather than content. The two patterns
  // cannot collide — `([^/]+)$` excludes a slash — so their order here is not load-bearing.
  { method: 'PATCH',  pattern: /^\/api\/schema-library\/([^/]+)$/,                  operation: 'schema_library.update' },
  { method: 'PATCH',  pattern: /^\/api\/schema-library\/([^/]+)\/publish$/,         operation: 'schema_library.publish' },
  { method: 'POST',   pattern: /^\/api\/schema-library\/catalogs$/,                 operation: 'schema_library.catalog.add' },
  { method: 'DELETE', pattern: /^\/api\/schema-library\/catalogs\/([^/]+)$/,        operation: 'schema_library.catalog.remove' },
  { method: 'POST',   pattern: /^\/api\/schema-library\/groups\/([^/]+)\/apply$/,   operation: 'schema_library.group.apply' },
  { method: 'POST',   pattern: /^\/api\/schema-library\/export-space$/,             operation: 'schema_library.export', read: true },

  // ── Config / admin ───────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/admin\/reload-config$/,                    operation: 'config.reload' },
  { method: 'PATCH',  pattern: /^\/api\/admin\/media-config$/,                     operation: 'config.media.update' },
  // Verify makes a REAL request to a configured model. Audited rather than exempted like the
  // `test-connection` probe beside it, whose exemption reads "mutates nothing" — true there, and not
  // true here. This one leaves the instance, costs money on a metered endpoint, and for the assist
  // target it exercises the acknowledged-egress path. Which admin triggered that, and when, is worth
  // having.
  { method: 'POST',   pattern: /^\/api\/admin\/media-config\/verify$/,              operation: 'config.media.verify' },
  // Who may frame and restyle this instance. Worth auditing more than most config: an added origin gains a
  // clickjacking primitive and a UI-spoofing one together, and the change is invisible from inside the product —
  // nothing in the admin UI looks different afterwards, so the log is the only place it leaves a trace.
  { method: 'PATCH',  pattern: /^\/api\/admin\/embed-config$/,                     operation: 'config.embed.update' },
  { method: 'POST',   pattern: /^\/api\/admin\/local-agent\/bootstrap$/,           operation: 'local_agent.bootstrap' },
  { method: 'POST',   pattern: /^\/api\/admin\/local-agent\/enable-networks\/execute$/, operation: 'local_agent.enable_networks' },

  // ── Data management ──────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/admin\/data\/backup$/,                     operation: 'data.backup' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/restore$/,                    operation: 'data.restore' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/migrate$/,                    operation: 'data.migrate' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/maintenance$/,                operation: 'data.maintenance.toggle' },
  { method: 'PUT',    pattern: /^\/api\/admin\/data\/backup-config$/,              operation: 'data.backup_config.update' },
  // A connection test does not mutate, but it does reach out to an operator-supplied URI.
  { method: 'POST',   pattern: /^\/api\/admin\/data\/config\/test$/,               operation: 'data.config.test', read: true },

  // ── Space schema dry-run (validates only, writes nothing) ────────────────
  { method: 'POST',   pattern: /^\/api\/spaces\/([^/]+)\/validate-schema$/,        operation: 'space.schema.validate', spaceGroup: 1, read: true },

  // ── Brain query / recall / stats (reads) ─────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/recall/,      operation: 'brain.recall',         spaceGroup: 1, read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/recall$/,                           operation: 'brain.recall_global',  read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/query$/,      operation: 'brain.query',          spaceGroup: 1, read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/find-similar$/, operation: 'brain.find_similar', spaceGroup: 1, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/stats$/,      operation: 'brain.stats',          spaceGroup: 1, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/er-model$/,   operation: 'brain.er_model',       spaceGroup: 1, read: true },

  // ── Bulk write ───────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/bulk$/,       operation: 'bulk.write',     spaceGroup: 1 },

  // ── Traverse ─────────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/traverse$/,   operation: 'brain.traverse', spaceGroup: 1, read: true },

  // ── SSE ticket mints (read-shaped: they mint a single-use ticket to WATCH a stream, no state
  //    change worth auditing; the streams themselves are reads) ──────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/events\/ticket$/, operation: 'brain.events.ticket', spaceGroup: 1, read: true },
  { method: 'POST',   pattern: /^\/api\/about\/logs\/ticket$/,                      operation: 'about.logs.ticket', read: true },
];

// Pre-group rules by HTTP method for O(1) method lookup instead of linear scan.
const RULES_BY_METHOD: ReadonlyMap<string, readonly RouteRule[]> = (() => {
  const map = new Map<string, RouteRule[]>();
  for (const rule of ROUTE_RULES) {
    let bucket = map.get(rule.method);
    if (!bucket) { bucket = []; map.set(rule.method, bucket); }
    bucket.push(rule);
  }
  return map;
})();

export function resolveOperation(method: string, path: string): { operation: string; spaceId: string | null; entryId: string | null; read: boolean } | null {
  const rules = RULES_BY_METHOD.get(method);
  if (!rules) return null;
  for (const rule of rules) {
    const m = rule.pattern.exec(path);
    if (!m) continue;
    return {
      operation: rule.operation,
      spaceId: rule.spaceGroup ? (m[rule.spaceGroup] ?? null) : null,
      entryId: rule.entryGroup ? (m[rule.entryGroup] ?? null) : null,
      read: rule.read ?? false,
    };
  }
  return null;
}

export function isOidc(token: unknown): token is OidcTokenRecord {
  return !!token && typeof token === 'object' && 'source' in token && (token as OidcTokenRecord).source === 'oidc';
}

// ── Middleware ──────────────────────────────────────────────────────────────

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  /*
   * CAPTURED HERE, not inside the callback below, and that is not a style choice.
   *
   * An EventEmitter listener is NOT bound to the async context it was registered in — `emit` runs it in the
   * emitter's context. Probed directly: a listener registered inside `AsyncLocalStorage.run` and fired on a
   * later tick reads `undefined`. So `currentRequestId()` called inside `res.on('finish')` would store `null` on
   * every entry while looking exactly like this line does. This middleware itself runs inside the request
   * context — it is mounted after the request-id middleware — so at THIS point the id is there.
   */
  const requestId = currentRequestId() ?? null;

  res.on('finish', () => {
    // Use originalUrl (strip query string) — req.path inside the 'finish'
    // callback reflects the router-relative path (e.g. "/general/memories"
    // instead of "/api/brain/general/memories") because Express strips the
    // mount prefix for sub-routers and the response finishes within that
    // router context.
    const fullPath = (req.originalUrl || req.url).split('?')[0];

    // Skip paths that are not API calls or are audit-log reads themselves
    if (!fullPath.startsWith('/api/') && !fullPath.startsWith('/mcp')) return;
    // Reading the log must not write to the log — one entry per page of every scroll is noise that would
    // eventually crowd out the record it is describing.
    //
    // The EXPORT is deliberately excluded from that exemption. Paging through the log on screen and taking a
    // copy of the entire who-did-what record are different acts, and the second is what someone covering their
    // tracks does first; exempting it by prefix meant the single most sensitive read of the audit log was the one
    // read it never recorded. A prefix skip also silently swallows any future sub-route added here, so it is now
    // an exact match on the paged endpoint.
    if (fullPath === '/api/admin/audit-log' || fullPath === '/api/admin/audit-log/') return;
    // Skip health / ready / metrics / theme / setup
    if (fullPath.startsWith('/api/theme') || fullPath.startsWith('/api/setup')) return;

    const matched = resolveOperation(req.method, fullPath);
    if (!matched) return; // not an operation we track

    const durationMsForActivity = Number(process.hrtime.bigint() - start) / 1e6;

    // ── Per-space usefulness counters ────────────────────────────────────────
    //
    // Counted here, BEFORE the `logReads` gate, because the counters must see reads: recall is the demand
    // signal that says whether a space is worth keeping, and it is a read. Doing it by turning `logReads` on
    // instead would write one audit document per recall — the per-request cost this deliberately avoids.
    //
    // Riding on this middleware rather than adding another means one path-matcher decides which space a call
    // touched, so a count and its audit trail can never describe different things. The whole hook is a Map
    // lookup plus a few integer adds: ~19 ns, measured.
    //
    // `recallOutcome` is stashed on the request by the recall handler, which is the only code that knows
    // whether the answer contained anything — and "did it answer" is what separates a useful space from one
    // that is merely asked a lot.
    if (matched.spaceId) {
      const cls = classifyOperation(matched.operation);
      if (cls) {
        recordSpaceCall(matched.spaceId, cls, {
          ms: durationMsForActivity,
          answered: req.recallOutcome?.answered,
          topScore: req.recallOutcome?.topScore,
        });
      }
    }

    // Check logReads config
    let cfg;
    try { cfg = getConfig(); } catch { /* pre-setup */ return; }
    if (matched.read && !cfg.audit?.logReads) return;

    const token = req.authToken;
    const authMethod: 'pat' | 'oidc' | null = token
      ? (isOidc(token) ? 'oidc' : 'pat')
      : null;

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    logAuditEntry({
      requestId,
      tokenId: token && 'id' in token ? token.id : null,
      tokenLabel: token?.name ?? null,
      authMethod,
      oidcSubject: isOidc(token) ? token.id.replace(/^oidc:/, '') : null,
      ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      method: req.method,
      path: fullPath,
      spaceId: matched.spaceId,
      operation: matched.operation,
      status: res.statusCode,
      entryId: matched.entryId,
      durationMs: Math.round(durationMs),
      // Only for a request that actually succeeded: a rejected PATCH changed nothing, and recording its
      // intended values would make the log claim an edit that never happened.
      ...(res.statusCode < 400 && req.auditSnapshots
        ? { changes: auditChanges(matched.operation, req.auditSnapshots.before, req.auditSnapshots.after) }
        : {}),
    });
  });

  next();
}

/** Log a failed auth attempt — called explicitly from auth middleware when needed. */
export function logAuthFailure(req: Request): void {
  const fullPath = (req.originalUrl || req.url).split('?')[0];
  logAuditEntry({
    // Read directly, not captured: this runs synchronously inside the request rather than in a listener, so
    // the context is live here. It is also the entry where the id matters most — a rejected credential is the
    // one thing an operator wants to trace back through the log line by line.
    requestId: currentRequestId() ?? null,
    tokenId: null,
    tokenLabel: null,
    authMethod: null,
    oidcSubject: null,
    ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    method: req.method,
    path: fullPath,
    spaceId: null,
    operation: 'auth.failed',
    status: 401,
    entryId: null,
    durationMs: 0,
  });
}

/**
 * How a caller authenticated, for an audit entry. Exported so the MCP dispatcher derives it the same way
 * this middleware does — MCP writes its own entries (it is not an HTTP route the rules can match), and a
 * second copy of this two-line derivation is how the two surfaces would come to disagree about identity.
 */
export function auditAuthMethod(token: unknown): 'pat' | 'oidc' | null {
  if (!token) return null;
  return isOidc(token) ? 'oidc' : 'pat';
}

/** The OIDC subject behind a token, or null for a PAT. */
export function auditOidcSubject(token: unknown): string | null {
  return isOidc(token) ? token.id.replace(/^oidc:/, '') : null;
}
