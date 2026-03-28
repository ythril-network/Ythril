import { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { configExists, loadConfig } from '../config/loader.js';

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
  const cfg = loadConfig();
  res.json({ cssUrl: cfg.theme?.cssUrl ?? null });
});
