import { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { isFirstRun, getConfig, loadConfig } from '../config/loader.js';
import { getAllowedEmbedOrigins } from '../config/embed.js';

export const themeRouter = Router();

themeRouter.use(globalRateLimit);

/**
 * Public endpoint — no auth required.
 * Returns the optional external CSS theme URL so the SPA can inject it before login,
 * plus the operator-approved embed origins so the SPA knows which cross-origin hosts
 * may push `ythril:theme` postMessages. The list is empty unless explicitly opted into
 * (see `embedding.allowedOrigins`), in which case only same-origin theming is honoured.
 */
themeRouter.get('/', (_req, res) => {
  if (isFirstRun()) {
    res.json({ cssUrl: null, allowedOrigins: [] });
    return;
  }
  // Use the in-memory config when available (avoids sync disk read on every request);
  // fall back to loadConfig() on first call before config is cached.
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    cfg = loadConfig();
  }
  res.json({
    cssUrl: cfg.theme?.cssUrl ?? null,
    allowedOrigins: getAllowedEmbedOrigins(),
  });
});
