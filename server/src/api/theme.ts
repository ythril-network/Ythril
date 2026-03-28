import { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { configExists, getConfig, loadConfig } from '../config/loader.js';

export const themeRouter = Router();

themeRouter.use(globalRateLimit);

/**
 * Public endpoint — no auth required.
 * Returns the optional external CSS theme URL so the SPA can inject it before login.
 */
themeRouter.get('/', (_req, res) => {
  if (!configExists()) {
    res.json({ cssUrl: null });
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
  res.json({ cssUrl: cfg.theme?.cssUrl ?? null });
});
