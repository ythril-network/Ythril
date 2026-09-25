import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.js';
import { numericEnvOrExit } from './setting-bounds.js';
import { pinnedFieldsFromEnv } from './pinned-fields.js';
import type { Config, SecretsFile, SchemaLibraryEntry, SchemaCatalog } from './types.js';
import { normalizeDocExtractionMode } from './types.js';
import { resolveMasterSecret, isEnvelope, encryptEnvelope, decryptEnvelope } from './secretbox.js';
import { envIntOpt } from './env-num.js';
import { migrateTokenRightsOnBoot } from '../auth/backfill-token-rights.js';

const CONFIG_PATH = process.env['CONFIG_PATH'] ?? '/config/config.json';
const SECRETS_PATH = path.join(path.dirname(CONFIG_PATH), 'secrets.json');
const SCHEMA_LIB_PATH = path.join(path.dirname(CONFIG_PATH), 'schema-library.json');
const SCHEMA_CATALOGS_PATH = path.join(path.dirname(CONFIG_PATH), 'schema-catalogs.json');

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
  // Typed strictly on purpose: `"allowPrivateIssuer": "true"` is not `true`, so it would read as OFF
  // and an internal IdP would stop authenticating with no indication why — the precise failure this
  // flag exists to prevent. A quoted boolean in hand-edited JSON is a common enough slip to catch here.
  if (oidc.allowPrivateIssuer !== undefined && typeof oidc.allowPrivateIssuer !== 'boolean') {
    throw new Error('oidc.allowPrivateIssuer must be a boolean (true/false, unquoted) when provided');
  }
}

// ── At-rest encryption (PR-S2) ─────────────────────────────────────────────
// The state files are transparently encrypted when a master secret is configured
// (YTHRIL_MASTER_KEY / YTHRIL_MASTER_PASSPHRASE). Detection is by envelope marker, so plaintext files
// keep working (back-compat) and are migrated in place by migrateStateFilesAtRest() at boot.

const STATE_FILES = [CONFIG_PATH, SECRETS_PATH, SCHEMA_LIB_PATH, SCHEMA_CATALOGS_PATH];

/** Decrypt if the raw file is an envelope; pass through if plaintext. Throws (never returns ciphertext)
 *  when a file is encrypted but the master secret is missing or wrong — the caller turns that into a
 *  hard boot failure rather than silently starting with unreadable/empty state. */
function decodeStateFile(raw: string, label: string): string {
  if (!isEnvelope(raw)) return raw;
  const secret = resolveMasterSecret();
  if (!secret) {
    throw new Error(`${label} is encrypted at rest but no master secret is configured — set YTHRIL_MASTER_KEY or YTHRIL_MASTER_PASSPHRASE`);
  }
  try {
    return decryptEnvelope(raw, secret);
  } catch (err) {
    throw new Error(`Failed to decrypt ${label} (wrong master secret or corrupt file): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Encrypt for writing when a master secret is configured; otherwise write plaintext. */
function encodeStateFile(serialized: string): string {
  const secret = resolveMasterSecret();
  return secret ? encryptEnvelope(serialized, secret) : serialized;
}

/** True when at-rest encryption is currently active (a master secret is configured). */
export function atRestEncryptionActive(): boolean {
  return resolveMasterSecret() !== null;
}

/** Whether the operator requires state files to be encrypted at rest (env → config → default false). */
export function requireEncryptedAtRest(): boolean {
  if (process.env['YTHRIL_REQUIRE_ENCRYPTED_AT_REST'] === 'true') return true;
  try { return getConfig().requireEncryptedAtRest === true; } catch { return false; }
}

/**
 * Encrypt any still-plaintext state file in place when a master secret is configured (upgrade path).
 * Each migration is round-trip verified before the atomic replace, and no plaintext copy is left behind.
 * Idempotent: already-encrypted files are skipped. Call once at boot BEFORE loadConfig().
 */
export function migrateStateFilesAtRest(): void {
  const secret = resolveMasterSecret();
  if (!secret) return;
  for (const p of STATE_FILES) {
    let raw: string;
    try {
      if (!fs.existsSync(p)) continue;
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      throw new Error(`At-rest migration: cannot read ${path.basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!raw.trim() || isEnvelope(raw)) continue; // empty or already encrypted
    const enc = encryptEnvelope(raw, secret);
    if (decryptEnvelope(enc, secret) !== raw) {
      throw new Error(`At-rest migration: round-trip verification failed for ${path.basename(p)} — leaving it unchanged`);
    }
    const tmp = p + '.enc.tmp';
    fs.writeFileSync(tmp, enc, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* non-POSIX host */ }
    log.info(`Encrypted ${path.basename(p)} at rest`);
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

/**
 * One-time migration for the removed media-embedding master switch.
 *
 * Media embedding is now always-on, controlled per class by `mediaEmbedding.levels`. An instance that
 * had the old `enabled:false` must NOT silently start embedding on upgrade, so map it to the equivalent
 * per-class state: force images/audio/video to `off` (the master switch used to override the levels, so
 * this preserves exact prior behaviour). Then drop the dead `enabled` field. Idempotent — a no-op once
 * `enabled` is gone.
 *
 * Must be DURABLE (rewrite config.json), not applied only in `getMediaEmbeddingConfig()`: the
 * media-config PATCH handler merges the RAW on-disk block, so an in-memory-only migration would be
 * undone — and would flip media ON — the next time an admin saved a setting.
 *
 * @returns true if it changed the config (caller persists).
 */

export function migrateMediaEmbeddingMasterSwitch(config: Config): boolean {
  const media = config.mediaEmbedding as (MediaEmbeddingConfig & { enabled?: boolean }) | undefined;
  if (!media || !('enabled' in media)) return false;
  const wasDisabled = media.enabled === false;
  delete media.enabled;
  if (wasDisabled) {
    media.levels = { ...(media.levels ?? {}) };
    media.levels.images = 'off';
    media.levels.audio = 'off';
    media.levels.video = 'off';
  }
  return true;
}

/**
 * A space's `description` becomes its `meta.purpose`.
 *
 * The two fields say the same thing — `description` is commented "shown to MCP clients as space-level
 * instructions" and `purpose` is "short directive injected into MCP instructions at handshake" — and they
 * were served by different tools: `space_meta` returned purpose, `list_spaces` returned description.
 * The UI stopped offering an editor for description when purpose arrived, so on a real deployment the
 * field every MCP client reads was the one no admin could change: three spaces returning null, three
 * returning mojibake from an old import, and the purposes their admins had written sitting invisible.
 *
 * Only fills an EMPTY purpose. A space that has both keeps its purpose — that is the field the operator
 * edited most recently and deliberately, and clobbering it with legacy text would be the worse failure.
 * Either way `description` is dropped, so the alias below has one place to read from.
 *
 * Durable and boot-time rather than lazy, which is allowed because `config.json` is LOCAL state — it does
 * not replicate to peers, so there is no window where two instances disagree about whether the migration
 * ran. (A synced collection would need the self-healing treatment instead.)
 *
 * @returns true if it changed the config (caller persists).
 */
export function migrateSpaceDescriptionToPurpose(config: Config): boolean {
  let changed = false;
  for (const space of config.spaces ?? []) {
    const legacy = (space as { description?: string }).description;
    if (legacy === undefined) continue;
    const text = legacy.trim();
    if (text && !space.meta?.purpose?.trim()) {
      space.meta = { ...(space.meta ?? {}), purpose: text.slice(0, 4_000) };
    }
    delete (space as { description?: string }).description;
    changed = true;
  }
  return changed;
}

/**
 * Face recognition lost its own on/off switch — the image ladder's `recognition` rung is the gate now,
 * and `faceRecognition.enabled` survives only as the infra (env) pin.
 *
 * The danger this migration exists to prevent: `enabled` used to default to **false**, so on almost every
 * instance faces were OFF while the image ceiling sat at its old default of `auto` — which the ladder
 * reads as "recognition allowed". Simply dropping the switch would therefore have started face detection
 * and stored face EMBEDDINGS — biometric data — on upgrade, with nobody having asked for it.
 *
 * So: wherever faces were effectively off (`enabled: false` in the stored config) and the image ceiling
 * would now permit them, lower that ceiling to `caption`. `caption` is the faithful translation of the old
 * state — images were still described and embedded, only faces were skipped — whereas `off` would also
 * silently stop captioning. Then drop the dead field so the new default (true = infra pin only) applies.
 *
 * Durable, like `migrateMediaEmbeddingMasterSwitch`: the media-config PATCH handler merges the RAW on-disk
 * block, so an in-memory-only fix would be undone — and would flip faces ON — the next time an admin saved.
 * Idempotent: a no-op once `enabled` is gone.
 *
 * @returns true if it changed the config (caller persists).
 */
export function migrateFaceRecognitionSwitch(config: Config): boolean {
  const media = config.mediaEmbedding;
  const face = media?.faceRecognition as (FaceRecognitionConfig & { enabled?: boolean }) | undefined;
  if (!media || !face || !('enabled' in face)) return false;
  const wasDisabled = face.enabled === false;
  delete face.enabled;
  if (wasDisabled) {
    const levels = { ...(media.levels ?? {}) };
    // Only lower a ceiling that would newly permit faces; anything at/below `caption` already agrees.
    if (levels.images === undefined || levels.images === 'auto' || levels.images === 'recognition') {
      levels.images = 'caption';
    }
    media.levels = levels;
  }
  return true;
}

export function loadConfig(): Config {
  checkPermissions(CONFIG_PATH);
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(decodeStateFile(raw, 'config.json')) as Config;
  // Normalise arrays that may be absent in partial config files written before
  // first-run setup completes (e.g. a config pre-seeded with only storage quotas).
  parsed.spaces ??= [];
  parsed.tokens ??= [];
  parsed.networks ??= [];
  _config = parsed;
  validateOidcBlock(_config);
  // Derive the per-space rights matrix for any token that has none. IN MEMORY ONLY, and deliberately not
  // persisted: enforcement still reads the legacy fields, so this run is an observation rather than a
  // change. Writing it to config.json would make a derivation defect durable before anything has compared
  // it against the behaviour it is meant to reproduce.
  //
  // A boot migration is the right shape here at all only because tokens are LOCAL state — config.json does
  // not sync. Synced data must be migrated lazily and self-healingly instead.
  migrateTokenRightsOnBoot(_config);

  // Durable one-time migration of the removed media-embedding master switch (writes config.json once).
  if (migrateMediaEmbeddingMasterSwitch(_config)) {
    try {
      saveConfig(_config);
      log.info('Migrated mediaEmbedding.enabled → per-class levels (media-embedding master switch removed)');
    } catch (err) {
      log.warn(`Could not persist mediaEmbedding master-switch migration (will retry next boot): ${err}`);
    }
  }
  // A provider API key left in config.json moves to secrets.json (0o600) and is deleted from the config.
  migrateProviderApiKeysOnBoot(_config, getSecrets(), saveSecrets, saveConfig);
  // The config-file half of the 2.1 rename moves onto `vision.*` / `stt.*`. The ENV-VAR half is
  // removed in 4.0 and now refuses the boot — see `env-removed.ts`.
  migrateMediaAliasesOnBoot(_config, saveConfig);
  // Legacy space `description` → `meta.purpose`, so the field MCP clients read is the field the UI edits.
  if (migrateSpaceDescriptionToPurpose(_config)) {
    try {
      saveConfig(_config);
      log.info('Migrated space description → meta.purpose (one field, and it is the editable one)');
    } catch (err) {
      log.warn(`Could not persist space description migration (will retry next boot): ${err}`);
    }
  }
  // A stored `syncSchedule` shorthand becomes the cron expression it always translated to. The shorthands
  // are refused at input since 4.0, and a config written under the old rule must keep syncing at the rate
  // it was given rather than be refused for a value that was valid when it was saved.
  {
    const { changed, unrunnable } = migrateSyncScheduleShorthands(_config);
    if (changed) {
      try {
        saveConfig(_config);
        log.info('Migrated legacy syncSchedule shorthand(s) to cron (same schedule, the spelling that still runs)');
      } catch (err) {
        log.warn(`Could not persist syncSchedule migration (will retry next boot): ${err}`);
      }
    }
    // Not a migration failure: these never resolved to anything, so the network has been on manual sync
    // since the day the value was set — and nothing has said so except a startup line about a value the
    // operator no longer remembers typing. Naming them is the first time such an instance is told.
    for (const { networkId, schedule } of unrunnable) {
      log.warn(`Network ${networkId} has syncSchedule '${schedule}', which has never been runnable — it is `
        + 'outside the range cron accepts, so this network syncs only when triggered by hand. Set a cron expression '
        + 'under Settings → Networks to schedule it.');
    }
  }

  // Same shape, for the face-recognition switch: the image ladder is the gate now, so an instance that had
  // faces off must have its image ceiling lowered rather than silently gaining a biometric store.
  if (migrateFaceRecognitionSwitch(_config)) {
    try {
      saveConfig(_config);
      log.info('Migrated mediaEmbedding.faceRecognition.enabled → image ladder (face switch removed; env pin retained)');
    } catch (err) {
      log.warn(`Could not persist face-recognition switch migration (will retry next boot): ${err}`);
    }
  }
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
    parsed = JSON.parse(decodeStateFile(raw, 'config.json')) as Config;
  } catch (err) {
    log.error(`reloadConfig: config.json has invalid JSON — keeping current config: ${err}`);
    throw new Error('config.json contains invalid JSON; current configuration unchanged');
  }
  // Normalise arrays that may be absent in partial config files.
  parsed.spaces ??= [];
  parsed.tokens ??= [];
  parsed.networks ??= [];
  validateOidcBlock(parsed);
  // Refresh the EXISTING object in place rather than swapping in a new one.
  //
  // Callers routinely do `const cfg = getConfig()`, await something, then
  // `saveConfig(cfg)`. If a reload replaced `_config`, that held reference would
  // be detached, and saving it would write pre-reload content — reverting the very
  // edit the reload just picked up. Ten such call sites exist (spaces lifecycle,
  // rename, invite, tokens, network join); mutating in place keeps every one of
  // them pointing at fresh data, so their own change merges on top instead of
  // replacing it.
  //
  // Caveat worth knowing: a reference held to a NESTED object (a single `space`
  // out of `cfg.spaces`) is still detached, because the arrays are replaced
  // wholesale. Those sites are listed in ARCHITECTURE-TODO and want `mutateConfig`.
  if (_config) {
    const mutable = _config as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) delete mutable[key];
    Object.assign(_config, parsed);
    parsed = _config;
  } else {
    _config = parsed;
  }
  // Fix permission bits without rewriting content — avoids overwriting a
  // host-side edit that hasn't propagated through the bind-mount yet.
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* non-POSIX host — ignore */ }
  recordConfigMtime(); // we are now in sync with what is on disk
  return parsed;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

// ── Config persistence ───────────────────────────────────────────────────────
// Two write paths share config.json:
//   • saveConfig()      — durable & synchronous. Used by every correctness- or
//                         security-critical mutation (tokens, spaces, networks,
//                         setup). Behaviour is unchanged: the change is on disk
//                         before the call returns.
//   • saveConfigSoon()  — coalesced & asynchronous. Used ONLY by the sync engine
//                         hot path (P2), which persists tiny bookkeeping fields —
//                         pull/push watermarks, per-member failure counters,
//                         lastSyncAt — dozens to hundreds of times per cycle. Done
//                         synchronously, each was a whole-file write that blocked
//                         the event loop and stalled all request handling. These
//                         fields are runtime state, not configuration: losing the
//                         last few on a crash is harmless (watermarks re-derive by
//                         seq on the next pull, counters are cosmetic), so they are
//                         safe to flush lazily off the event loop.
//
// A monotonic generation counter lets the two paths coexist without a torn or
// stale write: every in-memory mutation bumps `_writeGeneration`; the async
// flush records the generation it commits, and a synchronous durable write that
// lands a newer generation mid-flush causes the async flush to discard its
// now-stale snapshot instead of clobbering the fresher on-disk copy.

let _writeGeneration = 0;   // bumped on every in-memory config mutation via save*
let _flushedGeneration = 0; // highest generation already durably on disk
let _flushScheduled = false;
let _flushChain: Promise<void> = Promise.resolve();

/**
 * Apply a small change to config.json without clobbering whatever else has landed
 * on disk since our in-memory copy was loaded.
 *
 * `saveConfig` serialises the whole in-memory config, so the usual read-mutate-save
 * shape is last-writer-wins: any edit another writer made to the file in between —
 * an operator's hand edit, a `pendingSpaceOp` crash marker, a space created by a
 * concurrent request — is silently erased. That is tolerable for a request handler,
 * which mutates and saves within a few milliseconds, but not for a background task
 * that captured its snapshot and then waited: vector-index readiness polling can hold
 * one for a minute before writing a single field back.
 *
 * Re-reading immediately before the write closes that window to the same few
 * milliseconds a request handler already has. It is not a substitute for real
 * locking — two processes can still interleave — but it stops a stale snapshot from
 * resurrecting old state wholesale.
 */
export function mutateConfig(apply: (config: Config) => void): void {
  const fresh = reloadConfig();
  apply(fresh);
  saveConfig(fresh);
}

export function saveConfig(config: Config): void {
  _config = config;
  const gen = ++_writeGeneration;
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // Atomic write: write to temp file then rename
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, encodeStateFile(JSON.stringify(config, null, 2)), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  // Ensure permissions after write
  fs.chmodSync(CONFIG_PATH, 0o600);
  if (gen > _flushedGeneration) _flushedGeneration = gen;
  recordConfigMtime();
}

// ── External-change watcher ────────────────────────────────────────────────
//
// The running server treats its in-memory config as authoritative and writes the
// whole thing back on every change. That makes the copy stale the moment anyone
// edits config.json directly, and the next write silently reverts their edit —
// with no error and no log line. `mutateConfig` fixes this for a single writer;
// it cannot fix the 67 call sites that save a config they already hold, and
// converting them all would still leave the next one someone writes exposed.
//
// So watch the file instead of policing the writes: reload when it changes
// underneath us, and every existing call site becomes correct untouched.
//
// `fs.watchFile` (stat polling) rather than `fs.watch` (inotify): config.json
// normally lives on a Docker Desktop bind mount, where inotify events are
// unreliable and can be missed entirely — see the propagation note on
// reloadConfig. Polling a single stat every couple of seconds costs nothing and
// works the same on every host.

let _configWatchActive = false;
let _lastKnownMtimeMs = 0;
let _reloadChain: Promise<void> = Promise.resolve();

/** Remember the mtime we just produced, so our own writes don't look foreign. */
function recordConfigMtime(): void {
  try { _lastKnownMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* file may not exist yet */ }
}

/**
 * Reload config.json whenever it changes on disk by any hand but ours.
 *
 * `onExternalChange` receives control after the file has been detected as
 * changed and is responsible for the actual reload — it lives in the caller so
 * this module stays free of dependencies on spaces, auth and secrets. It runs
 * the same path as `POST /api/admin/reload-config`, because a hand-added space
 * needs initialising, not merely parsing.
 */
export function startConfigWatcher(
  onExternalChange: () => Promise<void> | void,
  intervalMs = 2000,
  /**
   * Told whether each WATCHED reload applied, so somebody other than the log can know (`Q-43`).
   *
   * A callback rather than this module touching the metrics registry, and that is not style: `registry.ts`
   * reaches back here through `quota` and `db/mongo`, so importing it would close a runtime import cycle —
   * which `no-runtime-import-cycles.test.js` refuses, correctly. The composition root wires it to the two
   * metrics, the same shape `setPostureProvider` uses for the same reason.
   *
   * Optional because a caller that does not care must not have to care, and the watcher's behaviour is
   * unchanged without it.
   */
  onReloadOutcome?: (applied: boolean) => void,
): void {
  if (_configWatchActive) return;
  _configWatchActive = true;
  recordConfigMtime();

  fs.watchFile(CONFIG_PATH, { interval: intervalMs, persistent: false }, curr => {
    if (curr.mtimeMs === 0) return;                    // removed, or mid-replace
    if (curr.mtimeMs === _lastKnownMtimeMs) return;    // our own write
    // A write of ours is in flight — either the coalesced flush has not run yet, or
    // it has renamed the file but not yet recorded the resulting mtime. Reloading now
    // would read our own bytes back as if they were foreign and, worse, discard the
    // in-memory change that is still waiting to be flushed. Skip; the next poll sees
    // any genuinely foreign edit.
    if (_writeGeneration > _flushedGeneration) return;
    // Claim this version before reloading. If the reload throws — an operator
    // saved half a file — we do not retry the same broken bytes every tick; the
    // next edit changes the mtime and we try again.
    _lastKnownMtimeMs = curr.mtimeMs;
    log.info('config.json changed on disk — reloading');
    _reloadChain = _reloadChain
      .catch(() => { /* a prior failure must not break the chain */ })
      .then(() => onExternalChange())
      .then(() => { recordConfigMtime(); onReloadOutcome?.(true); })
      .catch(err => {
        /*
         * A LOG LINE IS NOT ENOUGH HERE, and `Q-43` is why.
         *
         * There is no caller to return a status to — that is what a watcher is — so this catch was the
         * whole trace. The canary operator's edit sat out of effect until the next restart and the only
         * evidence was this line, in a pod log nobody was tailing.
         *
         * The mtime was claimed ABOVE, before the reload, so nothing retries this on its own: what is
         * running stays older than what is on disk until somebody writes the file again. That is why the
         * outcome is reported as a CONDITION and not only as an event.
         */
        onReloadOutcome?.(false);
        log.error(`Reload after external config change failed; keeping current config: ${err}`);
      });
  });
}

/**
 * Persist config.json off the event loop, coalescing bursts. For the sync
 * engine's high-frequency bookkeeping writes only — see the header above.
 * Returns immediately; the write lands on a later tick.
 */
export function saveConfigSoon(config: Config): void {
  _config = config;
  _writeGeneration++;
  if (_flushScheduled) return; // a flush is already queued — it will pick up the latest state
  _flushScheduled = true;
  setImmediate(() => {
    _flushScheduled = false;
    // Serialize writes so two flushes never race on the temp file.
    _flushChain = _flushChain
      .catch(() => { /* a prior flush failure must not break the chain */ })
      .then(() => writeConfigAsync())
      .catch(err => log.error(`Async config flush failed: ${err}`));
  });
}

/** Atomically write the current in-memory config, unless a newer durable write
 *  has already superseded the snapshot we captured. Uses a distinct temp file so
 *  it never collides with saveConfig()'s synchronous write. */
async function writeConfigAsync(): Promise<void> {
  const gen = _writeGeneration;
  const config = _config;
  if (!config || gen <= _flushedGeneration) return; // nothing new to persist
  const snapshot = encodeStateFile(JSON.stringify(config, null, 2));
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.async.tmp';
  await fs.promises.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
  // A synchronous durable write may have landed a newer generation while we were
  // writing — if so our snapshot is stale, so discard it rather than clobber disk.
  if (_flushedGeneration >= gen) {
    await fs.promises.unlink(tmp).catch(() => { /* already gone */ });
    return;
  }
  await fs.promises.rename(tmp, CONFIG_PATH);
  try { await fs.promises.chmod(CONFIG_PATH, 0o600); } catch { /* non-POSIX host — ignore */ }
  if (gen > _flushedGeneration) _flushedGeneration = gen;
  recordConfigMtime(); // ours, not foreign — the watcher must not react to it
}

/**
 * Flush any pending coalesced config write to disk and wait for it. Call on
 * graceful shutdown so the last watermarks are persisted before exit.
 */
export async function flushConfig(): Promise<void> {
  await _flushChain.catch(() => { /* logged at the flush site */ });
  // A saveConfigSoon may have run after the last scheduled flush started — make a
  // final durable pass if anything is still unwritten.
  if (_config && _writeGeneration > _flushedGeneration) {
    saveConfig(_config);
  }
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
  _secrets = JSON.parse(decodeStateFile(raw, 'secrets.json')) as SecretsFile;
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
  fs.writeFileSync(tmp, encodeStateFile(JSON.stringify(secrets, null, 2)), { encoding: 'utf8', mode: 0o600 });
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
    _schemaLibrary = JSON.parse(decodeStateFile(raw, 'schema-library.json')) as SchemaLibraryEntry[];
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
  fs.writeFileSync(tmp, encodeStateFile(JSON.stringify(entries, null, 2)), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SCHEMA_LIB_PATH);
  try { fs.chmodSync(SCHEMA_LIB_PATH, 0o600); } catch { /* non-POSIX — ignore */ }
}

// ── Schema catalogs ────────────────────────────────────────────────────────

let _schemaCatalogs: SchemaCatalog[] | null = null;

/** Load schema-catalogs.json from disk. Returns empty array if not found. */
export function loadSchemaCatalogs(): SchemaCatalog[] {
  if (!fs.existsSync(SCHEMA_CATALOGS_PATH)) {
    _schemaCatalogs = [];
    return _schemaCatalogs;
  }
  try {
    checkPermissions(SCHEMA_CATALOGS_PATH);
    const raw = fs.readFileSync(SCHEMA_CATALOGS_PATH, 'utf8');
    _schemaCatalogs = JSON.parse(decodeStateFile(raw, 'schema-catalogs.json')) as SchemaCatalog[];
  } catch (err) {
    log.warn(`schema-catalogs.json could not be loaded — treating as empty: ${err}`);
    _schemaCatalogs = [];
  }
  return _schemaCatalogs;
}

/** Return the in-memory catalog list, loading from disk if not yet loaded. */
export function getSchemaCatalogs(): SchemaCatalog[] {
  if (!_schemaCatalogs) return loadSchemaCatalogs();
  return _schemaCatalogs;
}

/** Atomically persist the catalog list to disk. */
export function saveSchemaCatalogs(catalogs: SchemaCatalog[]): void {
  _schemaCatalogs = catalogs;
  fs.mkdirSync(path.dirname(SCHEMA_CATALOGS_PATH), { recursive: true });
  const tmp = SCHEMA_CATALOGS_PATH + '.tmp';
  fs.writeFileSync(tmp, encodeStateFile(JSON.stringify(catalogs, null, 2)), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SCHEMA_CATALOGS_PATH);
  try { fs.chmodSync(SCHEMA_CATALOGS_PATH, 0o600); } catch { /* non-POSIX — ignore */ }
}

// ── Defaults ───────────────────────────────────────────────────────────────

/**
 * Storage quotas, resolved env → config.json → unset, with the env-pinned fields reported.
 *
 * ## Why these needed an env layer
 *
 * Every other infra-shaped field — `allowPrivateModelEndpoints`, `modelPath`, the model endpoints —
 * is env-pinnable and lands in `lockedByInfra` precisely so the instance's own admin cannot widen it.
 * Storage limits were the exception: config.json only. On a host running several brains, the disk
 * ceiling is the host operator's call, not the tenant's, and it was the one setting the operator had no
 * way to bound from the Deployment.
 *
 * (The tenant could not raise it from Settings — no route writes `cfg.storage`, and none is added here.
 * But they own their config volume, so config-only meant unpinnable, which is the same gap by a
 * slightly longer path.)
 *
 * All six are separately pinnable. Six env vars is more surface than one, and the alternative — pinning
 * `total` alone — leaves the per-area limits widenable, which is the same hole in a smaller room.
 */
export interface ResolvedStorageConfig {
  total?: { softLimitGiB?: number; hardLimitGiB?: number };
  files?: { softLimitGiB?: number; hardLimitGiB?: number };
  brain?: { softLimitGiB?: number; hardLimitGiB?: number };
  /** Dotted paths pinned by an env var, e.g. `total.hardLimitGiB`. Rendered read-only by the UI. */
  lockedByInfra: string[];
}

const STORAGE_AREAS = ['total', 'files', 'brain'] as const;
const STORAGE_TIERS = [['soft', 'softLimitGiB'], ['hard', 'hardLimitGiB']] as const;

/**
 * The six storage pins, written out.
 *
 * The comment here used to claim they were "spelled out rather than derived, so the names are greppable"
 * while the function derived them from `area` and `tier` — so none of the six existed anywhere in the
 * source, `grep STORAGE_TOTAL_HARD_GIB` found nothing, and the doc-coverage gate could not tell them from
 * names that do not exist. Same fix as `SLOT_ENV_VARS` in the egress policy: six literals is the price of
 * a setting an operator can search for.
 */
const STORAGE_ENV_NAMES: Record<string, string> = {
  'total.soft': 'STORAGE_TOTAL_SOFT_GIB',
  'total.hard': 'STORAGE_TOTAL_HARD_GIB',
  'files.soft': 'STORAGE_FILES_SOFT_GIB',
  'files.hard': 'STORAGE_FILES_HARD_GIB',
  'brain.soft': 'STORAGE_BRAIN_SOFT_GIB',
  'brain.hard': 'STORAGE_BRAIN_HARD_GIB',
};

/** `STORAGE_TOTAL_HARD_GIB` etc., from the table above. */
function storageEnvName(area: string, tier: string): string {
  return STORAGE_ENV_NAMES[`${area}.${tier}`]
    ?? `STORAGE_${area.toUpperCase()}_${tier.toUpperCase()}_GIB`;
}

export function getStorageConfig(): ResolvedStorageConfig | undefined {
  let base: Record<string, { softLimitGiB?: number; hardLimitGiB?: number } | undefined> = {};
  try { base = (getConfig().storage ?? {}) as typeof base; } catch { /* pre-setup */ }

  const out: ResolvedStorageConfig = { lockedByInfra: [] };
  let any = false;

  for (const area of STORAGE_AREAS) {
    const resolved: { softLimitGiB?: number; hardLimitGiB?: number } = {};
    for (const [tier, field] of STORAGE_TIERS) {
      const raw = process.env[storageEnvName(area, tier)];
      if (raw !== undefined && raw.trim() !== '') {
        const n = Number(raw);
        // A malformed pin is IGNORED, loudly, rather than silently becoming NaN — a NaN limit compares
        // false against every usage figure, so the quota would read as configured and enforce nothing.
        if (Number.isFinite(n) && n >= 0) {
          resolved[field] = n;
          out.lockedByInfra.push(`${area}.${field}`);
          continue;
        }
        log.warn(`${storageEnvName(area, tier)}="${raw}" is not a non-negative number — ignoring it and falling back to config.json.`);
      }
      const fromConfig = base[area]?.[field];
      if (fromConfig !== undefined) resolved[field] = fromConfig;
    }
    if (resolved.softLimitGiB !== undefined || resolved.hardLimitGiB !== undefined) {
      out[area] = resolved;
      any = true;
    }
  }

  // Undefined, not an empty object: every caller treats "no storage config" as "quota disabled", and an
  // object with only `lockedByInfra` in it is truthy.
  return any ? out : undefined;
}

/**
 * The operator's per-slot call budgets, or `undefined` before setup.
 *
 * Returns the raw block rather than resolved numbers on purpose: `slotTimeoutMs()` is pure and lives in a leaf
 * module that imports nothing, so every call site resolves through the same function instead of this file
 * growing ten getters. The `catch` is the pre-setup case — a model call during first run takes its default,
 * which is what it did before any of this was configurable.
 */
export function getModelSlots(): Config['modelSlots'] {
  try { return getConfig().modelSlots; } catch { return undefined; }
}

export function getEmbeddingConfig() {
  const cfg = getConfig();
  // No baseUrl in the default = use the bundled local ONNX model.
  // Set baseUrl in config.json to override with an HTTP endpoint (e.g. Ollama).
  const base: Partial<EmbeddingConfig> = cfg.embedding ?? {};
  /*
   * API key: env > secrets.json. NOT from config.json, and the arm that read it is gone as of 4.0.
   *
   * This comment used to say "env > secrets.json > legacy inline config. Never surfaced from config.json",
   * which contradicts itself in one sentence — and the code had the third arm (`?? base.apiKey`). The four
   * media providers had been held to "no config fallback" since 3.0, for the reason stated in
   * `migrate-provider-keys.ts`: a fallback keeps a credential working from a file that is not `0o600`, so
   * nobody ever notices it is there. `embedding` was not one of the four names that rule was written
   * against, so it kept its arm for a release.
   *
   * Deleting the arm is safe because `migrateProviderApiKeysToSecrets` lifts the key into the in-memory
   * SECRETS object, and it runs inside `loadConfig` before any resolver is called — so the value is already
   * where this looks for it whether or not either file write succeeded. (That is what separates this from
   * the four config migrations 4.0 ruled PERMANENT: theirs are only load-bearing when the write FAILS.)
   */
  let embApiKey: string | undefined = process.env['EMBEDDING_API_KEY'];
  if (!embApiKey) {
    try { embApiKey = (getSecrets() as { embedding?: { apiKey?: string } }).embedding?.apiKey; } catch { /* pre-setup */ }
  }
  // Defaults are applied PER FIELD, not `cfg.embedding ?? {…}`: a PARTIAL stored block (e.g. after a PATCH
  // that only changed `provider`) must still yield a complete config — `model`/`dimensions` are load-bearing
  // for vector-index creation, so they can never be undefined. Env pins ("fix-set") win over config; each
  // pinned field is reported in lockedByInfra so the UI renders it read-only.
  return {
    baseUrl: process.env['EMBEDDING_URL'] ?? base.baseUrl,
    model: process.env['EMBEDDING_MODEL'] ?? base.model ?? 'nomic-ai/nomic-embed-text-v1.5',
    dimensions: envIntOpt('EMBEDDING_DIMENSIONS') ?? base.dimensions ?? 768,
    // Left `undefined` when unset on purpose: `embedConcurrency()` picks a different default per embedder,
    // so a number here would flatten that distinction. Clamping happens there, in one place.
    embedConcurrency: envIntOpt('EMBEDDING_CONCURRENCY') ?? base.embedConcurrency,
    similarity: base.similarity ?? ('cosine' as const),
    provider: (process.env['EMBEDDING_PROVIDER'] as 'local' | 'external' | undefined) ?? base.provider ?? 'local',
    // 'auto' resolves to the pre-existing behaviour (see resolvePrefixScheme in brain/embedding.ts), so an
    // instance that never sets this keeps embedding exactly as it did.
    prefixScheme: (process.env['EMBEDDING_PREFIX_SCHEME'] as 'auto' | 'none' | 'nomic' | 'qwen' | undefined)
      ?? base.prefixScheme ?? 'auto',
    apiKey: embApiKey,
  };
}

/** The external embedding endpoint's API key, resolved (env > secrets). Never from config.json — the arm
 *  that read it was deleted in 4.0, and a stored one is lifted into `secrets.json` at boot. */
export function getEmbeddingApiKey(): string | undefined {
  return getEmbeddingConfig().apiKey;
}

export function getMongoUri(): string {
  const cfg = _config;
  // An explicit URI always wins — infra-managed deployments (managed Atlas, an existing
  // cluster) must be able to override, and they carry their own credentials.
  const explicit = process.env['MONGO_URI'] ?? cfg?.mongo?.uri;
  if (explicit) return explicit;

  // Otherwise we are talking to the BUNDLED `ythril-mongo` container. If the operator
  // supplied credentials for it, authenticate — the bundled database is unauthenticated
  // by default, which means anything that can reach port 27017 can read and rewrite every
  // space, bypassing tokens, space scoping and the audit log entirely (see S7).
  //
  // Credentials are optional so that EXISTING installs keep working: MongoDB cannot have
  // auth switched on in place (the Atlas Local image only provisions the replica-set
  // keyfile on a first init), so an existing database must be migrated deliberately.
  const user = process.env['MONGO_USERNAME'];
  const pass = process.env['MONGO_PASSWORD'];
  if (user && pass) {
    // Percent-encode: a password may legitimately contain `@`, `:`, `/` etc., which would
    // otherwise be parsed as URI delimiters and produce a confusing connection failure.
    const creds = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
    return `mongodb://${creds}@ythril-mongo:27017/ythril?directConnection=true&authSource=admin`;
  }

  return 'mongodb://ythril-mongo:27017/ythril?directConnection=true';
}

export function getDataRoot(): string {
  return process.env['DATA_ROOT'] ?? '/data';
}

// ── Media Embedding Config ─────────────────────────────────────────────────

import type { MediaEmbeddingConfig, MediaProviderConfig, FaceRecognitionConfig, DocumentProcessingConfig, EmbeddingConfig, RerankConfig } from './types.js';
import { migrateProviderApiKeysOnBoot } from './migrate-provider-keys.js';
import { migrateMediaAliasesOnBoot } from './migrate-media-aliases.js';
import { migrateSyncScheduleShorthands } from '../sync/schedule.js';

const MEDIA_EMBEDDING_DEFAULTS: Required<Omit<MediaEmbeddingConfig, 'vision' | 'stt' | 'nli' | 'rerank' | 'ollamaUrl' | 'visionModel' | 'whisperUrl' | 'whisperModel' | 'lockedByInfra' | 'pinnedUnknown' | 'infraManaged' | 'faceRecognition' | 'documentProcessing'>> = {
  // Media embedding is always on (no master switch). Each class is gated by its `levels` entry, which
  // defaults to `auto` (no policy limit of its own). The bundled ollama + whisper services (K8s
  // manifests + the workstation docker-compose) back the default `vision`/`stt` endpoints, which resolve
  // via the short service name in both environments (Docker bridge DNS; ClusterFirst DNS in K8s).
  // `auto` means "the most this instance can do" and stays exactly that — but it is deliberately NOT the
  // default for IMAGES. `auto` resolves to the `recognition` rung, which detects faces and stores face
  // embeddings: biometric data. Nobody should acquire a biometric store by installing the software and
  // leaving the defaults alone, so images start at `caption` (described + embedded, no faces) and an
  // admin raises the ceiling to `recognition`/`auto` deliberately. The other classes have no comparable
  // rung, so they keep `auto`.
  levels: { images: 'caption', audio: 'auto', video: 'auto', text: 'auto' },
  visionProvider: 'local',
  sttProvider: 'local',
  workerConcurrency: 2,
  workerPollIntervalMs: 1000,
  workerMaxPollIntervalMs: 30_000,
  fallbackToExternal: false,
  maxFileSizeBytes: 524_288_000, // 500 MiB
  stalledJobTimeoutMs: 300_000,  // 5 min
};

/**
 * Default media size cap (500 MiB). Single source for the fallback used when a resolved config
 * omits `maxFileSizeBytes` — previously hand-copied as the `524_288_000` literal in three dispatch
 * sites.
 */
export const DEFAULT_MEDIA_MAX_FILE_SIZE_BYTES = MEDIA_EMBEDDING_DEFAULTS.maxFileSizeBytes;

/**
 * Resolve the full media embedding configuration by merging:
 *   1. Environment variables (highest precedence)
 *   2. config.json `mediaEmbedding` block
 *   3. Built-in defaults (lowest precedence)
 *
 * Populates `lockedByInfra` with any key whose effective value came from an
 * env var — the Settings UI uses this list to render those fields as read-only.
 */
/** Correct the invalid Ollama model name `moondream2` (which 404s on pull) to the
 *  real registry name `moondream`. Applied to the resolved vision model from any
 *  source so installs that saved the bad name keep working after the fix. */
function normalizeVisionModel(model: string): string {
  return model === 'moondream2' ? 'moondream' : model;
}

/*
 * `RENAMED_ENV_VARS`, `envRenamed`, its once-per-process warning and its test seam were HERE. 4.0 removed
 * them, and the three legacy names now refuse the boot instead of resolving — see `env-removed.ts` for why
 * that is the only honest third option: a variable that is set and configures nothing is worse than one
 * that errors, and worse than one that works.
 *
 * **Why the rename happened is still worth knowing, because the reasoning outlives the aliases.** The old
 * names described the implementation that happened to be first rather than the field they configure.
 * `OLLAMA_URL` is the clearest case: it set `vision.baseUrl`, which applies even when `visionProvider` is
 * `external`, so an operator running vLLM or llama.cpp either set a variable named after a product they
 * were not using or never found it at all. `WHISPER_URL` / `WHISPER_MODEL` did the same to anyone whose STT
 * backend was not Whisper — reported by a deployment running Qwen3-ASR. It is the distinction the
 * `local` / `external` provider switch already gets right: **the setting names a wire protocol, not a
 * product.**
 *
 * The block that stood here argued the aliases should live indefinitely, because breaking a documented env
 * var to improve its spelling is not a trade worth making. That was the standing decision for the whole of
 * 3.x; the owner reversed it on 2026-09-02, and the notice shipped one release ahead of this removal.
 */
export function getMediaEmbeddingConfig(): MediaEmbeddingConfig {
  const cfg = getConfig();
  const base = cfg.mediaEmbedding ?? {};
  const locked: string[] = [];
  // Read once per call rather than at module load: the tests set and unset the variable between cases, and a
  // module-scope snapshot would make the first test that touched it decide the answer for every later one.
  const pinnedFields = pinnedFieldsFromEnv();

  function pick<T>(envKey: string, fieldName: string, configVal: T | undefined, defaultVal: T): T {
    const envRaw = process.env[envKey];
    if (envRaw !== undefined) {
      // Use the explicit field name so the UI's `isLocked('fallbackToExternal')`
      // check matches — derived camelCase (e.g. `mediaEmbeddingFallbackToExternal`)
      // would silently NOT lock the UI control.
      locked.push(fieldName);
      /*
       * Numeric coercion, VALIDATED.
       *
       * This was `Number(envRaw)` and checked nothing, so a typo travelled as NaN rather than stopping the
       * boot. `maxFileSizeBytes` shows why that is not merely untidy: `dispatch.ts` asks
       * `input.bytes > maxBytes`, and every comparison against NaN is false — so `MAX_FILE_SIZE_BYTES=1O24`
       * does not raise the media size limit, it removes it, for every upload, with nothing in the log.
       * `??` cannot rescue it either, because NaN is not nullish.
       *
       * `env-num.ts` exists for exactly this and calls its registry "exhaustive by design". It was not: the
       * gate asserting so greps for `Number(process.env[…])` as ONE expression, and this reads the variable
       * into `envRaw` first. One assignment between the two halves and five settings were invisible to it.
       */
      if (typeof defaultVal === 'number') return numericEnvOrExit(envKey, envRaw) as T;
      // boolean coercion
      if (typeof defaultVal === 'boolean') return (envRaw === 'true' || envRaw === '1') as unknown as T;
      return envRaw as unknown as T;
    }
    return configVal !== undefined ? configVal : defaultVal;
  }

  const visionProvider = pick('VISION_PROVIDER', 'visionProvider', base.visionProvider, MEDIA_EMBEDDING_DEFAULTS.visionProvider) as 'local' | 'external';
  const sttProvider = pick('STT_PROVIDER', 'sttProvider', base.sttProvider, MEDIA_EMBEDDING_DEFAULTS.sttProvider) as 'local' | 'external';

  // Vision provider block — each sub-field has its own env var
  // `lockedByInfra` keys off the RESOLVED value below, so it stays correct whichever spelling was used.
  // Keying it off the current name alone would leave the UI field editable while the legacy env var
  // silently won — the same "looks configured, isn't" class of bug as the probe fix in #546.
  const visionBaseUrlEnv = process.env['VISION_BASE_URL'];
  const visionModelEnv = process.env['VISION_MODEL'];
  const visionApiKeyEnv = process.env['VISION_API_KEY'];
  // API keys: env var > secrets.json. The `config.json` fallback was removed in 3.0 — any key still
  // there is lifted into secrets.json at boot by `migrateProviderApiKeysToSecrets`, so reading it here
  // as well would only keep alive a path that puts a credential in a world-readable file.
  let mediaSecrets: { visionApiKey?: string; sttApiKey?: string; nliApiKey?: string; rerankApiKey?: string } = {};
  try { mediaSecrets = getSecrets().mediaEmbedding ?? {}; } catch { /* secrets file may not exist pre-setup */ }
  const vision: MediaProviderConfig = {
    baseUrl: visionBaseUrlEnv
      ?? base.vision?.baseUrl
      // Short service name resolves in both:
      //  - Docker Compose: bridge-network DNS to the `ollama` service
      //  - K8s: ClusterFirst DNS within the `ythril` namespace
      ?? 'http://ollama:11434',
    // `moondream` is the correct Ollama registry name; `moondream2` does not exist
    // there (a pull 404s), which silently broke bundled image captioning. Normalise
    // the invalid legacy name from ANY source (env / saved config) so existing installs
    // self-heal without a config-file migration.
    model: normalizeVisionModel(
      visionModelEnv ?? base.vision?.model ?? 'moondream',
    ),
    apiKey: visionApiKeyEnv ?? mediaSecrets.visionApiKey,
    // The default label follows the resolved provider. A fixed "(Ollama-compatible)" was wrong exactly
    // when it mattered — an operator on vLLM saw their OpenAI-compatible endpoint labelled with a
    // protocol it does not speak, which is the same misdirection as the `OLLAMA_URL` name itself.
    label: base.vision?.label
      ?? `Vision provider (${visionProvider === 'external' ? 'OpenAI' : 'Ollama'}-compatible)`,
  };
  if (visionBaseUrlEnv) locked.push('vision.baseUrl');
  if (visionModelEnv) locked.push('vision.model');
  if (visionApiKeyEnv) locked.push('vision.apiKey');

  // STT provider block
  const sttBaseUrlEnv = process.env['STT_BASE_URL'];
  const sttModelEnv = process.env['STT_MODEL'];
  const sttApiKeyEnv = process.env['STT_API_KEY'];
  const stt: MediaProviderConfig = {
    baseUrl: sttBaseUrlEnv
      ?? base.stt?.baseUrl
      // Short service name — resolves in both Docker Compose and the K8s `ythril` namespace.
      ?? 'http://whisper:8000',
    model: sttModelEnv
      ?? base.stt?.model
      ?? 'base',
    apiKey: sttApiKeyEnv ?? mediaSecrets.sttApiKey,
    label: base.stt?.label ?? 'STT provider (OpenAI-compatible)',
  };
  if (sttBaseUrlEnv) locked.push('stt.baseUrl');
  if (sttModelEnv) locked.push('stt.model');
  if (sttApiKeyEnv) locked.push('stt.apiKey');

  // NLI provider block (F-REVIEW contradiction judge) — same env → config → default precedence as
  // vision/stt, so infra can pin it on a managed deployment. Left unconfigured by default: contradiction
  // detection is opt-in, and an unset endpoint simply means the judge does not run.
  const nliBaseUrlEnv = process.env['NLI_URL'];
  const nliModelEnv = process.env['NLI_MODEL'];
  const nliApiKeyEnv = process.env['NLI_API_KEY'];
  const nli: MediaProviderConfig = {
    baseUrl: nliBaseUrlEnv ?? base.nli?.baseUrl,
    model: nliModelEnv ?? base.nli?.model,
    apiKey: nliApiKeyEnv ?? mediaSecrets.nliApiKey,
    label: base.nli?.label ?? 'NLI provider (contradiction judge)',
  };
  if (nliBaseUrlEnv) locked.push('nli.baseUrl');
  if (nliModelEnv) locked.push('nli.model');
  if (nliApiKeyEnv) locked.push('nli.apiKey');

  // Reranker — a cross-encoder that re-scores retrieval candidates. Same env → secrets → config ladder
  // as the other providers; unconfigured by default, since it sees the query AND the retrieved passages.
  const rerankBaseUrlEnv = process.env['RERANK_URL'];
  const rerankModelEnv = process.env['RERANK_MODEL'];
  const rerankApiKeyEnv = process.env['RERANK_API_KEY'];
  const rerankMultEnv = process.env['RERANK_CANDIDATE_MULTIPLIER'];
  const rerank: RerankConfig = {
    baseUrl: rerankBaseUrlEnv ?? base.rerank?.baseUrl,
    model: rerankModelEnv ?? base.rerank?.model,
    apiKey: rerankApiKeyEnv ?? mediaSecrets.rerankApiKey,
    label: base.rerank?.label ?? 'Reranker (cross-encoder)',
    candidateMultiplier: rerankMultEnv ? numericEnvOrExit('RERANK_CANDIDATE_MULTIPLIER', rerankMultEnv)
      : base.rerank?.candidateMultiplier,
  };
  if (rerankBaseUrlEnv) locked.push('rerank.baseUrl');
  if (rerankModelEnv) locked.push('rerank.model');
  if (rerankApiKeyEnv) locked.push('rerank.apiKey');
  if (rerankMultEnv) locked.push('rerank.candidateMultiplier');

  // F11-b — when the external assist model's endpoint is pinned by env, lock the whole block in the UI.
  if (process.env['DOC_ASSIST_URL'] || process.env['DOC_ASSIST_MODEL'] || process.env['DOC_ASSIST_API_KEY']) {
    locked.push('documentProcessing.assistModel');
  }
  // Text-embedding env pins ("fix-set" for managed infra) → the matching field renders read-only in the UI.
  if (process.env['EMBEDDING_PROVIDER']) locked.push('embedding.provider');
  if (process.env['EMBEDDING_URL']) locked.push('embedding.baseUrl');
  if (process.env['EMBEDDING_MODEL']) locked.push('embedding.model');
  if (process.env['EMBEDDING_DIMENSIONS']) locked.push('embedding.dimensions');
  if (process.env['EMBEDDING_PREFIX_SCHEME']) locked.push('embedding.prefixScheme');
  if (process.env['EMBEDDING_API_KEY']) locked.push('embedding.apiKey');
  if (process.env['EMBEDDING_CONCURRENCY']) locked.push('embedding.embedConcurrency');

  return {
    // Per-class ceilings, filled per field so a partial `levels` block cannot drop the classes it
    // does not mention (the same trap the embedding defaults hit).
    levels: {
      images: base.levels?.images ?? MEDIA_EMBEDDING_DEFAULTS.levels.images,
      audio: base.levels?.audio ?? MEDIA_EMBEDDING_DEFAULTS.levels.audio,
      video: base.levels?.video ?? MEDIA_EMBEDDING_DEFAULTS.levels.video,
      text: base.levels?.text ?? MEDIA_EMBEDDING_DEFAULTS.levels.text,
    },
    visionProvider,
    sttProvider,
    vision,
    stt,
    nli,
    rerank,
    workerConcurrency: pick('WORKER_CONCURRENCY', 'workerConcurrency', base.workerConcurrency, MEDIA_EMBEDDING_DEFAULTS.workerConcurrency),
    workerPollIntervalMs: pick('WORKER_POLL_INTERVAL_MS', 'workerPollIntervalMs', base.workerPollIntervalMs, MEDIA_EMBEDDING_DEFAULTS.workerPollIntervalMs),
    workerMaxPollIntervalMs: pick('WORKER_MAX_POLL_INTERVAL_MS', 'workerMaxPollIntervalMs', base.workerMaxPollIntervalMs, MEDIA_EMBEDDING_DEFAULTS.workerMaxPollIntervalMs),
    fallbackToExternal: pick('MEDIA_EMBEDDING_FALLBACK_TO_EXTERNAL', 'fallbackToExternal', base.fallbackToExternal, MEDIA_EMBEDDING_DEFAULTS.fallbackToExternal),
    maxFileSizeBytes: pick('MAX_FILE_SIZE_BYTES', 'maxFileSizeBytes', base.maxFileSizeBytes, MEDIA_EMBEDDING_DEFAULTS.maxFileSizeBytes),
    stalledJobTimeoutMs: pick('STALLED_JOB_TIMEOUT_MS', 'stalledJobTimeoutMs', base.stalledJobTimeoutMs, MEDIA_EMBEDDING_DEFAULTS.stalledJobTimeoutMs),
    // Surface the resolved document-processing/extraction settings (F11) so the admin API GET and the
    // Models UI can read them back (the worker ignores this block).
    documentProcessing: getDocumentProcessingConfig(),
    // Surface the resolved face-recognition settings so the admin API can return them and the UI can
    // render a real control. Reported here rather than left to the caller because the resolution is
    // env → config → default and only this module knows which tier won.
    faceRecognition: getFaceRecognitionConfig(),
    // `YTHRIL_PINNED_FIELDS` adds to the pins that each field's own env var already produces — that is the whole
    // point of it. A field whose value is supplied by config.json (or by nothing at all, which is the case the
    // request was about) becomes read-only without anyone having to put a value in the environment to achieve it.
    //
    // Deduplicated: a field pinned BOTH ways would otherwise appear twice, and the UI reads this list to decide
    // what to grey out.
    lockedByInfra: [...new Set([...locked, ...lockedFaceRecognitionFields(), ...pinnedFields.paths])],
    ...(pinnedFields.unknown.length > 0 ? { pinnedUnknown: pinnedFields.unknown } : {}),
    // F11 — infra-managed lock (like YTHRIL_MONGO_INFRA_MANAGED): env OR config marks the whole media/model
    // config as managed by infrastructure, so the admin API refuses edits and the UI is read-only.
    infraManaged: process.env['YTHRIL_MEDIA_INFRA_MANAGED'] === 'true' || base.infraManaged === true,
  };
}

// ── Document Processing Config ──────────────────────────────────────────────

const DOCUMENT_PROCESSING_DEFAULTS: Required<DocumentProcessingConfig> = {
  strategy: 'hi_res',
  extractImages: true,
  // `auto` still means "the most this instance can do" — but it is deliberately NOT the default, because
  // for extraction `auto` resolves to the `repair` rung (extraction-policy: auto -> repair when available),
  // which runs an extra LLM reconciliation pass over every document and, with an external assist model
  // configured, sends OCR text and page images off the instance. That is a cost-and-egress decision an
  // operator should make, not inherit. `vlm` is the most capable rung that stays a plain transcription;
  // it falls back to OCR when no vision model is configured, so a bare instance behaves as it always did.
  mode: 'vlm',
  renderDpi: 150,
  maxPages: 50,
  // Pages read from one document in total, across render windows. Separate from `maxPages`, which bounds
  // ONE render call: this is the job's cost ceiling, and every page beyond it is another VLM call.
  maxTotalPages: 200,
  pageTimeoutMs: 60_000,
  concurrency: 2,
  ocrTimeoutMs: 120_000, // 2 min — the historical hardcoded OCR-sidecar ceiling, now tunable
  describeTimeoutMs: 30_000, // one call, and its only cost on failure is the generated description
  vlmModel: '',    // empty = no VLM configured → vlm/auto/max fall back to OCR
  vlmBaseUrl: '',  // empty = reuse the media vision provider's (Ollama) URL
  repairModel: '',   // empty = reuse vlmModel for the max-mode repair pass
  repairBaseUrl: '', // empty = reuse vlmBaseUrl (then the vision URL)
  verifyModel: '',   // F11-d — empty = no max-mode consensus pass
  verifyBaseUrl: '', // empty = reuse vlmBaseUrl (then the vision URL)
  assistModel: {},   // F11-b — no external assist model by default (resolved with env overrides above)
};

/**
 * Return the resolved document processing configuration, merging:
 *   1. `config.json` `mediaEmbedding.documentProcessing` block
 *   2. Built-in defaults
 */
export function getDocumentProcessingConfig(): Required<DocumentProcessingConfig> {
  const mediaCfg = getConfig().mediaEmbedding;
  const base: DocumentProcessingConfig = mediaCfg?.documentProcessing ?? {};
  const d = DOCUMENT_PROCESSING_DEFAULTS;
  return {
    strategy: base.strategy ?? d.strategy,
    extractImages: base.extractImages ?? d.extractImages,
    // Normalise on READ, not only at the API boundary: `max` is a stored value that existing
    // config.json files still carry, and it can reach here without ever passing through a PATCH
    // (a hand edit, a restored backup, a config baked by infra). Left unnormalised it would fall
    // through the ladder as an unknown value and quietly drop the repair pass those instances asked
    // for — a downgrade nobody triggered and nothing would report.
    mode: normalizeDocExtractionMode(base.mode) ?? d.mode,
    renderDpi: base.renderDpi ?? d.renderDpi,
    maxPages: base.maxPages ?? d.maxPages,
    maxTotalPages: base.maxTotalPages ?? d.maxTotalPages,
    pageTimeoutMs: base.pageTimeoutMs ?? d.pageTimeoutMs,
    concurrency: base.concurrency ?? d.concurrency,
    ocrTimeoutMs: envIntOpt('DOC_OCR_TIMEOUT_MS') ?? base.ocrTimeoutMs ?? d.ocrTimeoutMs,
    // A single-GPU backend that swaps models per request spends the first part of this call LOADING one,
    // which is why it is tunable at all: at 30 s such a host times out on every document and silently keeps
    // extractive text instead.
    describeTimeoutMs: envIntOpt('DOC_DESCRIBE_TIMEOUT_MS') ?? base.describeTimeoutMs ?? d.describeTimeoutMs,
    vlmModel: process.env['DOC_VLM_MODEL'] ?? base.vlmModel ?? d.vlmModel,
    vlmBaseUrl: process.env['DOC_VLM_URL'] ?? base.vlmBaseUrl ?? d.vlmBaseUrl,
    repairModel: process.env['DOC_REPAIR_MODEL'] ?? base.repairModel ?? d.repairModel,
    repairBaseUrl: process.env['DOC_REPAIR_URL'] ?? base.repairBaseUrl ?? d.repairBaseUrl,
    verifyModel: process.env['DOC_VERIFY_MODEL'] ?? base.verifyModel ?? d.verifyModel,
    verifyBaseUrl: process.env['DOC_VERIFY_URL'] ?? base.verifyBaseUrl ?? d.verifyBaseUrl,
    // F11-b — external assist model. Env (DOC_ASSIST_URL/MODEL) pins baseUrl/model over config; the two
    // acknowledgements are config-only (they encode operator intent + consent). apiKey lives in secrets —
    // read it via getDocAssistApiKey(). Absent baseUrl ⇒ no external assist model.
    assistModel: {
      baseUrl: process.env['DOC_ASSIST_URL'] ?? base.assistModel?.baseUrl,
      model: process.env['DOC_ASSIST_MODEL'] ?? base.assistModel?.model,
      acknowledgedHost: base.assistModel?.acknowledgedHost,
      acknowledgedHostForConversations: base.assistModel?.acknowledgedHostForConversations,
      // F-33: carried through, or the resolver never sees a budget or a fallback the operator set.
      ...(base.assistModel?.budget ? { budget: base.assistModel.budget } : {}), ...(base.assistModel?.fallback ? { fallback: base.assistModel.fallback } : {}),
    },
  };
}

/** F11-b — the external assist model's API key: env (DOC_ASSIST_API_KEY) > secrets.json. Never in config.json. */
/** The NLI provider key (env > secrets.json > legacy config), for the contradiction judge. */
/** The reranker's API key, resolved (env > secrets > legacy inline config). Never surfaced unmasked. */
export function getRerankApiKey(): string | undefined {
  if (process.env['RERANK_API_KEY']) return process.env['RERANK_API_KEY'];
  try { return getSecrets().mediaEmbedding?.rerankApiKey ?? getConfig().mediaEmbedding?.rerank?.apiKey; }
  catch { return undefined; }
}

export function getNliApiKey(): string | undefined {
  const env = process.env['NLI_API_KEY'];
  if (env) return env;
  try { return getSecrets().mediaEmbedding?.nliApiKey ?? getConfig().mediaEmbedding?.nli?.apiKey; }
  catch { return undefined; }
}

export function getDocAssistApiKey(): string | undefined {
  if (process.env['DOC_ASSIST_API_KEY']) return process.env['DOC_ASSIST_API_KEY'];
  try { return (getSecrets().mediaEmbedding as { docAssistApiKey?: string } | undefined)?.docAssistApiKey; }
  catch { return undefined; }
}

/** The assist model's FALLBACK endpoint key (`F-33`) — env first, then secrets, like the primary's. */
export function getDocAssistFallbackApiKey(): string | undefined {
  if (process.env['DOC_ASSIST_FALLBACK_API_KEY']) return process.env['DOC_ASSIST_FALLBACK_API_KEY'];
  try { return (getSecrets().mediaEmbedding as { docAssistFallbackApiKey?: string } | undefined)?.docAssistFallbackApiKey; }
  catch { return undefined; }
}

// ── Face Recognition Config ──────────────────────────────────────────────────

const FACE_RECOGNITION_DEFAULTS: Required<FaceRecognitionConfig> = {
  // Absent by default: face work runs in-process unless an operator points at an endpoint.
  externalModel: {},
  // No longer a user-facing switch: the image ladder decides whether faces run (the `recognition` rung),
  // and images now default to `caption`, so this defaulting to true does NOT turn faces on anywhere. What
  // it stays is the INFRA pin — `FACE_RECOGNITION_ENABLED=false` hard-disables face recognition regardless
  // of any ladder, which is why the field survives the checkbox that used to write it.
  enabled: true,
  confidenceThreshold: 0.6,
  minFaceSizeFraction: 0.05,
  modelPath: 'human-models',
  personEntityTypes: ['person'],
  reprocessSyncedImages: true,
};

/**
 * Return the resolved face recognition configuration, merging:
 *   1. `config.json` `mediaEmbedding.faceRecognition` block
 *   2. Built-in defaults
 *
 * Returns defaults with `enabled: false` when no config block is present.
 */
/**
 * Env keys that pin face recognition, mirroring the media-provider pattern. Face recognition was the
 * only model in the pipeline an infra admin could not set — every other one (vision, STT, embedding,
 * assist, both sidecars) already had an override, so an infra-managed deployment could pin everything
 * except whether faces are processed at all. That is the setting with the clearest privacy weight.
 */
const FACE_RECOGNITION_ENV: Record<keyof Required<FaceRecognitionConfig>, string> = {
  // Env-pinnable as a whole, so an infra-managed deployment can pin the biometric endpoint the same way it pins every
  // other provider.
  //
  // CORRECTION, 2026-08-13: this comment used to end "...by pinning it empty". That is NOT what happens, and saying so
  // was worse than saying nothing — an operator following it would believe biometric egress was locked when the field
  // was still editable. An EMPTY env var is deliberately not a pin: docker-compose passes
  // `FACE_RECOGNITION_ENABLED: ${FACE_RECOGNITION_ENABLED:-}`, which leaves the variable defined-but-empty when the
  // operator set nothing, so reading "defined" as "pinned" would lock all six fields on every Compose deployment and
  // report controls the operator cannot use and could not explain. `face-recognition-env.test.js` pins that reasoning.
  //
  // To forbid the egress, pin the value that forbids it: `FACE_RECOGNITION_ENABLED=false`. There is currently no way to
  // express "fixed, and fixed at nothing" for a field whose empty value is meaningful — the canary operator asked for
  // exactly that on 2026-08-12 and it needs a mechanism that cannot be confused with a Compose default.
  externalModel: 'FACE_RECOGNITION_EXTERNAL_MODEL',
  enabled: 'FACE_RECOGNITION_ENABLED',
  confidenceThreshold: 'FACE_RECOGNITION_CONFIDENCE_THRESHOLD',
  minFaceSizeFraction: 'FACE_RECOGNITION_MIN_FACE_SIZE_FRACTION',
  modelPath: 'FACE_RECOGNITION_MODEL_PATH',
  personEntityTypes: 'FACE_RECOGNITION_PERSON_ENTITY_TYPES',
  reprocessSyncedImages: 'FACE_RECOGNITION_REPROCESS_SYNCED_IMAGES',
};

/**
 * An env var counts as "set" only when it has a value.
 *
 * docker-compose passes these through as `FACE_RECOGNITION_ENABLED: ${FACE_RECOGNITION_ENABLED:-}`,
 * which leaves the variable **defined but empty** when the operator did not set it. Treating defined
 * as pinned would read the empty string as `false` and force face recognition off for every Compose
 * deployment — while also reporting all six fields as infra-locked, so the UI would show controls the
 * operator cannot use and could not explain.
 */
function envSet(key: string): string | undefined {
  const raw = process.env[key];
  return raw !== undefined && raw !== '' ? raw : undefined;
}

/** Field names (as `faceRecognition.<field>`) currently pinned by an env var. */
export function lockedFaceRecognitionFields(): string[] {
  return (Object.entries(FACE_RECOGNITION_ENV) as Array<[string, string]>)
    .filter(([, envKey]) => envSet(envKey) !== undefined)
    .map(([field]) => `faceRecognition.${field}`);
}

export function getFaceRecognitionConfig(): Required<FaceRecognitionConfig> {
  // Tolerate config not being loaded: an infra env pin must apply during early boot too, and this is
  // read from paths that can run before the first successful load.
  let base: FaceRecognitionConfig = {};
  try { base = getConfig().mediaEmbedding?.faceRecognition ?? {}; } catch { /* pre-setup */ }

  // env → config → default, matching getMediaEmbeddingConfig's precedence exactly.
  const pick = <K extends keyof Required<FaceRecognitionConfig>>(
    field: K,
    parse: (raw: string) => Required<FaceRecognitionConfig>[K],
  ): Required<FaceRecognitionConfig>[K] => {
    const rawEnv = envSet(FACE_RECOGNITION_ENV[field]);
    if (rawEnv !== undefined) return parse(rawEnv);
    return (base[field] ?? FACE_RECOGNITION_DEFAULTS[field]) as Required<FaceRecognitionConfig>[K];
  };

  return {
    // Object-valued, so it is taken from config only — `pick`'s env path parses scalars.
    externalModel: base.externalModel ?? FACE_RECOGNITION_DEFAULTS.externalModel,
    enabled: pick('enabled', v => v === 'true' || v === '1'),
    confidenceThreshold: pick('confidenceThreshold', v => Number(v)),
    minFaceSizeFraction: pick('minFaceSizeFraction', v => Number(v)),
    modelPath: pick('modelPath', v => v),
    // Comma-separated: FACE_RECOGNITION_PERSON_ENTITY_TYPES=person,employee
    personEntityTypes: pick('personEntityTypes', v => v.split(',').map(t => t.trim()).filter(Boolean)),
    reprocessSyncedImages: pick('reprocessSyncedImages', v => v === 'true' || v === '1'),
  };
}
