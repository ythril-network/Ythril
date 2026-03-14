import { Router } from 'express';
import bcrypt from 'bcrypt';
import { authRateLimit } from '../rate-limit/middleware.js';
import { getSecrets } from '../config/loader.js';
import { createToken, listTokens, revokeToken, updateTokenSpaces } from '../auth/tokens.js';
import { getConfig } from '../config/loader.js';
import { createSpace, removeSpace, slugify } from '../spaces/spaces.js';
import { getDirSizeBytes } from '../files/files.js';
import { spaceRoot } from '../files/sandbox.js';
import {
  requireSettingsAuth,
  setSettingsSessionCookie,
  clearSettingsSessionCookie,
} from './auth.js';
import { log } from '../util/log.js';

export const settingsRouter = Router();

// ── GET /settings/login — login form ────────────────────────────────────────
settingsRouter.get('/login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(loginPage());
});

// ── POST /settings/login — verify password, set cookie ──────────────────────
settingsRouter.post('/login', authRateLimit, async (req, res) => {
  const password: string = req.body?.password ?? '';
  const next: string = (req.body?.next ?? '/settings').replace(/[^\w/\-?=&.]/g, '');

  const secrets = getSecrets();
  const ok = await bcrypt.compare(password, secrets.settingsPasswordHash);
  if (!ok) {
    log.warn('Settings login: invalid password attempt');
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8').send(loginPage('Invalid password'));
    return;
  }

  setSettingsSessionCookie(res);
  log.info('Settings login: authenticated');
  res.redirect(303, next);
});

// ── POST /settings/logout ────────────────────────────────────────────────────
settingsRouter.post('/logout', (_req, res) => {
  clearSettingsSessionCookie(res);
  res.redirect(303, '/settings/login');
});

// ── Everything below requires auth ──────────────────────────────────────────
settingsRouter.use(requireSettingsAuth);

// ── GET /settings — main settings page ──────────────────────────────────────
settingsRouter.get('/', async (req, res) => {
  const tokens = listTokens();
  const spaces = getConfig().spaces;
  const spaceError = typeof req.query['spaceError'] === 'string' ? req.query['spaceError'] : undefined;

  // Compute file storage per space (best-effort)
  const storageSizes: Record<string, number> = {};
  await Promise.all(spaces.map(async s => {
    storageSizes[s.id] = await getDirSizeBytes(spaceRoot(s.id));
  }));

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(settingsPage(tokens, spaces, storageSizes, spaceError));
});

// ── POST /settings/tokens — create a new PAT ────────────────────────────────
settingsRouter.post('/tokens', async (req, res) => {
  const name: string = (req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'Token name is required' });
    return;
  }
  // Parse space allowlist — array of IDs from checkboxes; omit field = all spaces
  const rawSpaces = req.body?.spaces;
  const spaces: string[] | undefined = rawSpaces
    ? (Array.isArray(rawSpaces) ? rawSpaces : [rawSpaces]).filter(Boolean)
    : undefined;
  const { record, plaintext } = await createToken({ name, spaces: spaces?.length ? spaces : undefined });
  log.info(`Settings: created token ID=${record.id} name="${record.name}"`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(newTokenPage(record.name, plaintext));
});

// ── POST /settings/tokens/:id/spaces — update space allowlist ────────────────
settingsRouter.post('/tokens/:id/spaces', (req, res) => {
  const { id } = req.params;
  const rawSpaces = req.body?.spaces;
  const spaces: string[] | undefined = rawSpaces
    ? (Array.isArray(rawSpaces) ? rawSpaces : [rawSpaces]).filter(Boolean)
    : undefined;
  const ok = updateTokenSpaces(id, spaces?.length ? spaces : undefined);
  if (!ok) { res.status(404).json({ error: 'Token not found' }); return; }
  log.info(`Settings: updated spaces for token ID=${id}`);
  res.redirect(303, '/settings');
});

// ── POST /settings/spaces — create a new space ─────────────────────────────
settingsRouter.post('/spaces', async (req, res) => {
  const label: string = (req.body?.label ?? '').trim();
  if (!label) {
    res.status(400).json({ error: 'Space label is required' });
    return;
  }
  const rawId: string = (req.body?.id ?? '').trim();
  const id = rawId || slugify(label);
  try {
    await createSpace({ id, label });
    log.info(`Settings: created space id=${id} label="${label}"`);
  } catch (err) {
    // Likely duplicate ID — surface as flash-style redirect with error in query
    const msg = err instanceof Error ? err.message : String(err);
    res.redirect(303, `/settings?spaceError=${encodeURIComponent(msg)}`);
    return;
  }
  res.redirect(303, '/settings');
});

// ── POST /settings/spaces/:id/delete — remove a space ────────────────────────
settingsRouter.post('/spaces/:id/delete', async (req, res) => {
  const { id } = req.params;
  try {
    const ok = await removeSpace(id);
    if (!ok) {
      res.status(404).json({ error: `Space '${id}' not found` });
      return;
    }
    log.info(`Settings: deleted space id=${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.redirect(303, `/settings?spaceError=${encodeURIComponent(msg)}`);
    return;
  }
  res.redirect(303, '/settings');
});

// ── DELETE /settings/tokens/:id — revoke a PAT ──────────────────────────────
settingsRouter.post('/tokens/:id/revoke', async (req, res) => {
  const { id } = req.params;
  const ok = await revokeToken(id);
  if (!ok) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  log.info(`Settings: revoked token ID=${id}`);
  res.redirect(303, '/settings');
});

// ── HTML helpers ─────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const baseStyle = `
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #eee; margin: 0; padding: 2rem 1rem; }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.3rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid #333; padding-bottom: 0.4rem; }
  p.sub { color: #888; font-size: 0.9rem; margin: 0 0 2rem; }
  label { display: block; margin-bottom: 0.25rem; font-size: 0.85rem; color: #aaa; }
  input[type=text], input[type=password] { padding: 0.5rem 0.75rem; border: 1px solid #444; border-radius: 6px; background: #111; color: #eee; font-size: 0.95rem; }
  input:focus { outline: none; border-color: #6060f0; }
  .btn { padding: 0.5rem 1.1rem; background: #6060f0; color: #fff; border: none; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
  .btn:hover { background: #7070ff; }
  .btn-danger { background: #8b1a1a; }
  .btn-danger:hover { background: #b02020; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #222; }
  th { color: #888; font-weight: normal; }
  .token-box { background: #111; border: 1px solid #444; border-radius: 6px; padding: 0.75rem 1rem; font-family: monospace; word-break: break-all; margin: 1rem 0; }
  .warn { color: #f0a030; font-size: 0.85rem; }
  .error { color: #f66; margin-bottom: 1rem; font-size: 0.9rem; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .nav form { margin: 0; }
`;

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ythril \u2014 Settings</title><style>${baseStyle}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:2rem;max-width:360px;margin:4rem auto}
</style></head><body>
<div class="card">
  <h1>ythril settings</h1>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <form method="POST" action="/settings/login">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" style="width:100%;margin-bottom:1rem" required>
    <button class="btn" style="width:100%" type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function spaceCheckboxes(allSpaces: {id:string;label:string}[], selected?: string[]): string {
  if (!allSpaces.length) return '';
  return allSpaces.map(s => {
    const checked = !selected || selected.includes(s.id) ? '' : '';
    // only pre-check if selected list explicitly includes it, or if selected is undefined (all)
    const isChecked = !selected || selected.includes(s.id);
    return `<label style="display:inline-flex;align-items:center;gap:0.4rem;margin-right:0.75rem;font-size:0.85rem;color:#ccc;cursor:pointer">
      <input type="checkbox" name="spaces" value="${esc(s.id)}"${isChecked ? ' checked' : ''}> ${esc(s.label)}
    </label>`;
  }).join('');
}

function settingsPage(
  tokens: ReturnType<typeof listTokens>,
  spaces: { id: string; label: string; builtIn: boolean }[],
  storageSizes: Record<string, number>,
  spaceError?: string,
): string {
  const rows = tokens.map(t => {
    const spacesLabel = !t.spaces ? 'All' : t.spaces.length === 0 ? 'None' : t.spaces.map(id => spaces.find(s=>s.id===id)?.label ?? id).join(', ');
    return `
    <tr>
      <td>${esc(t.name)}</td>
      <td style="color:#888">${t.createdAt.slice(0, 10)}</td>
      <td style="color:#888">${t.lastUsed ? t.lastUsed.slice(0, 10) : '\u2014'}</td>
      <td>
        <details style="cursor:pointer">
          <summary style="font-size:0.85rem;color:#888;list-style:none;user-select:none" title="Edit spaces">${esc(spacesLabel)} &#x270E;</summary>
          <form method="POST" action="/settings/tokens/${esc(t.id)}/spaces" style="margin:0.5rem 0 0;padding:0.5rem;background:#111;border-radius:6px;border:1px solid #333">
            <div style="margin-bottom:0.5rem;font-size:0.8rem;color:#888">Restrict to spaces (unchecked = no access, none checked = all spaces):</div>
            ${spaces.length ? spaceCheckboxes(spaces, t.spaces) : '<span style="color:#555;font-size:0.8rem">No spaces configured</span>'}
            <button class="btn" type="submit" style="margin-top:0.5rem;padding:0.3rem 0.8rem;font-size:0.8rem">Save</button>
          </form>
        </details>
      </td>
      <td>
        <form method="POST" action="/settings/tokens/${esc(t.id)}/revoke" style="margin:0"
              onsubmit="return confirm('Revoke token \u201c${esc(t.name)}\u201d? This cannot be undone.')">
          <button class="btn btn-danger" type="submit" style="padding:0.3rem 0.7rem;font-size:0.8rem">Revoke</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const spaceSection = spaces.length > 1 ? `
    <div style="margin-top:0.75rem">
      <div style="font-size:0.85rem;color:#aaa;margin-bottom:0.4rem">Restrict to spaces <span style="color:#555">(leave all unchecked = access all spaces)</span></div>
      <div>${spaceCheckboxes(spaces, undefined)}</div>
    </div>` : '';

  const spaceRows = spaces.map(s => {
    const bytes = storageSizes[s.id] ?? 0;
    const sizeLabel = formatBytes(bytes);
    return `
    <tr>
      <td><code style="font-size:0.85rem">${esc(s.id)}</code></td>
      <td>${esc(s.label)}</td>
      <td style="color:#888">${s.builtIn ? 'Yes' : '\u2014'}</td>
      <td style="color:#888;font-size:0.85rem">${sizeLabel}</td>
      <td>${s.builtIn ? '' : `
        <form method="POST" action="/settings/spaces/${esc(s.id)}/delete" style="margin:0"
              onsubmit="return confirm('Delete space \u201c${esc(s.label)}\u201d?\n\nData in MongoDB and files will be retained but the space will be removed from config.')">
          <button class="btn btn-danger" type="submit" style="padding:0.3rem 0.7rem;font-size:0.8rem">Delete</button>
        </form>`}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ythril \u2014 Settings</title><style>${baseStyle}</style></head><body>
<div class="wrap">
  <div class="nav">
    <h1>ythril settings</h1>
    <form method="POST" action="/settings/logout">
      <button class="btn" type="submit" style="background:#333">Sign out</button>
    </form>
    <a class="btn" href="/brain" style="background:#1a1a3a;border:1px solid #444">Brain &rarr;</a>
  </div>

  <h2>Access tokens</h2>
  <p style="color:#888;font-size:0.9rem">Tokens are used to authenticate MCP clients and API access. Each token is shown once when created.</p>
  ${tokens.length === 0
    ? '<p style="color:#888;font-style:italic">No tokens yet.</p>'
    : `<table><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Spaces</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}

  <h2>Create token</h2>
  <form method="POST" action="/settings/tokens">
    <div style="display:flex;gap:0.75rem;align-items:flex-end">
      <div>
        <label>Token name</label>
        <input type="text" name="name" placeholder="e.g. claude-desktop" maxlength="200" required>
      </div>
      <button class="btn" type="submit">Create</button>
    </div>
    ${spaceSection}
  </form>

  <h2>Spaces</h2>
  ${spaceError ? `<p class="error">${esc(spaceError)}</p>` : ''}
  <table>
    <thead><tr><th>ID</th><th>Label</th><th>Built-in</th><th>File storage</th><th></th></tr></thead>
    <tbody>${spaceRows}</tbody>
  </table>
  <h3 style="font-size:0.95rem;margin:1.5rem 0 0.75rem">Create space</h3>
  <form method="POST" action="/settings/spaces">
    <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap">
      <div>
        <label>Label</label>
        <input type="text" name="label" placeholder="e.g. Work" maxlength="200" required>
      </div>
      <div>
        <label>ID <span style="color:#555">(optional)</span></label>
        <input type="text" name="id" placeholder="e.g. work" maxlength="40" pattern="[a-z0-9-]+">
      </div>
      <button class="btn" type="submit">Create</button>
    </div>
  </form>
</div>
</body></html>`;
}

function newTokenPage(name: string, plaintext: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ythril \u2014 New Token</title><style>${baseStyle}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:2rem;max-width:520px;margin:3rem auto}
.copy-row{display:flex;gap:0.5rem;margin:1rem 0;align-items:stretch}
.copy-row .token-box{flex:1;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy-btn{padding:0 1rem;background:#333;color:#eee;border:1px solid #555;border-radius:6px;cursor:pointer;font-size:0.9rem;white-space:nowrap}
.copy-btn:hover{background:#444}
.copy-btn.copied{background:#1a4a1a;border-color:#4c4;color:#4c4}
</style></head><body>
<div class="card">
  <h1>Token created</h1>
  <p style="color:#888;font-size:0.9rem">Token <strong>${esc(name)}</strong> \u2014 copy it now, it will not be shown again.</p>
  <div class="copy-row">
    <div class="token-box" id="tok">${esc(plaintext)}</div>
    <button class="copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
  </div>
  <p class="warn">&#x26A0; Store this securely. It grants full API and MCP access.</p>
  <p style="margin-top:1.5rem;font-size:0.9rem;color:#aaa">
    MCP endpoint: <code>http://localhost:3200/mcp/general</code><br>
    Header: <code>Authorization: Bearer ${esc(plaintext)}</code>
  </p>
  <p style="margin-top:1.5rem"><a href="/settings" style="color:#6060f0">&larr; Back to settings</a></p>
</div>
<script>
function copyToken() {
  navigator.clipboard.writeText(${JSON.stringify(plaintext)}).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}
</script>
</body></html>`;
}
