import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
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
      <button type="submit" id="submitBtn" disabled>Complete setup</button>
    </form>
  </div>
  <script>
    const code  = document.getElementById('code');
    const label = document.getElementById('label');
    const btn   = document.getElementById('submitBtn');

    const codeHint  = document.getElementById('codeHint');
    const labelHint = document.getElementById('labelHint');

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

      btn.disabled = !ok;
    }

    [code, label].forEach(el => el.addEventListener('input', validate));
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

  await saveConfig(config);
  const secrets: SecretsFile = { peerTokens: {} };
  await saveSecrets(secrets);
  loadConfig();
  loadSecrets();

  try {
    await ensureGeneralSpace();
  } catch (err) {
    log.warn(`Could not initialise general space during setup: ${err}`);
  }

  // Create the initial admin PAT
  const { record, plaintext } = await createToken({ name: 'Admin', admin: true, expiresAt: null });
  const { hash: _h, ...safeRecord } = record;

  pendingSetupCode = null;
  log.info(`Setup complete. Brain ID: ${instanceId}`);

  // Show the token once — it will not be retrievable again
  res.setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>ythril — Setup Complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:2rem;max-width:520px;width:100%}
h1{margin:0 0 1rem;font-size:1.2rem;color:#4c4}
.token{background:#111;border:1px solid #444;border-radius:6px;padding:0.6rem 0.9rem;font-family:monospace;font-size:0.9rem;word-break:break-all;margin:0.75rem 0}
.warn{color:#fa4;font-size:0.85rem;margin:0.5rem 0 1.25rem}
a{display:block;text-align:center;padding:0.6rem;background:#6060f0;color:#fff;border-radius:6px;text-decoration:none;font-size:1rem}
a:hover{background:#7070ff}</style></head>
<body><div class="card">
  <h1>Setup complete</h1>
  <p>Your first admin token is shown below. <strong>Copy it now — it will not be shown again.</strong></p>
  <div class="token" id="tok">${escapeHtml(plaintext)}</div>
  <p class="warn">Store it in a password manager or secret vault. Use it as a Bearer token for API and MCP access.</p>
  <p style="font-size:0.82rem;color:#888;margin-bottom:1.25rem">Token name: <strong>${escapeHtml(safeRecord.name)}</strong> &nbsp;·&nbsp; Created: ${escapeHtml(safeRecord.createdAt)}</p>
  <a href="/settings">Open settings &rarr;</a>
</div></body></html>`);
});

// POST /api/setup — JSON variant for the Angular SPA
// Creates instance config + first admin PAT; returns { plaintext }
setupRouter.post('/json', authRateLimit, async (req, res) => {
  if (configExists()) {
    res.status(404).json({ error: 'Already configured' });
    return;
  }

  const { code, label } = req.body ?? {};

  if (!pendingSetupCode || String(code ?? '').trim().toUpperCase() !== pendingSetupCode.toUpperCase()) {
    res.status(400).json({ error: 'Invalid setup code' });
    return;
  }
  if (!label || typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'Instance label is required' });
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
  const secrets: SecretsFile = { peerTokens: {} };
  await saveSecrets(secrets);
  loadConfig();
  loadSecrets();

  try {
    await ensureGeneralSpace();
  } catch (err) {
    log.warn(`Could not initialise general space during JSON setup: ${err}`);
  }

  // Create the initial admin PAT so the Angular app can log in immediately
  const { record, plaintext } = await createToken({ name: 'Admin', admin: true, expiresAt: null });

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
