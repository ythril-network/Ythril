import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { authRateLimit } from '../rate-limit/middleware.js';
import { configExists, saveConfig, saveSecrets, loadSecrets, loadConfig } from '../config/loader.js';
import { ensureGeneralSpace } from '../spaces/spaces.js';
import { createToken } from '../auth/tokens.js';
import { log } from '../util/log.js';
import type { Config, SecretsFile } from '../config/types.js';

/** Ephemeral setup code — held in memory, cleared after setup completes */
let pendingSetupCode: string | null = null;

/** Generate and store a setup code for first-run */
export function generateSetupCode(): string {
  const code = randomBytes(8).toString('hex').toUpperCase();
  // Format as XXXX-XXXX-XXXX-XXXX (4 groups of 4 hex chars)
  pendingSetupCode = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
  return pendingSetupCode;
}

export const setupRouter = Router();

// ── GET /status — used by Angular SPA to check first-run state ───────────
setupRouter.get('/status', (_req, res) => {
  res.json({ configured: configExists() });
});

// GET /setup — HTML form
setupRouter.get('/', authRateLimit, (_req, res) => {
  if (configExists()) {
    res.status(404).send('Not found');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ythril — First-Run Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; padding: 2rem; width: 100%; max-width: 420px; }
    h1 { margin: 0 0 0.3rem; font-size: 1.4rem; }
    p.sub { margin: 0 0 1.5rem; color: #888; font-size: 0.9rem; }
    label { display: block; margin-bottom: 0.25rem; font-size: 0.85rem; color: #aaa; }
    input[type=text], input[type=password] { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid #444; border-radius: 6px; background: #111; color: #eee; font-size: 1rem; margin-bottom: 0.25rem; }
    input:focus { outline: none; border-color: #6060f0; }
    input.invalid { border-color: #f66; }
    input.valid { border-color: #4c4; }
    .field-hint { font-size: 0.78rem; min-height: 1.2em; margin-bottom: 0.75rem; color: #888; }
    .field-hint.error { color: #f66; }
    .field-hint.ok { color: #4c4; }
    button { width: 100%; padding: 0.65rem; background: #6060f0; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; transition: opacity 0.15s; }
    button:disabled { opacity: 0.35; cursor: not-allowed; }
    button:not(:disabled):hover { background: #7070ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ythril</h1>
    <p class="sub">First-run setup — check the server logs for your setup code.</p>
    <form method="POST" action="/setup" id="setupForm">
      <label>Setup code</label>
      <input type="password" name="code" id="code" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" required>
      <div class="field-hint" id="codeHint"></div>
      <label>Brain label</label>
      <input type="text" name="label" id="label" placeholder="My Brain" maxlength="100" required>
      <div class="field-hint" id="labelHint"></div>
      <label>Settings password</label>
      <input type="password" name="settingsPassword" id="pw" autocomplete="new-password" required>
      <div class="field-hint" id="pwHint"></div>
      <label>Confirm settings password</label>
      <input type="password" name="settingsPasswordConfirm" id="pw2" autocomplete="new-password" required>
      <div class="field-hint" id="pw2Hint"></div>
      <button type="submit" id="submitBtn" disabled>Complete setup</button>
    </form>
  </div>
  <script>
    const code  = document.getElementById('code');
    const label = document.getElementById('label');
    const pw    = document.getElementById('pw');
    const pw2   = document.getElementById('pw2');
    const btn   = document.getElementById('submitBtn');

    const codeHint  = document.getElementById('codeHint');
    const labelHint = document.getElementById('labelHint');
    const pwHint    = document.getElementById('pwHint');
    const pw2Hint   = document.getElementById('pw2Hint');

    function setHint(el, input, msg, ok) {
      el.textContent = msg;
      el.className = 'field-hint' + (msg ? (ok ? ' ok' : ' error') : '');
      input.className = msg ? (ok ? 'valid' : 'invalid') : '';
    }

    function validate() {
      let ok = true;

      // Setup code — format check only (server validates the actual value)
      const codeVal = code.value.trim();
      if (codeVal && !/^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/.test(codeVal)) {
        setHint(codeHint, code, 'Format: XXXX-XXXX-XXXX-XXXX', false); ok = false;
      } else if (!codeVal) {
        setHint(codeHint, code, '', false); ok = false;
      } else {
        setHint(codeHint, code, '', true);
      }

      // Label
      if (!label.value.trim()) { setHint(labelHint, label, '', false); ok = false; }
      else { setHint(labelHint, label, '', true); }

      // Password strength
      const pwVal = pw.value;
      if (!pwVal) {
        setHint(pwHint, pw, '', false); ok = false;
      } else if (pwVal.length < 8) {
        setHint(pwHint, pw, 'Minimum 8 characters', false); ok = false;
      } else {
        setHint(pwHint, pw, '', true);
      }

      // Confirm
      if (!pw2.value) {
        setHint(pw2Hint, pw2, '', false); ok = false;
      } else if (pw2.value !== pwVal) {
        setHint(pw2Hint, pw2, 'Passwords do not match', false); ok = false;
      } else {
        setHint(pw2Hint, pw2, 'Passwords match', true);
      }

      btn.disabled = !ok;
    }

    [code, label, pw, pw2].forEach(el => el.addEventListener('input', validate));
  </script>
</body>
</html>`);
});

// POST /setup — process setup form
setupRouter.post('/', authRateLimit, async (req, res) => {
  if (configExists()) {
    res.status(404).send('Not found');
    return;
  }

  const code: string = req.body?.code ?? '';
  const label: string = (req.body?.label ?? '').trim();
  const settingsPassword: string = req.body?.settingsPassword ?? '';
  const settingsPasswordConfirm: string = req.body?.settingsPasswordConfirm ?? '';

  if (!pendingSetupCode || code.trim().toUpperCase() !== pendingSetupCode.toUpperCase()) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8').send(`
      <script>document.referrer && history.back();</script>
      <p>Invalid setup code. Check your console and try again.</p>
    `);
    return;
  }

  if (!label) {
    res.status(400).send(errorPage('Brain label is required'));
    return;
  }

  if (!settingsPassword || settingsPassword.length < 8) {
    res.status(400).send(errorPage('Settings password must be at least 8 characters'));
    return;
  }

  if (settingsPassword !== settingsPasswordConfirm) {
    res.status(400).send(errorPage('Passwords do not match'));
    return;
  }

  const instanceId = uuidv4();

  // Build initial config (no tokens yet — createToken will add it)
  const config: Config = {
    instanceId,
    instanceLabel: label,
    tokens: [],
    spaces: [],
    networks: [],
    setup: { completed: true },
  };

  // Write config first so loader.getConfig() works
  await saveConfig(config);

  // Hash settings password and write secrets
  const settingsPasswordHash = await bcrypt.hash(settingsPassword, 12);
  const secrets: SecretsFile = { settingsPasswordHash, peerTokens: {} };
  await saveSecrets(secrets);
  // Load both config and secrets into memory so auth middleware works immediately
  loadConfig();
  loadSecrets();

  // Initialise the general space
  try {
    await ensureGeneralSpace();
  } catch (err) {
    log.warn(`Could not initialise general space during setup: ${err}`);
  }

  // Clear setup code from memory
  pendingSetupCode = null;

  log.info(`Setup complete. Brain ID: ${instanceId}`);

  // Redirect to settings to log in and create the first token
  res.redirect(303, '/settings');
});

// POST /api/setup — JSON variant for the Angular SPA
// Creates instance config + first admin PAT; returns { plaintext }
setupRouter.post('/json', authRateLimit, async (req, res) => {
  if (configExists()) {
    res.status(404).json({ error: 'Already configured' });
    return;
  }

  const { code, label, settingsPassword } = req.body ?? {};

  if (!pendingSetupCode || String(code ?? '').trim().toUpperCase() !== pendingSetupCode.toUpperCase()) {
    res.status(400).json({ error: 'Invalid setup code' });
    return;
  }
  if (!label || typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'Instance label is required' });
    return;
  }
  if (!settingsPassword || typeof settingsPassword !== 'string' || settingsPassword.length < 8) {
    res.status(400).json({ error: 'Settings password must be at least 8 characters' });
    return;
  }

  const instanceId = uuidv4();
  const config: Config = {
    instanceId,
    instanceLabel: label.trim(),
    tokens: [],
    spaces: [],
    networks: [],
    setup: { completed: true },
  };

  await saveConfig(config);
  const settingsPasswordHash = await bcrypt.hash(settingsPassword, 12);
  const secrets: SecretsFile = { settingsPasswordHash, peerTokens: {} };
  await saveSecrets(secrets);
  loadConfig();
  loadSecrets();

  try {
    await ensureGeneralSpace();
  } catch (err) {
    log.warn(`Could not initialise general space during JSON setup: ${err}`);
  }

  // Create the initial admin PAT so the Angular app can log in immediately
  const { record, plaintext } = await createToken({ name: 'Admin', expiresAt: null });

  pendingSetupCode = null;
  log.info(`Setup complete (JSON). Brain ID: ${instanceId}`);

  const { hash: _h, ...safeRecord } = record;
  res.status(201).json({ token: safeRecord, plaintext });
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>ythril — Setup Error</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:2rem;max-width:420px;width:100%}
h1{margin:0 0 1rem;font-size:1.2rem;color:#f66}a{color:#6060f0}</style></head>
<body><div class="card"><h1>Setup error</h1><p>${escapeHtml(message)}</p><p><a href="/setup">&larr; Back</a></p></div></body></html>`;
}
