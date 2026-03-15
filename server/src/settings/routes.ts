import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { authRateLimit } from '../rate-limit/middleware.js';
import { getConfig, getSecrets, saveConfig, saveSecrets } from '../config/loader.js';
import { createToken, listTokens, revokeToken, updateTokenSpaces } from '../auth/tokens.js';
import { createSpace, removeSpace, slugify } from '../spaces/spaces.js';
import { getDirSizeBytes } from '../files/files.js';
import { spaceRoot } from '../files/sandbox.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../api/sync.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
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
  const cfg = getConfig();
  const spaces = cfg.spaces;
  const networks = cfg.networks;
  const spaceError = typeof req.query['spaceError'] === 'string' ? req.query['spaceError'] : undefined;
  const networkError = typeof req.query['networkError'] === 'string' ? req.query['networkError'] : undefined;
  const networkMsg = typeof req.query['networkMsg'] === 'string' ? req.query['networkMsg'] : undefined;
  const openVoteCount = networks.reduce((sum, n) =>
    sum + n.pendingRounds.filter(r => !r.concluded).length, 0);

  // Compute file storage per space (best-effort)
  const storageSizes: Record<string, number> = {};
  await Promise.all(spaces.map(async s => {
    storageSizes[s.id] = await getDirSizeBytes(spaceRoot(s.id));
  }));

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(settingsPage(tokens, spaces, storageSizes, networks, openVoteCount, spaceError, networkError, networkMsg));
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

const BCRYPT_ROUNDS = 12;

// ── POST /settings/networks — create a new network ───────────────────────────
settingsRouter.post('/networks', async (req, res) => {
  const label = (req.body?.label ?? '').trim();
  const type = req.body?.type ?? 'closed';
  const rawSpaces = req.body?.spaces;
  const spaces: string[] = rawSpaces
    ? (Array.isArray(rawSpaces) ? rawSpaces : [rawSpaces]).filter(Boolean)
    : [];
  const votingDeadlineHours = Math.max(1, Math.min(72,
    parseInt(req.body?.votingDeadlineHours ?? '24', 10) || 24));
  const merkle = req.body?.merkle === 'on';

  if (!label) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Label is required')); return; }
  if (!['closed', 'democratic', 'club', 'braintree'].includes(type)) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent('Invalid network type')); return;
  }
  if (!spaces.length) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Select at least one space')); return; }

  const cfg = getConfig();
  const invalid = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
  if (invalid.length) { res.redirect(303, '/settings?networkError=' + encodeURIComponent(`Unknown spaces: ${invalid.join(', ')}`)); return; }

  const presetId = (req.body?.id ?? '').trim() || undefined;
  if (presetId && cfg.networks.some(n => n.id === presetId)) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent(`Network ID '${presetId}' already exists`)); return;
  }

  const net: NetworkConfig = {
    id: presetId ?? uuidv4(),
    label,
    type: type as NetworkConfig['type'],
    spaces,
    votingDeadlineHours,
    merkle: merkle || undefined,
    members: [],
    pendingRounds: [],
    createdAt: new Date().toISOString(),
  };
  cfg.networks.push(net);
  saveConfig(cfg);
  log.info(`Settings: created network id=${net.id} label="${label}" type=${type}`);
  res.redirect(303, '/settings#networks');
});

// ── POST /settings/networks/:id/invite — generate / rotate invite key ─────────
settingsRouter.post('/networks/:id/invite', async (req, res) => {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return; }
  const { randomBytes } = await import('crypto');
  const key = `ythril_invite_${randomBytes(32).toString('base64url')}`;
  net.inviteKeyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);
  saveConfig(cfg);
  log.info(`Settings: generated invite key for network ${net.id}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(networkInvitePage(net.label, key, net.id));
});

// ── POST /settings/networks/:id/member — add a peer member ────────────────────
settingsRouter.post('/networks/:id/member', async (req, res) => {
  const { id } = req.params;
  const instanceId = (req.body?.instanceId ?? '').trim();
  const label = (req.body?.label ?? '').trim();
  const url = (req.body?.url ?? '').trim();
  const token = (req.body?.token ?? '').trim();
  const direction = (req.body?.direction ?? 'both') as 'both' | 'push';
  const parentInstanceId = (req.body?.parentInstanceId ?? '').trim() || undefined;

  if (!instanceId || !label || !url || !token) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent('instanceId, label, url and token are all required')); return;
  }
  if (!['both', 'push'].includes(direction)) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent('Invalid direction')); return;
  }

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === id);
  if (!net) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return; }
  if (net.members.some(m => m.instanceId === instanceId)) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent('Member already exists')); return;
  }

  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const member = { instanceId, label, url, tokenHash, direction, parentInstanceId };
  const secrets = getSecrets();
  secrets.peerTokens[instanceId] = token;
  saveSecrets(secrets);

  if (net.type === 'closed' || net.type === 'democratic') {
    const round: VoteRound = {
      roundId: uuidv4(), type: 'join',
      subjectInstanceId: instanceId, subjectLabel: label, subjectUrl: url,
      deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
      openedAt: new Date().toISOString(), votes: [], pendingMember: member,
    };
    net.pendingRounds.push(round);
    saveConfig(cfg);
    log.info(`Settings: opened join vote round for ${label} in network ${id}`);
    res.redirect(303, '/settings?networkMsg=' + encodeURIComponent(`Vote round opened for ${label}`) + '#networks');
    return;
  }

  if (net.type === 'club') {
    net.members.push(member);
    saveConfig(cfg);
    log.info(`Settings: added member ${label} to club network ${id}`);
    res.redirect(303, '/settings?networkMsg=' + encodeURIComponent(`Added ${label}`) + '#networks');
    return;
  }

  // Braintree: build ancestor path; auto-concludes when this instance is the root
  const requiredVoters: string[] = [];
  let cur: string | undefined = parentInstanceId ?? cfg.instanceId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    requiredVoters.push(cur);
    seen.add(cur);
    if (cur === cfg.instanceId) { cur = net.myParentInstanceId; }
    else { cur = net.members.find(m => m.instanceId === cur)?.parentInstanceId; }
  }
  const round: VoteRound = {
    roundId: uuidv4(), type: 'join',
    subjectInstanceId: instanceId, subjectLabel: label, subjectUrl: url,
    deadline: new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString(),
    openedAt: new Date().toISOString(),
    votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: new Date().toISOString() }],
    pendingMember: member, requiredVoters,
  };
  net.pendingRounds.push(round);
  const passed = concludeRoundIfReady(net, round);
  if (passed) net.members.push(member);
  saveConfig(cfg);
  log.info(`Settings: braintree add ${label} — ${passed ? 'added directly' : 'vote round opened'}`);
  res.redirect(303, '/settings?networkMsg=' + encodeURIComponent(
    passed ? `Added ${label}` : `Vote round opened for ${label}`) + '#networks');
});

// ── POST /settings/networks/:id/sync — trigger a sync cycle ──────────────────
settingsRouter.post('/networks/:id/sync', (req, res) => {
  const { id } = req.params;
  if (!getConfig().networks.some(n => n.id === id)) {
    res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return;
  }
  import('../sync/engine.js').then(({ runSyncForNetwork }) => {
    void runSyncForNetwork(id);
  }).catch(err => log.error(`Settings: sync trigger import failed: ${err}`));
  res.redirect(303, '/settings?networkMsg=' + encodeURIComponent('Sync triggered') + '#networks');
});

// ── POST /settings/networks/:id/schedule — update sync schedule ───────────────
settingsRouter.post('/networks/:id/schedule', (req, res) => {
  const { id } = req.params;
  const schedule = (req.body?.schedule ?? '').trim() || undefined;
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === id);
  if (!net) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return; }
  net.syncSchedule = schedule;
  saveConfig(cfg);
  import('../sync/engine.js').then(({ scheduleSyncForNetwork }) => {
    scheduleSyncForNetwork(id, schedule);
  }).catch(err => log.error(`Settings: schedule update import failed: ${err}`));
  log.info(`Settings: sync schedule for network ${id} → ${schedule ?? 'manual'}`);
  res.redirect(303, '/settings?networkMsg=' + encodeURIComponent('Schedule updated') + '#networks');
});

// ── POST /settings/networks/:id/leave — leave a network ───────────────────────
settingsRouter.post('/networks/:id/leave', (req, res) => {
  const { id } = req.params;
  const cfg = getConfig();
  const idx = cfg.networks.findIndex(n => n.id === id);
  if (idx < 0) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return; }
  const net = cfg.networks[idx]!;
  const secrets = getSecrets();
  for (const member of net.members) {
    const peerToken = secrets.peerTokens[member.instanceId];
    if (!peerToken) continue;
    fetch(`${member.url}/api/notify`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkId: id, instanceId: cfg.instanceId, event: 'member_departed' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(err => log.warn(`member_departed to ${member.label}: ${err}`));
  }
  cfg.networks.splice(idx, 1);
  saveConfig(cfg);
  log.info(`Settings: left network ${id} (${net.label})`);
  res.redirect(303, '/settings?networkMsg=' + encodeURIComponent(`Left network "${net.label}"`) + '#networks');
});

// ── POST /settings/networks/:id/votes/:roundId — cast a vote ──────────────────
settingsRouter.post('/networks/:id/votes/:roundId', (req, res) => {
  const vote = req.body?.vote;
  if (vote !== 'yes' && vote !== 'veto') { res.redirect(303, '/settings#networks'); return; }
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Network not found')); return; }
  const round = net.pendingRounds.find(r => r.roundId === req.params['roundId'] && !r.concluded);
  if (!round) { res.redirect(303, '/settings?networkError=' + encodeURIComponent('Round not found or already concluded')); return; }

  const cast = { instanceId: cfg.instanceId, vote: vote as 'yes' | 'veto', castAt: new Date().toISOString() };
  const existing = round.votes.findIndex(v => v.instanceId === cfg.instanceId);
  if (existing >= 0) round.votes[existing] = cast; else round.votes.push(cast);

  concludeRoundIfReady(net, round);

  // Join round side-effects: add pending member if this is the direct parent
  if (round.concluded && round.passed && round.type === 'join' && round.pendingMember &&
      !net.members.some(m => m.instanceId === round.subjectInstanceId)) {
    const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
    const isDirectParent = !round.pendingMember.parentInstanceId ||
      round.pendingMember.parentInstanceId === cfg.instanceId;
    if (vetoCount === 0 && (net.type !== 'braintree' || isDirectParent)) {
      net.members.push(round.pendingMember);
      log.info(`Settings vote: join round ${round.roundId} passed — added ${round.subjectLabel}`);
    }
  }
  // Remove round side-effect: already handled by concludeRoundIfReady; just notify the ejected peer
  if (round.concluded && round.passed && round.type === 'remove') {
    sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
  }

  saveConfig(cfg);
  log.info(`Settings: voted ${vote} on round ${round.roundId} in network ${net.id}`);
  res.redirect(303, '/settings?networkMsg=' + encodeURIComponent(`Vote cast: ${vote}`) + '#networks');
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
  networks: NetworkConfig[],
  openVoteCount: number,
  spaceError?: string,
  networkError?: string,
  networkMsg?: string,
): string {
  const cfg = getConfig();
  const instanceId = cfg.instanceId;
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
  ${openVoteCount > 0 ? `
  <div style="background:#3a1a00;border:1px solid #804000;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:0.75rem">
    <span style="font-size:1.1rem">🗳</span>
    <span><strong>${openVoteCount} open vote round${openVoteCount !== 1 ? 's' : ''}</strong> need your attention. <a href="#networks" style="color:#f0a030">Jump to Networks ↓</a></span>
  </div>` : ''}

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

  <h2 id="networks">Networks</h2>
  ${networkError ? `<p class="error">${esc(networkError)}</p>` : ''}
  ${networkMsg ? `<p style="color:#4c4;font-size:0.9rem;margin-bottom:0.75rem">${esc(networkMsg)}</p>` : ''}
  ${networks.length === 0
    ? '<p style="color:#888;font-style:italic">No networks configured.</p>'
    : networks.map(n => networkCard(n, instanceId, spaces)).join('')}
  <h3 style="font-size:0.95rem;margin:1.5rem 0 0.75rem">Create network</h3>
  <form method="POST" action="/settings/networks">
    <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;margin-bottom:0.5rem">
      <div><label>Label</label><input type="text" name="label" placeholder="e.g. Personal devices" maxlength="200" required></div>
      <div>
        <label>Type</label>
        <select name="type" style="padding:0.5rem 0.75rem;border:1px solid #444;border-radius:6px;background:#111;color:#eee;font-size:0.95rem">
          <option value="closed">Closed (unanimous)</option>
          <option value="democratic">Democratic (majority + no veto)</option>
          <option value="club">Club (inviter decides)</option>
          <option value="braintree">Braintree (tree, push-only)</option>
        </select>
      </div>
      <div><label>Voting deadline <span style="color:#555">(hours, 1–72)</span></label><input type="number" name="votingDeadlineHours" value="24" min="1" max="72" style="width:80px"></div>
    </div>
    <div style="margin-bottom:0.5rem">
      <div style="font-size:0.85rem;color:#aaa;margin-bottom:0.3rem">Spaces to sync</div>
      ${spaceCheckboxes(spaces, undefined)}
    </div>
    <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;margin-bottom:0.5rem">
      <div><label>ID <span style="color:#555">(optional — leave blank for auto; set to register an existing network)</span></label><input type="text" name="id" placeholder="auto" maxlength="40" style="width:260px"></div>
      <label style="display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:#ccc;cursor:pointer">
        <input type="checkbox" name="merkle"> Enable Merkle divergence detection
      </label>
    </div>
    <button class="btn" type="submit">Create network</button>
  </form>
</div>
</body></html>`;
}

function netTypeBadge(type: string): string {
  const s: Record<string, string> = {
    closed: 'background:#3a1a4a;color:#b080e0',
    democratic: 'background:#1a3a1a;color:#60d080',
    club: 'background:#3a2a00;color:#d09040',
    braintree: 'background:#0a1a3a;color:#4080c0',
  };
  return `<span style="font-size:0.75rem;padding:0.1rem 0.5rem;border-radius:4px;${s[type] ?? ''}">${esc(type)}</span>`;
}

function networkCard(
  net: NetworkConfig,
  instanceId: string,
  spaceConfigs: { id: string; label: string }[],
): string {
  const openRounds = net.pendingRounds.filter(r => !r.concluded);
  const spaceLabels = net.spaces.map(sid => spaceConfigs.find(s => s.id === sid)?.label ?? sid);
  const lastSync = net.members.reduce<string | undefined>((best, m) =>
    m.lastSyncAt && (!best || m.lastSyncAt > best) ? m.lastSyncAt : best, undefined);

  const membersHtml = net.members.length === 0
    ? '<p style="color:#555;font-size:0.85rem;margin:0.25rem 0 0.75rem">No members yet.</p>'
    : `<div style="overflow-x:auto;margin-bottom:0.75rem"><table>
        <thead><tr><th>Member</th><th>URL</th><th>Direction</th><th>Last sync</th><th>Status</th>${net.type === 'braintree' ? '<th>Parent</th>' : ''}</tr></thead>
        <tbody>${net.members.map(m => {
          const f = m.consecutiveFailures ?? 0;
          const st = f >= 10
            ? `<span style="color:#f55;font-size:0.8rem">⚠ Unreachable (${f})</span>`
            : f > 0 ? `<span style="color:#f0a030;font-size:0.8rem">${f} fail${f !== 1 ? 's' : ''}</span>`
            : '<span style="color:#4c4;font-size:0.8rem">OK</span>';
          return `<tr>
            <td>${esc(m.label)}${m.skipTlsVerify ? ' <span style="color:#f0a030;font-size:0.75rem" title="TLS verification disabled">⚠TLS</span>' : ''}</td>
            <td style="font-size:0.78rem;color:#888;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.url)}</td>
            <td><code style="font-size:0.75rem">${m.direction}</code></td>
            <td style="color:#888;font-size:0.78rem;white-space:nowrap">${m.lastSyncAt ? m.lastSyncAt.slice(0, 10) : '—'}</td>
            <td>${st}</td>
            ${net.type === 'braintree' ? `<td style="color:#888;font-size:0.78rem">${m.parentInstanceId ? m.parentInstanceId.slice(0, 8) + '…' : '<em>root</em>'}</td>` : ''}
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;

  const roundsHtml = openRounds.length === 0 ? '' :
    `<div style="margin-bottom:0.75rem">
      <div style="font-size:0.82rem;font-weight:600;color:#f0a030;margin-bottom:0.4rem">🗳 ${openRounds.length} open vote round${openRounds.length !== 1 ? 's' : ''}</div>
      ${openRounds.map(r => {
        const yesCount = r.votes.filter(v => v.vote === 'yes').length;
        const vetoCount = r.votes.filter(v => v.vote === 'veto').length;
        const alreadyVoted = r.votes.some(v => v.instanceId === instanceId);
        const typeLabel = r.type === 'join' ? '➕ Join' : r.type === 'remove' ? '➖ Remove' : '🗑 Space deletion';
        const deadline = r.deadline.slice(0, 16).replace('T', ' ') + ' UTC';
        return `<div style="background:#1a1000;border:1px solid #443300;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.4rem">
          <div style="font-size:0.85rem;font-weight:600;margin-bottom:0.25rem">${typeLabel}: ${esc(r.subjectLabel)}</div>
          <div style="font-size:0.78rem;color:#888;margin-bottom:0.35rem">Deadline: ${esc(deadline)} · ${yesCount} yes, ${vetoCount} veto${r.requiredVoters ? ` · ${r.requiredVoters.length} required voter${r.requiredVoters.length !== 1 ? 's' : ''}` : ''}</div>
          ${alreadyVoted
            ? '<span style="font-size:0.8rem;color:#888">You already voted on this round.</span>'
            : `<div style="display:flex;gap:0.5rem">
                <form method="POST" action="/settings/networks/${esc(net.id)}/votes/${esc(r.roundId)}" style="margin:0">
                  <input type="hidden" name="vote" value="yes">
                  <button class="btn" style="padding:0.25rem 0.75rem;font-size:0.8rem">✓ Yes</button>
                </form>
                <form method="POST" action="/settings/networks/${esc(net.id)}/votes/${esc(r.roundId)}" style="margin:0">
                  <input type="hidden" name="vote" value="veto">
                  <button class="btn btn-danger" style="padding:0.25rem 0.75rem;font-size:0.8rem">✗ Veto</button>
                </form>
              </div>`}
        </div>`;
      }).join('')}
    </div>`;

  const addMemberHtml = `
    <details style="margin-bottom:0.5rem">
      <summary style="cursor:pointer;font-size:0.82rem;color:#888;user-select:none;padding:0.25rem 0">➕ Add member…</summary>
      <form method="POST" action="/settings/networks/${esc(net.id)}/member" style="margin:0.5rem 0 0;padding:0.75rem;background:#0a0a0a;border-radius:6px;border:1px solid #2a2a2a">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 0.75rem;margin-bottom:0.5rem">
          <div><label>Instance ID</label><input type="text" name="instanceId" placeholder="peer's instanceId" style="width:100%" required></div>
          <div><label>Label</label><input type="text" name="label" placeholder="e.g. laptop" maxlength="200" style="width:100%" required></div>
          <div><label>URL</label><input type="text" name="url" placeholder="https://peer.example.com" style="width:100%" required></div>
          <div><label>Peer token <span style="color:#555">(their PAT for us)</span></label><input type="text" name="token" placeholder="ythril_…" style="width:100%;font-family:monospace" required></div>
          <div>
            <label>Direction</label>
            <select name="direction" style="padding:0.45rem 0.6rem;border:1px solid #444;border-radius:6px;background:#111;color:#eee;font-size:0.9rem;width:100%">
              <option value="both"${net.type !== 'braintree' ? ' selected' : ''}>both</option>
              <option value="push"${net.type === 'braintree' ? ' selected' : ''}>push (parent → child)</option>
            </select>
          </div>
          ${net.type === 'braintree' ? '<div><label>Parent instance ID <span style="color:#555">(blank = child of root)</span></label><input type="text" name="parentInstanceId" style="width:100%"></div>' : ''}
        </div>
        <button class="btn" type="submit" style="font-size:0.85rem;padding:0.35rem 0.85rem">Add</button>
      </form>
    </details>`;

  const syncHtml = `
    <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;padding-top:0.5rem">
      <form method="POST" action="/settings/networks/${esc(net.id)}/schedule" style="margin:0;display:flex;gap:0.5rem;align-items:flex-end">
        <div>
          <label style="font-size:0.8rem;color:#888">Sync schedule <span style="color:#555">(e.g. */15 min, */1 hour; blank = manual)</span></label>
          <input type="text" name="schedule" value="${esc(net.syncSchedule ?? '')}" placeholder="manual only" style="width:190px">
        </div>
        <button class="btn" type="submit" style="padding:0.4rem 0.8rem;font-size:0.8rem">Save</button>
      </form>
      <form method="POST" action="/settings/networks/${esc(net.id)}/sync" style="margin:0">
        <button class="btn" type="submit" style="padding:0.4rem 0.8rem;font-size:0.8rem;background:#1a3a1a">▶ Sync now</button>
      </form>
      <form method="POST" action="/settings/networks/${esc(net.id)}/invite" style="margin:0">
        <button class="btn" type="submit" style="padding:0.4rem 0.8rem;font-size:0.8rem;background:#1a1a3a">🔑 ${net.inviteKeyHash ? 'Rotate' : 'Generate'} invite key</button>
      </form>
    </div>`;

  const leaveHtml = `
    <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #222">
      <form method="POST" action="/settings/networks/${esc(net.id)}/leave" style="margin:0"
            onsubmit="return confirm('Leave this network? All peers will be notified. Your local data is kept.')">
        <button class="btn btn-danger" type="submit" style="padding:0.35rem 0.8rem;font-size:0.85rem">Leave network</button>
      </form>
    </div>`;

  const votesBadge = openRounds.length > 0
    ? ` <span style="background:#8b3000;color:#f0a030;font-size:0.72rem;padding:0.1rem 0.5rem;border-radius:10px">${openRounds.length}</span>`
    : '';

  return `
    <details style="background:#111;border:1px solid #222;border-radius:8px;margin-bottom:0.6rem;padding:0.75rem 1rem">
      <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:0.35rem;user-select:none">
        <span style="font-weight:600">${esc(net.label)}</span> ${netTypeBadge(net.type)}${votesBadge}
        <span style="color:#888;font-size:0.82rem;margin-left:0.25rem">${spaceLabels.map(esc).join(', ')} · ${net.members.length} member${net.members.length !== 1 ? 's' : ''}${lastSync ? ' · synced ' + lastSync.slice(0, 10) : ''}</span>
        <span style="margin-left:auto;color:#444;font-size:0.8rem">▸</span>
      </summary>
      <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #1a1a1a">
        ${membersHtml}
        ${roundsHtml}
        ${addMemberHtml}
        ${syncHtml}
        ${leaveHtml}
      </div>
    </details>`;
}

function networkInvitePage(networkLabel: string, inviteKey: string, networkId: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ythril \u2014 Invite Key</title><style>${baseStyle}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:2rem;max-width:560px;margin:3rem auto}
.copy-row{display:flex;gap:0.5rem;margin:1rem 0;align-items:stretch}
.copy-row .token-box{flex:1;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy-btn{padding:0 1rem;background:#333;color:#eee;border:1px solid #555;border-radius:6px;cursor:pointer;font-size:0.9rem;white-space:nowrap}
.copy-btn:hover{background:#444}
.copy-btn.copied{background:#1a4a1a;border-color:#4c4;color:#4c4}
</style></head><body>
<div class="card">
  <h1>Invite key generated</h1>
  <p style="color:#888;font-size:0.9rem">Network: <strong>${esc(networkLabel)}</strong> — share this key with the peer who wants to join.</p>
  <div class="copy-row">
    <div class="token-box" id="ikey">${esc(inviteKey)}</div>
    <button class="copy-btn" id="copyBtn" onclick="copyKey()">Copy</button>
  </div>
  <p class="warn">&#x26A0; Store this securely. This is the only time it will be displayed.</p>
  <p style="margin-top:1rem;font-size:0.9rem;color:#aaa">
    Network ID: <code>${esc(networkId)}</code><br>
    The peer joining needs both the network ID and this invite key.
  </p>
  <p style="margin-top:1.5rem"><a href="/settings#networks" style="color:#6060f0">&larr; Back to settings</a></p>
</div>
<script>
function copyKey() {
  navigator.clipboard.writeText(${JSON.stringify(inviteKey)}).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}
</script>
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
