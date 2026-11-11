import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authRateLimit } from '../rate-limit/middleware.js';
import { isFirstRun, markConfigured, saveConfig, saveSecrets, loadSecrets, loadConfig } from '../config/loader.js';
import { createToken } from '../auth/tokens.js';
import { ensureInstanceKeypair } from '../util/signing.js';
import { startConfiguredInstanceServices } from '../bootstrap.js';
import { log } from '../util/log.js';
import type { Config, SecretsFile } from '../config/types.js';

/**
 * Longest instance label setup accepts.
 *
 * Matches the `maxlength` the SPA's own input carries, so nothing a person can type through the UI is
 * refused. It was written for the server-rendered form's handler and applied only there; when that handler
 * was removed with the form, `POST /json` turned out never to have had it — see the note beside the check.
 */
const SETUP_LABEL_MAX = 100;

export const setupRouter = Router();

// ── GET /status — used by Angular SPA to check first-run state ───────────
setupRouter.get('/status', (_req, res) => {
  // The boot's answer (`isFirstRun`), never the disk and never a throw: a config.json that is there and unusable stopped the boot, and
  // is never reported as "not configured".
  res.json({ configured: !isFirstRun() });
});

/**
 * True while one `POST /json` is running. Claimed BEFORE the first await and released at the end, so two first visitors cannot both pass
 * the "not configured" check and each write an identity: the second would overwrite the first's config and its admin token's hash.
 */
let setupRunning = false;

/*
 * The server-rendered HTML form used to live here: `GET /` rendered it and `POST /` processed it, with
 * `errorPage`/`escapeHtml` below to build the pages. All of it is REMOVED in 4.0 (deprecation 1.5), in two
 * steps that are worth telling apart.
 *
 * The `/setup` MOUNT went first. Express matches a mount before the SPA's index fallback, so mounting this
 * router at `/setup` as well as `/api/setup` made the Angular first-run page unreachable — the legacy form
 * was the live entry point and the SPA's own page had never served one. Unmounting it was the risky half,
 * and it shipped with an end-to-end first-run proof rather than on the argument that the SPA route existed.
 *
 * This is the half that was left behind, and it was not harmless. The form posted to `action="/setup"`, a
 * path that no longer existed, and the error page linked back to it — so the file still LOOKED like the live
 * entry point to anyone reading it, on the one code path that runs before any identity exists. It also kept
 * `11-setup-api.md` documenting `GET /setup` and `POST /setup` long after both had stopped answering, which
 * is the worse failure: a reader following a guide that was correct when written concludes the product is
 * broken rather than the page is old.
 *
 * What remains is the two endpoints with callers: `GET /status`, which the SPA polls to tell a first run
 * from a configured instance, and `POST /json`, which completes it and issues the one-time admin token.
 * Programmatic first-run setup uses `/json` — it was already the documented preference.
 */

// POST /api/setup — JSON variant for the Angular SPA
// Creates instance config + first admin PAT; returns { plaintext }
setupRouter.post('/json', authRateLimit, async (req, res) => {
  if (!isFirstRun()) {
    res.status(404).json({ error: 'Already configured' });
    return;
  }
  if (setupRunning) {
    res.status(409).json({ error: 'Setup is already running; wait for it to finish' });
    return;
  }

  const { label } = req.body ?? {};

  if (!label || typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'Instance label is required' });
    return;
  }

  /*
   * The length bound, which this path did not have.
   *
   * `SETUP_LABEL_MAX` was applied by the FORM handler and not by this one — one rule with two
   * implementations and the weaker one surviving, which only became visible when the form was deleted and
   * this became the single path. It was already the single path in practice: the `/setup` mount went in a
   * previous release, so the form had been unreachable and this endpoint has been taking an unbounded
   * `instanceLabel` on the unauthenticated boot path ever since.
   *
   * 100 is not a new number — it is the `maxlength` the SPA's own input carries, so nothing a person can
   * type through the UI is refused, and a direct POST is held to the same limit as the form it replaced.
   */
  if (label.trim().length > SETUP_LABEL_MAX) {
    res.status(400).json({ error: `Instance label must be ${SETUP_LABEL_MAX} characters or fewer` });
    return;
  }

  // Claimed here, before the first await (everything above is synchronous), and released whatever the setup does.
  setupRunning = true;
  try {
    const done = await completeSetup(label.trim());
    res.status(201).json(done);
  } finally {
    setupRunning = false;
  }
});

/** Write the identity, start the services, issue the first admin token. The body of `POST /json`, run by one caller at a time. */
async function completeSetup(label: string): Promise<{ token: Record<string, unknown>; plaintext: string }> {
  const instanceId = uuidv4();
  const config: Config = {
    instanceId,
    instanceLabel: label,
    tokens: [],
    spaces: [],
    networks: [],
    setup: { completed: true },
  };

  await saveConfig(config);
  // The file is there from here: no request may treat this instance as new, whatever happens next.
  markConfigured();
  const secrets: SecretsFile = { peerTokens: {} };
  await saveSecrets(secrets);
  loadConfig();
  loadSecrets();
  ensureInstanceKeypair();

  // Initialise spaces and start all background services now, so this freshly set-up
  // instance is fully operational without a restart. Tolerant of failure: setup still
  // succeeds (a restart would start the services) rather than blocking on it.
  try {
    await startConfiguredInstanceServices();
  } catch (err) {
    log.warn(`Could not start background services during JSON setup: ${err}`);
  }

  // Create the initial admin PAT so the Angular app can log in immediately
  const { record, plaintext } = await createToken({ name: 'Admin', admin: true, expiresAt: null });

  log.info(`Setup complete (JSON). Brain ID: ${instanceId}`);

  const { hash: _h, ...safeRecord } = record;
  return { token: safeRecord, plaintext };
}
