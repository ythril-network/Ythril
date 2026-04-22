import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.js';
import type { Config, SecretsFile, SchemaLibraryEntry } from './types.js';

const CONFIG_PATH = process.env['CONFIG_PATH'] ?? '/config/config.json';
const SECRETS_PATH = path.join(path.dirname(CONFIG_PATH), 'secrets.json');
const SCHEMA_LIB_PATH = path.join(path.dirname(CONFIG_PATH), 'schema-library.json');

let _config: Config | null = null;
let _secrets: SecretsFile | null = null;

// ── File permission check ──────────────────────────────────────────────────

function checkPermissions(filePath: string): void {
  // Windows does not support Unix-style DAC file permissions — skip check.
  if (process.platform === 'win32') return;
  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      // On Docker with Windows-hosted volumes (WSL2 bind mounts), all files
      // appear as 0o777 regardless of intended permissions.  Detect this by
      // checking whether the directory itself is also 0o777 — if so, we are
      // on a Windows volume mount; silently fix the file permissions and continue.
      const dirStat = fs.statSync(path.dirname(filePath));
      const dirMode = dirStat.mode & 0o777;
      if (dirMode & 0o002) {
        // Directory is world-writable — almost certainly a Docker/WSL2 Windows
        // volume mount.  Fix the file permissions so future restarts won't re-trigger.
        try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
        return;
      }
      // If this process owns the file (common in Kubernetes hostPath mounts where
      // an init container writes the file as the same UID), auto-fix permissions
      // and continue with a warning rather than exiting.
      // process.getuid is not available on Windows, but we return early above for
      // win32, so this guard handles any other exotic platform that lacks UID support.
      // Use -1 as a sentinel: stat.uid is always >= 0, so the condition never matches.
      const processUid = typeof process.getuid === 'function' ? process.getuid() : -1;
      if (processUid !== -1 && stat.uid === processUid) {
        try {
          fs.chmodSync(filePath, 0o600);
          log.warn(
            `SECURITY: ${filePath} had loose permissions (mode ${mode.toString(8)}); ` +
            `auto-fixed to 0600.`,
          );
          return;
        } catch { /* fall through to hard exit if chmod fails */ }
      }
      log.error(
        `SECURITY: ${filePath} is world/group-readable (mode ${mode.toString(8)}). ` +
        `Fix with: chmod 600 ${filePath}`,
      );
      process.exit(1);
    }
  } catch {
    // file doesn't exist yet — fine
  }
}

// ── Config ─────────────────────────────────────────────────────────────────

/** Fail-fast validation for the OIDC block — called on every config load/reload. */
function validateOidcBlock(cfg: Config): void {
  const oidc = cfg.oidc;
  if (!oidc || !oidc.enabled) return; // disabled or absent — nothing to validate
  if (!oidc.issuerUrl || typeof oidc.issuerUrl !== 'string') {
    throw new Error('oidc.enabled is true but oidc.issuerUrl is missing or not a string');
  }
  if (!oidc.clientId || typeof oidc.clientId !== 'string') {
    throw new Error('oidc.enabled is true but oidc.clientId is missing or not a string');
  }
  try {
    const parsed = new URL(oidc.issuerUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('oidc.issuerUrl must use http or https');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('oidc.')) throw err;
    throw new Error(`oidc.issuerUrl is not a valid URL: ${oidc.issuerUrl}`);
  }
  if (oidc.audience !== undefined && typeof oidc.audience !== 'string') {
    throw new Error('oidc.audience must be a string when provided');
  }
  if (oidc.scopes !== undefined) {
    if (!Array.isArray(oidc.scopes) || oidc.scopes.some(s => typeof s !== 'string')) {
      throw new Error('oidc.scopes must be an array of strings when provided');
    }
  }
}

export function configExists(): boolean {
  if (!fs.existsSync(CONFIG_PATH)) return false;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').trim();
    return raw.length > 0 && JSON.parse(raw) !== null;
  } catch {
    return false;
  }
}

export function loadConfig(): Config {
  checkPermissions(CONFIG_PATH);
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Config;
  // Normalise arrays that may be absent in partial config files written before
  // first-run setup completes (e.g. a config pre-seeded with only storage quotas).
  parsed.spaces ??= [];
  parsed.tokens ??= [];
  parsed.networks ??= [];
  _config = parsed;
  validateOidcBlock(_config);
  return _config;
}

/**
 * Read config.json from disk and update the in-memory config.
 *
 * Unlike loadConfig(), this function does NOT call checkPermissions() first —
 * it tolerates a temporarily mis-permissioned file and corrects it via
 * chmodSync only (without rewriting the file contents).
 *
 * IMPORTANT: we must NOT call saveConfig() here.  On Docker Desktop
 * (Windows / macOS) the host-side bind-mount write may not have propagated to
 * the container yet by the time the reload request arrives.  If we read the
 * stale container view and then rewrite the file, we permanently overwrite the
 * operator's change.  Instead we only fix the permission bits in-place and
 * update _config in memory.  A subsequent reload (or the test retry loop) will
 * converge once the bind-mount delivers the latest version.
 */
export function reloadConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch (err) {
    log.error(`reloadConfig: config.json has invalid JSON — keeping current config: ${err}`);
    throw new Error('config.json contains invalid JSON; current configuration unchanged');
  }
  // Normalise arrays that may be absent in partial config files.
  parsed.spaces ??= [];
  parsed.tokens ??= [];
  parsed.networks ??= [];
  validateOidcBlock(parsed);
  _config = parsed;
  // Fix permission bits without rewriting content — avoids overwriting a
  // host-side edit that hasn't propagated through the bind-mount yet.
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* non-POSIX host — ignore */ }
  return parsed;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

export function saveConfig(config: Config): void {
  _config = config;
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // Atomic write: write to temp file then rename
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  // Ensure permissions after write
  fs.chmodSync(CONFIG_PATH, 0o600);
}

// ── Secrets ────────────────────────────────────────────────────────────────

export function loadSecrets(): SecretsFile {
  checkPermissions(SECRETS_PATH);
  if (!fs.existsSync(SECRETS_PATH)) {
    // Pre-setup: no secrets file yet — return empty shell
    _secrets = { peerTokens: {} };
    return _secrets;
  }
  const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
  _secrets = JSON.parse(raw) as SecretsFile;
  return _secrets;
}

export function getSecrets(): SecretsFile {
  if (!_secrets) return loadSecrets();
  return _secrets;
}

export function saveSecrets(secrets: SecretsFile): void {
  _secrets = secrets;
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  const tmp = SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SECRETS_PATH);
  fs.chmodSync(SECRETS_PATH, 0o600);
}

// ── Schema Library ─────────────────────────────────────────────────────────

let _schemaLibrary: SchemaLibraryEntry[] | null = null;

/**
 * Load schema-library.json from disk. Returns an empty array if the file
 * does not exist yet (first run before any entry is created).
 */
export function loadSchemaLibrary(): SchemaLibraryEntry[] {
  if (!fs.existsSync(SCHEMA_LIB_PATH)) {
    _schemaLibrary = [];
    return _schemaLibrary;
  }
  try {
    checkPermissions(SCHEMA_LIB_PATH);
    const raw = fs.readFileSync(SCHEMA_LIB_PATH, 'utf8');
    _schemaLibrary = JSON.parse(raw) as SchemaLibraryEntry[];
  } catch (err) {
    log.warn(`schema-library.json could not be loaded — treating as empty: ${err}`);
    _schemaLibrary = [];
  }
  return _schemaLibrary;
}

/** Return the in-memory schema library, loading from disk if not yet loaded. */
export function getSchemaLibrary(): SchemaLibraryEntry[] {
  if (!_schemaLibrary) return loadSchemaLibrary();
  return _schemaLibrary;
}

/** Atomically persist the schema library to disk. */
export function saveSchemaLibrary(entries: SchemaLibraryEntry[]): void {
  _schemaLibrary = entries;
  fs.mkdirSync(path.dirname(SCHEMA_LIB_PATH), { recursive: true });
  const tmp = SCHEMA_LIB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SCHEMA_LIB_PATH);
  try { fs.chmodSync(SCHEMA_LIB_PATH, 0o600); } catch { /* non-POSIX — ignore */ }
}

// ── Defaults ───────────────────────────────────────────────────────────────

export function getEmbeddingConfig() {
  const cfg = getConfig();
  // No baseUrl in the default = use the bundled local ONNX model.
  // Set baseUrl in config.json to override with an HTTP endpoint (e.g. Ollama).
  return cfg.embedding ?? {
    model: 'nomic-ai/nomic-embed-text-v1.5',
    dimensions: 768,
    similarity: 'cosine' as const,
  };
}

export function getMongoUri(): string {
  const cfg = _config;
  return cfg?.mongo?.uri ?? process.env['MONGO_URI'] ?? 'mongodb://ythril-mongo:27017/?directConnection=true';
}

export function getDataRoot(): string {
  return process.env['DATA_ROOT'] ?? '/data';
}
