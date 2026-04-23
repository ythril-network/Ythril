/**
 * In-memory maintenance mode flag + Express middleware.
 *
 * When active, all non-health and non-admin requests receive a 503.
 * Health check (/health, /ready) and all /api/admin/* routes pass through
 * so the operator can still monitor and control the instance.
 *
 * Used by the database migration flow to quiesce writes before a dump.
 * Can also be activated manually by an operator via the data API.
 */
import type { Request, Response, NextFunction } from 'express';

let _active = false;

export function isMaintenanceActive(): boolean {
  return _active;
}

export function setMaintenanceActive(active: boolean): void {
  _active = active;
}

/**
 * Express middleware — mount this early in the chain, after /health and /ready
 * but before the API routers, so maintenance blocks all API traffic except admin.
 */
export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!_active) {
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

  res.status(503).json({
    error: 'System is in maintenance mode. Please try again later.',
    maintenance: true,
  });
}
