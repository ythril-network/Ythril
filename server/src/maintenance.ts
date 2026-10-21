/**
 * Maintenance mode: the flag and the Express middleware.
 *
 * When active, every request but an instance administrator's receives a 503. Health checks (/health, /ready,
 * /metrics) and the /api/admin/* routes pass through so the operator can still monitor and control the instance.
 *
 * ## Two halves, one answer (bundle-157, R4.1, R5.3)
 *
 * Maintenance is MANUAL (an operator's toggle, in memory) OR DERIVED: an act that stands on every space at once (a
 * restore) holds the instance in maintenance from its registration until its last space's act ends, because a reader
 * would otherwise see a database half old and half restored. The derived half is read from the standing acts
 * (`instanceWideActStanding`), never kept in a flag of its own, so a restart that resumes the acts resumes
 * maintenance with them, and the toggle cannot end it early: {@link setMaintenanceActive} sets the manual half only.
 *
 * An instance administrator passes on ANY path while it holds, so the danger tab, the Networks owed list and MCP keep
 * working for the one caller who can act on a restore. Every other caller gets the 503 JSON.
 */
import type { Request, Response, NextFunction } from 'express';
import { instanceWideActStanding } from './spaces/space-act-runner.js';
import { requestIsInstanceAdmin } from './auth/middleware.js';
import { isInstanceAdmin } from './auth/instance-admin.js';
import type { TokenRights } from './config/rights-shape.js';
import type { SpaceActKind } from './config/types.js';

let _manual = false;

/** Is the instance in maintenance: the manual toggle, or an instance-wide act standing. */
export function isMaintenanceActive(): boolean {
  return _manual || instanceWideActStanding() !== null;
}

/** The two halves apart, for the door that reports them and the toggle that can move only one. */
export function maintenanceState(): { active: boolean; manual: boolean; heldBy: SpaceActKind | null } {
  const heldBy = instanceWideActStanding();
  return { active: _manual || heldBy !== null, manual: _manual, heldBy };
}

/** Set the MANUAL half; an instance-wide act holds maintenance whatever this is. */
export function setMaintenanceActive(active: boolean): void {
  _manual = active;
}

function refuse(res: Response): void {
  res.status(503).json({
    error: 'System is in maintenance mode. Please try again later.',
    maintenance: true,
  });
}

/**
 * Express middleware — mount this early in the chain, after /health and /ready
 * but before the API routers, so maintenance blocks all API traffic except admin.
 */
export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isMaintenanceActive()) {
    next();
    return;
  }

  const p = req.path;

  // Always pass: liveness / readiness probes and metrics
  if (p === '/health' || p === '/ready' || p === '/metrics') {
    next();
    return;
  }

  // Always pass: admin routes so the operator can monitor and deactivate maintenance
  if (p.startsWith('/api/admin/')) {
    next();
    return;
  }

  // An instance administrator passes on every path: a token a guard already attached is judged at once, a bearer is resolved here.
  const attached = req.authToken as { admin?: boolean; rights?: TokenRights | null } | undefined;
  if (attached) {
    if (isInstanceAdmin(attached)) next(); else refuse(res);
    return;
  }
  requestIsInstanceAdmin(req).then(admin => (admin ? next() : refuse(res)), () => refuse(res));
}
