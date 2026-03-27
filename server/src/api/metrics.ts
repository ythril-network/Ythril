import { Router } from 'express';
import { register } from '../metrics/registry.js';

export const metricsRouter = Router();

/**
 * GET /metrics
 *
 * Unauthenticated Prometheus text-format metrics endpoint.
 * Scrapers (e.g. Prometheus, Datadog Agent) hit this without app tokens.
 * Returns: text/plain; version=0.0.4; charset=utf-8
 */
metricsRouter.get('/', async (_req, res) => {
  try {
    const metrics = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    res.send(metrics);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`# Error collecting metrics: ${msg}\n`);
  }
});
