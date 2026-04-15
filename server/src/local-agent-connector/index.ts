import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';

const PORT = Number(process.env['YTHRIL_CONNECTOR_PORT'] ?? 38123);
const HOST = process.env['YTHRIL_CONNECTOR_BIND_HOST'] ?? '127.0.0.1';
const TOKEN_FILE = process.env['YTHRIL_CONNECTOR_TOKEN_FILE'] ?? path.join(os.homedir(), '.ythril-local-connector', 'token');
const ALLOW_SERVICE_INSTALL = (process.env['YTHRIL_CONNECTOR_ALLOW_SERVICE_INSTALL'] ?? '').trim().toLowerCase() === 'true';
const DEFAULT_TUNNEL_NAME = process.env['YTHRIL_CONNECTOR_TUNNEL_NAME'] ?? 'ythril-local';

function loadOrCreateToken(): string {
  const envToken = (process.env['YTHRIL_CONNECTOR_TOKEN'] ?? '').trim();
  if (envToken) return envToken;

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const fileToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (fileToken) return fileToken;
    }
  } catch (err) {
    console.error(`FATAL: unable to read connector token file '${TOKEN_FILE}': ${err}`);
    process.exit(1);
  }

  const dir = path.dirname(TOKEN_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, generated + '\n', { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch (err) {
    console.error(`FATAL: unable to create connector token file '${TOKEN_FILE}': ${err}`);
    process.exit(1);
  }
}

const TOKEN = loadOrCreateToken();

const EnableNetworksBody = z.object({
  hostname: z.string().min(4).max(253).regex(/^(?=.{4,253}$)(?!-)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}$/),
  os: z.enum(['windows', 'linux']).optional(),
  autostart: z.boolean().default(true),
});

const app = express();
app.use(express.json({ limit: '128kb' }));

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireConnectorAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token || !safeEqual(token, TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function ensureCloudflaredAvailable(): Promise<void> {
  await runCommand('cloudflared', ['--version']);
}

async function listTunnels(): Promise<Array<{ id: string; name: string }>> {
  const out = await runCommand('cloudflared', ['tunnel', 'list', '--output', 'json']);
  const parsed = JSON.parse(out.stdout) as Array<{ id: string; name: string }>;
  return Array.isArray(parsed) ? parsed : [];
}

async function ensureTunnel(tunnelName: string): Promise<{ id: string; name: string }> {
  const tunnels = await listTunnels();
  const existing = tunnels.find(t => t.name === tunnelName);
  if (existing) return existing;

  await runCommand('cloudflared', ['tunnel', 'create', tunnelName]);
  const after = await listTunnels();
  const created = after.find(t => t.name === tunnelName);
  if (!created) throw new Error(`Tunnel '${tunnelName}' was not found after creation`);
  return created;
}

function cloudflaredDir(): string {
  return path.join(os.homedir(), '.cloudflared');
}

function writeConfig(tunnelId: string, hostname: string): string {
  const dir = cloudflaredDir();
  const credPath = path.join(dir, `${tunnelId}.json`);
  if (!fs.existsSync(credPath)) {
    throw new Error(`Tunnel credentials file not found: ${credPath}. Run cloudflared tunnel login first.`);
  }

  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.yml');
  const content = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credPath}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    '    service: http://localhost:3200',
    '  - service: http_status:404',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, content, 'utf8');
  return configPath;
}

function osFamily(): 'windows' | 'linux' {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

async function maybeInstallService(targetOs: 'windows' | 'linux', autostart: boolean): Promise<string[]> {
  const notes: string[] = [];
  if (!autostart) return notes;
  if (!ALLOW_SERVICE_INSTALL) {
    notes.push('Service install skipped: YTHRIL_CONNECTOR_ALLOW_SERVICE_INSTALL is not true.');
    return notes;
  }

  await runCommand('cloudflared', ['service', 'install']);
  notes.push('cloudflared service installed.');

  if (targetOs === 'windows') {
    await runCommand('powershell', ['-NoProfile', '-Command', 'Start-Service cloudflared']);
    notes.push('cloudflared Windows service started.');
  } else {
    try {
      await runCommand('systemctl', ['enable', '--now', 'cloudflared']);
      notes.push('cloudflared systemd service enabled and started.');
    } catch {
      notes.push('systemctl enable/start skipped or failed; run manually if needed.');
    }
  }

  return notes;
}

app.get('/v1/status', requireConnectorAuth, (_req, res) => {
  res.json({
    message: 'Local connector ready.',
    os: osFamily(),
    executeEnabled: true,
    serviceInstallEnabled: ALLOW_SERVICE_INSTALL,
    bindHost: HOST,
  });
});

app.post('/v1/actions/enable-networks', requireConnectorAuth, async (req, res) => {
  const parsed = EnableNetworksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const targetOs = parsed.data.os ?? osFamily();
  const hostname = parsed.data.hostname;
  const autostart = parsed.data.autostart;

  const plannedSteps = [
    `Ensure cloudflared is installed`,
    `Ensure tunnel '${DEFAULT_TUNNEL_NAME}' exists`,
    `Route DNS hostname '${hostname}' to tunnel`,
    'Write ~/.cloudflared/config.yml',
    autostart ? 'Install/start cloudflared service (if allowed)' : 'Skip service install/start',
  ];

  try {
    await ensureCloudflaredAvailable();
    const tunnel = await ensureTunnel(DEFAULT_TUNNEL_NAME);
    await runCommand('cloudflared', ['tunnel', 'route', 'dns', DEFAULT_TUNNEL_NAME, hostname]);
    const configPath = writeConfig(tunnel.id, hostname);
    const notes = await maybeInstallService(targetOs, autostart);

    res.json({
      ok: true,
      executed: true,
      message: 'Enable Networks action completed.',
      publicUrl: `https://${hostname}`,
      tunnelId: tunnel.id,
      configPath,
      notes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, HOST, () => {
  console.log('');
  console.log(`[ythril-local-connector] listening on http://${HOST}:${PORT}`);
  console.log('[ythril-local-connector] execute-enabled=true');
  console.log(`[ythril-local-connector] service-install-enabled=${ALLOW_SERVICE_INSTALL}`);
  console.log('');
});
