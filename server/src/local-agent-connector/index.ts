import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';

const PORT = Number(process.env['YTHRIL_CONNECTOR_PORT'] ?? 38123);
const HOST = process.env['YTHRIL_CONNECTOR_BIND_HOST'] ?? '0.0.0.0';
const TOKEN_FILE = process.env['YTHRIL_CONNECTOR_TOKEN_FILE'] ?? path.join(os.homedir(), '.ythril-local-connector', 'token');
// On Windows workstations, service install is the correct default so the tunnel survives reboots
// without a separate auto-start mechanism. Opt out by setting the env var to 'false'.
const ALLOW_SERVICE_INSTALL = process.platform === 'win32'
  ? (process.env['YTHRIL_CONNECTOR_ALLOW_SERVICE_INSTALL'] ?? 'true').trim().toLowerCase() !== 'false'
  : (process.env['YTHRIL_CONNECTOR_ALLOW_SERVICE_INSTALL'] ?? '').trim().toLowerCase() === 'true';
const DEFAULT_TUNNEL_NAME = process.env['YTHRIL_CONNECTOR_TUNNEL_NAME'] ?? 'ythril-local';
const CLOUDFLARED_CERT_PATH = path.join(os.homedir(), '.cloudflared', 'cert.pem');
const CONNECTOR_STATE_DIR = path.join(os.homedir(), '.ythril-local-connector');
const TUNNEL_PID_FILE = path.join(CONNECTOR_STATE_DIR, 'cloudflared-tunnel-run.pid');

let cloudflaredCmd = process.env['YTHRIL_CONNECTOR_CLOUDFLARED_BIN']?.trim() || 'cloudflared';

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
  overwriteDns: z.boolean().default(false),
  acknowledgeCriticalChanges: z.literal(true),
  // The local origin the cloudflared tunnel should forward to. The Ythril server
  // injects this automatically from its own PORT env var.
  localOrigin: z.string().url().default('http://localhost:3200'),
});

const app = express();
app.use(express.json({ limit: '128kb' }));

function safeEqual(a: string, b: string): boolean {
  // Hash both values with HMAC-SHA256 before comparing so the buffers are always
  // the same length and no timing information about the token's byte length leaks.
  const key = Buffer.alloc(32);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
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

async function runCloudflared(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runCommand(cloudflaredCmd, args);
}

async function probeCloudflaredExecutable(cmd: string): Promise<boolean> {
  try {
    await runCommand(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function resolveCloudflaredCommand(): Promise<string | null> {
  if (await probeCloudflaredExecutable(cloudflaredCmd)) return cloudflaredCmd;

  const candidates = [
    'cloudflared',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
  ];

  for (const cmd of candidates) {
    if (await probeCloudflaredExecutable(cmd)) return cmd;
  }
  return null;
}

async function ensureCloudflaredAvailable(): Promise<void> {
  const resolved = await resolveCloudflaredCommand();
  if (resolved) {
    cloudflaredCmd = resolved;
    return;
  }

  if (process.platform !== 'win32') {
    throw new Error('cloudflared is not available. Install it first (https://developers.cloudflare.com/cloudflared/get-started/) and retry.');
  }

  const wingetOk = await probeCloudflaredExecutable('winget');
  if (!wingetOk) {
    throw new Error('cloudflared is not installed and winget is unavailable. Install cloudflared manually, then retry.');
  }

  await runCommand('winget', [
    'install',
    '--id',
    'Cloudflare.cloudflared',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ]);

  const resolvedAfterInstall = await resolveCloudflaredCommand();
  if (!resolvedAfterInstall) {
    throw new Error('cloudflared installation completed but binary is still not reachable. Open a new session or set YTHRIL_CONNECTOR_CLOUDFLARED_BIN to the full executable path.');
  }
  cloudflaredCmd = resolvedAfterInstall;
}

async function listTunnels(): Promise<Array<{ id: string; name: string }>> {
  const out = await runCloudflared(['tunnel', 'list', '--output', 'json']);
  const parsed = JSON.parse(out.stdout) as Array<{ id: string; name: string }>;
  return Array.isArray(parsed) ? parsed : [];
}

async function ensureTunnel(tunnelName: string): Promise<{ id: string; name: string }> {
  const tunnels = await listTunnels();
  const existing = tunnels.find(t => t.name === tunnelName);
  if (existing) return existing;

  await runCloudflared(['tunnel', 'create', tunnelName]);
  const after = await listTunnels();
  const created = after.find(t => t.name === tunnelName);
  if (!created) throw new Error(`Tunnel '${tunnelName}' was not found after creation`);
  return created;
}

async function ensureDnsRoute(tunnelName: string, hostname: string, overwriteDns: boolean): Promise<void> {
  const args = overwriteDns
    ? ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelName, hostname]
    : ['tunnel', 'route', 'dns', tunnelName, hostname];
  try {
    await runCloudflared(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!overwriteDns && msg.includes('code: 1003')) {
      throw new Error('DNS record already exists for this hostname. Enable overwrite in the wizard or choose a different hostname.');
    }
    throw err;
  }
}

async function ensureCloudflareLogin(): Promise<void> {
  if (fs.existsSync(CLOUDFLARED_CERT_PATH)) return;
  // cert.pem is absent — run `cloudflared tunnel login`.
  // On workstation systems this opens the default browser for the OAuth flow and blocks
  // until the user completes authorisation. The caller (the Enable Networks action) has
  // a 5-minute HTTP timeout, which is ample for a human to click "Authorize" in a browser.
  await runCloudflared(['tunnel', 'login']);
  if (!fs.existsSync(CLOUDFLARED_CERT_PATH)) {
    throw new Error(
      'Cloudflare login did not complete (cert.pem still missing). ' +
      'Run `cloudflared tunnel login` in a terminal to authorise, then click "Run automatically" again.',
    );
  }
}

function cloudflaredDir(): string {
  return path.join(os.homedir(), '.cloudflared');
}

function writeConfig(tunnelId: string, hostname: string, localOrigin: string): string {
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
    `    service: ${localOrigin}`,
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

  if (targetOs === 'windows') {
    // Check whether the service already exists to keep this idempotent.
    const { stdout: svcStatus } = await runCommand('powershell', [
      '-NoProfile', '-Command',
      'Get-Service cloudflared -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status',
    ]).catch(() => ({ stdout: '', stderr: '' }));

    if (!svcStatus.trim()) {
      // cloudflared service install requires admin — trigger UAC elevation via PowerShell.
      // The operator will see a UAC dialog and must click Yes to proceed.
      await runCommand('powershell', [
        '-NoProfile', '-Command',
        'Start-Process -FilePath cloudflared -ArgumentList @("service","install") -Verb RunAs -Wait',
      ]);
      notes.push('cloudflared Windows service installed.');
    } else {
      notes.push('cloudflared Windows service already installed.');
    }

    // cloudflared service runs as LocalSystem, which resolves ~ to the system profile
    // (C:\Windows\System32\config\systemprofile), not the operator's home directory.
    // Fix the binPath to explicitly pass --config pointing to the operator's config.yml
    // so the service finds the tunnel credentials regardless of which user account runs it.
    const configPath = path.join(cloudflaredDir(), 'config.yml');
    const binPath = `"${cloudflaredCmd}" --config "${configPath}" tunnel run`;
    const batLines = [
      `sc.exe config cloudflared binPath= "${binPath.replace(/"/g, '\\"')}"`,
    ];
    const batFile = path.join(os.tmpdir(), 'ythril-cf-binpath.bat');
    fs.writeFileSync(batFile, batLines.join('\r\n'), 'ascii');
    await runCommand('powershell', [
      '-NoProfile', '-Command',
      `Start-Process cmd -Verb RunAs -ArgumentList '/c "","${batFile.replace(/"/g, '\\"')}"' -Wait`,
    ]);
    notes.push(`cloudflared service binPath updated to use --config ${configPath}.`);

    await runCommand('powershell', ['-NoProfile', '-Command', 'Start-Service cloudflared -ErrorAction SilentlyContinue']);
    notes.push('cloudflared Windows service started.');
  } else {
    await runCloudflared(['service', 'install']);
    notes.push('cloudflared service installed.');
    try {
      await runCommand('systemctl', ['enable', '--now', 'cloudflared']);
      notes.push('cloudflared systemd service enabled and started.');
    } catch {
      notes.push('systemctl enable/start skipped or failed; run manually if needed.');
    }
  }

  return notes;
}

function pidLooksAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureUserModeTunnelRunning(tunnelName: string): Promise<string> {
  try {
    if (fs.existsSync(TUNNEL_PID_FILE)) {
      const raw = fs.readFileSync(TUNNEL_PID_FILE, 'utf8').trim();
      const pid = Number(raw);
      if (pidLooksAlive(pid)) {
        return `cloudflared user-mode tunnel is already running (pid ${pid}).`;
      }
    }
  } catch {
    // continue and attempt to start a fresh process
  }

  fs.mkdirSync(CONNECTOR_STATE_DIR, { recursive: true, mode: 0o700 });
  const child = spawn(cloudflaredCmd, ['tunnel', 'run', tunnelName], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(TUNNEL_PID_FILE, String(child.pid), { encoding: 'utf8', mode: 0o600 });
  return `Started cloudflared user-mode tunnel process (pid ${child.pid}).`;
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
  const overwriteDns = parsed.data.overwriteDns;
  const localOrigin = parsed.data.localOrigin;

  const plannedSteps = [
    'Ensure cloudflared is installed',
    'Ensure Cloudflare login is completed',
    `Ensure tunnel '${DEFAULT_TUNNEL_NAME}' exists`,
    `Route DNS hostname '${hostname}' to tunnel${overwriteDns ? ' (overwrite enabled)' : ''}`,
    'Write ~/.cloudflared/config.yml',
    autostart ? 'Install/start cloudflared service (if allowed) or fall back to user-mode runtime' : 'Start cloudflared user-mode runtime',
  ];

  try {
    await ensureCloudflaredAvailable();
    await ensureCloudflareLogin();
    const tunnel = await ensureTunnel(DEFAULT_TUNNEL_NAME);
    await ensureDnsRoute(DEFAULT_TUNNEL_NAME, hostname, overwriteDns);
    const configPath = writeConfig(tunnel.id, hostname, localOrigin);
    const notes = await maybeInstallService(targetOs, autostart);
    if (!(autostart && ALLOW_SERVICE_INSTALL)) {
      notes.push(await ensureUserModeTunnelRunning(DEFAULT_TUNNEL_NAME));
    }
    notes.push('DNS propagation can take up to a minute. Validate with https://<hostname>/health.');

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

  // Auto-resume user-mode tunnel on startup if already configured.
  // This handles container restarts and host reboots without requiring the user to
  // re-run Enable Networks. Skip when ALLOW_SERVICE_INSTALL is true — the OS service
  // manager owns the cloudflared lifecycle in that case.
  if (!ALLOW_SERVICE_INSTALL) {
    const configYml = path.join(cloudflaredDir(), 'config.yml');
    if (fs.existsSync(CLOUDFLARED_CERT_PATH) && fs.existsSync(configYml)) {
      resolveCloudflaredCommand()
        .then(cmd => {
          if (!cmd) {
            console.log('[ythril-local-connector] auto-resume: cloudflared not found, skipping.');
            return null;
          }
          cloudflaredCmd = cmd;
          return ensureUserModeTunnelRunning(DEFAULT_TUNNEL_NAME);
        })
        .then(msg => { if (msg) console.log(`[ythril-local-connector] auto-resume: ${msg}`); })
        .catch(err => { console.error(`[ythril-local-connector] auto-resume error: ${err}`); });
    }
  }
});
