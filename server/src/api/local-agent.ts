import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { requireAdminMfa } from '../auth/middleware.js';
import { log } from '../util/log.js';

export const localAgentRouter = Router();

const ExecuteEnableNetworksBody = z.object({
  hostname: z.string().min(4).max(253),
  os: z.enum(['windows', 'linux']),
  autostart: z.boolean().default(true),
});

function envTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

export function isLocalAgentFeatureEnabled(): boolean {
  // Security default: OFF unless explicitly enabled.
  return envTrue('YTHRIL_LOCAL_AGENT_ENABLED');
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function getAgentConfig(): { baseUrl: string | null; token: string | null } {
  if (!isLocalAgentFeatureEnabled()) {
    return { baseUrl: null, token: null };
  }

  const raw = process.env['YTHRIL_LOCAL_AGENT_URL']?.trim() ?? '';
  let token = process.env['YTHRIL_LOCAL_AGENT_TOKEN']?.trim() ?? null;
  if (!token) {
    const tokenFile = process.env['YTHRIL_LOCAL_AGENT_TOKEN_FILE']?.trim()
      || path.join(os.homedir(), '.ythril-local-connector', 'token');
    if (tokenFile) {
      try {
        const fromFile = fs.readFileSync(tokenFile, 'utf8').trim();
        token = fromFile || null;
      } catch {
        // leave token null; status endpoint will report connector errors if auth fails
      }
    }
  }
  if (!raw) return { baseUrl: null, token };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    log.warn('Local agent URL is invalid; feature will remain unavailable.');
    return { baseUrl: null, token };
  }

  const allowRemote = envTrue('YTHRIL_LOCAL_AGENT_ALLOW_REMOTE');
  if (!allowRemote && !isLoopbackHost(parsed.hostname)) {
    log.warn('Local agent URL rejected: non-loopback host while YTHRIL_LOCAL_AGENT_ALLOW_REMOTE is not true.');
    return { baseUrl: null, token };
  }

  if (!allowRemote && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn('Local agent URL rejected: protocol must be http/https.');
    return { baseUrl: null, token };
  }

  if (allowRemote && parsed.protocol !== 'https:') {
    log.warn('Local agent URL rejected: remote mode requires https.');
    return { baseUrl: null, token };
  }

  const baseUrl = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return { baseUrl, token };
}

async function callAgent(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = getAgentConfig();
  if (!cfg.baseUrl) throw new Error('Local agent is not configured');

  const headers = new Headers(init.headers ?? {});
  if (cfg.token) headers.set('Authorization', `Bearer ${cfg.token}`);

  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
}

localAgentRouter.get('/status', globalRateLimit, requireAdminMfa, async (_req, res) => {
  if (!isLocalAgentFeatureEnabled()) {
    res.status(404).json({ error: 'Local agent feature is disabled' });
    return;
  }

  const cfg = getAgentConfig();
  if (!cfg.baseUrl) {
    res.json({
      configured: false,
      reachable: false,
      canExecute: false,
      message: 'Set YTHRIL_LOCAL_AGENT_URL (and optionally YTHRIL_LOCAL_AGENT_TOKEN) to enable one-click setup. Default security policy expects a loopback URL unless YTHRIL_LOCAL_AGENT_ALLOW_REMOTE=true.',
    });
    return;
  }

  try {
    const r = await callAgent('/v1/status', { method: 'GET' });
    if (!r.ok) {
      const text = await r.text();
      res.json({
        configured: true,
        reachable: false,
        canExecute: false,
        message: `Agent status check failed (${r.status}): ${text || 'no response body'}`,
      });
      return;
    }

    const body = await r.json().catch(() => ({}));
    res.json({
      configured: true,
      reachable: true,
      canExecute: true,
      message: typeof body?.message === 'string' ? body.message : 'Local agent reachable.',
      agent: body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({
      configured: true,
      reachable: false,
      canExecute: false,
      message: `Local agent unreachable: ${msg}`,
    });
  }
});

localAgentRouter.post('/enable-networks/execute', globalRateLimit, requireAdminMfa, async (req, res) => {
  if (!isLocalAgentFeatureEnabled()) {
    res.status(404).json({ error: 'Local agent feature is disabled' });
    return;
  }

  const parsed = ExecuteEnableNetworksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const response = await callAgent('/v1/actions/enable-networks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });

    const raw = await response.text();
    const body = raw ? JSON.parse(raw) : {};

    if (!response.ok) {
      res.status(502).json({
        error: body?.error ?? `Local agent returned HTTP ${response.status}`,
      });
      return;
    }

    res.json({
      ok: true,
      ...body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`local-agent execute failed: ${msg}`);
    res.status(502).json({ error: `Local agent execution failed: ${msg}` });
  }
});
