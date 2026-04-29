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
import { getConfig } from '../config/loader.js';
import type { OidcTokenRecord } from '../auth/oidc.js';

// ── Operation mapping ──────────────────────────────────────────────────────

interface RouteRule {
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

const ROUTE_RULES: RouteRule[] = [
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
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/entities/,    operation: 'entity.list',    spaceGroup: 1, read: true },

  // ── Edge CRUD ────────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges$/,      operation: 'edge.create',    spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges\/([^/]+)$/, operation: 'edge.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges\/([^/]+)$/, operation: 'edge.delete', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges$/,      operation: 'edge.delete',    spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/edges/,       operation: 'edge.list',      spaceGroup: 1, read: true },

  // ── Chrono CRUD ──────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono$/,     operation: 'chrono.create',  spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.update', spaceGroup: 1, entryGroup: 2 },
  { method: 'DELETE', pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono\/([^/]+)$/, operation: 'chrono.delete', spaceGroup: 1, entryGroup: 2 },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/chrono/,      operation: 'chrono.list',    spaceGroup: 1, read: true },

  // ── File operations ──────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/files\/([^/]+)\/upload/,                   operation: 'file.create',    spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/files\/([^/]+)\//,                         operation: 'file.delete',    spaceGroup: 1 },
  { method: 'PATCH',  pattern: /^\/api\/files\/([^/]+)\//,                         operation: 'file.update',    spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/files\/([^/]+)\//,                         operation: 'file.read',      spaceGroup: 1, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/files/,       operation: 'file.list',      spaceGroup: 1, read: true },

  // ── Space operations ─────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/spaces$/,                                  operation: 'space.create' },
  { method: 'PATCH',  pattern: /^\/api\/spaces\/([^/]+)$/,                         operation: 'space.update',   spaceGroup: 1 },
  { method: 'DELETE', pattern: /^\/api\/spaces\/([^/]+)$/,                         operation: 'space.delete',   spaceGroup: 1 },
  { method: 'POST',   pattern: /^\/api\/admin\/spaces\/([^/]+)\/wipe$/,            operation: 'space.wipe',     spaceGroup: 1 },
  { method: 'GET',    pattern: /^\/api\/spaces/,                                   operation: 'space.list',     read: true },

  // ── Token operations ─────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/tokens$/,                                  operation: 'token.create' },
  { method: 'DELETE', pattern: /^\/api\/tokens\/([^/]+)$/,                         operation: 'token.delete' },

  // ── Webhook operations ───────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/notify\/webhooks$/,                        operation: 'webhook.create' },
  { method: 'PATCH',  pattern: /^\/api\/notify\/webhooks\/([^/]+)$/,               operation: 'webhook.update' },
  { method: 'DELETE', pattern: /^\/api\/notify\/webhooks\/([^/]+)$/,               operation: 'webhook.delete' },

  // ── Config / admin ───────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/admin\/reload-config$/,                    operation: 'config.reload' },
  { method: 'PATCH',  pattern: /^\/api\/admin\/media-config$/,                     operation: 'config.media.update' },

  // ── Data management ──────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/admin\/data\/backup$/,                     operation: 'data.backup' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/restore$/,                    operation: 'data.restore' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/migrate$/,                    operation: 'data.migrate' },
  { method: 'POST',   pattern: /^\/api\/admin\/data\/maintenance$/,                operation: 'data.maintenance.toggle' },

  // ── Brain query / recall / stats (reads) ─────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/recall/,      operation: 'brain.recall',         spaceGroup: 1, read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/recall$/,                           operation: 'brain.recall_global',  read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/query$/,      operation: 'brain.query',          spaceGroup: 1, read: true },
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/find-similar$/, operation: 'brain.find_similar', spaceGroup: 1, read: true },
  { method: 'GET',    pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/stats$/,      operation: 'brain.stats',          spaceGroup: 1, read: true },

  // ── Bulk write ───────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/bulk$/,       operation: 'bulk.write',     spaceGroup: 1 },

  // ── Traverse ─────────────────────────────────────────────────────────────
  { method: 'POST',   pattern: /^\/api\/brain\/(?:spaces\/)?([^/]+)\/traverse$/,   operation: 'brain.traverse', spaceGroup: 1, read: true },
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

function resolveOperation(method: string, path: string): { operation: string; spaceId: string | null; entryId: string | null; read: boolean } | null {
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

function isOidc(token: unknown): token is OidcTokenRecord {
  return !!token && typeof token === 'object' && 'source' in token && (token as OidcTokenRecord).source === 'oidc';
}

// ── Middleware ──────────────────────────────────────────────────────────────

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    // Use originalUrl (strip query string) — req.path inside the 'finish'
    // callback reflects the router-relative path (e.g. "/general/memories"
    // instead of "/api/brain/general/memories") because Express strips the
    // mount prefix for sub-routers and the response finishes within that
    // router context.
    const fullPath = (req.originalUrl || req.url).split('?')[0];

    // Skip paths that are not API calls or are audit-log reads themselves
    if (!fullPath.startsWith('/api/') && !fullPath.startsWith('/mcp')) return;
    if (fullPath.startsWith('/api/admin/audit-log')) return;
    // Skip health / ready / metrics / theme / setup
    if (fullPath.startsWith('/api/theme') || fullPath.startsWith('/api/setup')) return;

    const matched = resolveOperation(req.method, fullPath);
    if (!matched) return; // not an operation we track

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
    });
  });

  next();
}

/** Log a failed auth attempt — called explicitly from auth middleware when needed. */
export function logAuthFailure(req: Request): void {
  const fullPath = (req.originalUrl || req.url).split('?')[0];
  logAuditEntry({
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
