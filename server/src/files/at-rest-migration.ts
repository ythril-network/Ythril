/**
 * The background pass that brings a files tree to the at-rest state the configuration asks for (F-43).
 *
 * Setting a master secret does not rewrite what is already stored: every NEW write goes through the file door
 * encrypted, and this pass encrypts the plaintext files written before, once per boot, in the background. Until it
 * has finished the tree is mixed, which every reader handles because the door detects the format per file.
 *
 * Without a secret it rewrites nothing and only COUNTS files that are in the encrypted format. Those cannot be read
 * on this instance — the secret was removed, or a keyed tree was restored onto a keyless host — and the security
 * posture says so, because the failure otherwise shows up only as downloads refusing one at a time.
 *
 * ## What each file gets, and why the rewrite lives in the door rather than here
 *
 * The rewrite itself is `encryptInPlace`, which holds the path lock, re-checks the file just before its rename, and
 * keeps its mtime — a migration that changed mtimes would look to every peer like an edit of every file. This
 * module does the walking: pacing, the progress log, the FileMeta hash check, seeding the manifest's hash cache
 * (so the next sync does not decrypt every migrated file to re-learn a hash it was just told), and the counts.
 *
 * ## When it stops
 *
 * A full disk (ENOSPC) stops the pass: every further file would fail the same way, and each attempt leaves the
 * disk fuller for the writes users are waiting on. Anything else fails that one file, logged, and the pass goes on.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from '../config/loader.js';
import { log } from '../util/log.js';
import { caughtFailureText } from '../brain/store-failure.js';
import { activeSecret, encryptInPlace, isStoredEncrypted } from './stored-bytes.js';
import { seedFileHash } from './manifest.js';
import { getFileMeta } from './file-meta.js';

/** What the last (or current) pass found. The security posture reads this. */
export interface AtRestMigrationState {
  phase: 'not-started' | 'running' | 'finished' | 'stopped';
  /** Whether a secret was configured for this pass. */
  keyed: boolean;
  /** Files rewritten from plaintext to ciphertext by this pass. */
  encrypted: number;
  /** Plaintext files the pass could not encrypt (an error on that file, or the pass stopped before them). */
  plaintextLeft: number;
  /** Keyless only: files in the encrypted format, which this instance cannot read. */
  encryptedWithoutSecret: number;
  /** Why the pass stopped, when it did. */
  stoppedBecause?: string;
  finishedAt?: string;
}

const PROGRESS_EVERY = 1000;
const fresh = (): AtRestMigrationState =>
  ({ phase: 'not-started', keyed: false, encrypted: 0, plaintextLeft: 0, encryptedWithoutSecret: 0 });
let state: AtRestMigrationState = fresh();
let started = false;

export function atRestMigrationState(): AtRestMigrationState { return { ...state }; }

/**
 * Start the pass once per process. A second call is a no-op: boot and the first-run setup route both start the
 * configured-instance services, and two walkers would race each other over every file for no gain.
 */
export function startAtRestMigration(): void {
  if (started) return;
  started = true;
  void runAtRestMigration().catch(err => {
    state = { ...state, phase: 'stopped', stoppedBecause: caughtFailureText(err, 'migrate stored files at rest') };
    log.error(`Files at rest: the background pass failed: ${state.stoppedBecause}`);
  });
}

/** One pass over every space's files. Tests call it directly; production starts it through {@link startAtRestMigration}. */
export async function runAtRestMigration(): Promise<AtRestMigrationState> {
  const keyed = activeSecret() !== null;
  state = { ...fresh(), phase: 'running', keyed };
  const filesRoot = path.join(getDataRoot(), 'files');
  let spaces: string[];
  try { spaces = (await fsp.readdir(filesRoot, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { spaces = []; }
  if (keyed) log.info(`Files at rest: encrypting plaintext files in ${spaces.length} space(s) in the background`);

  let visited = 0;
  let stop: string | undefined;
  for (const spaceId of spaces) {
    const spaceRoot = path.join(filesRoot, spaceId);
    for await (const abs of walkFiles(spaceRoot)) {
      if (stop) {
        // Stopped: only count what is left, so the posture can say how much stayed plaintext.
        if (!(await isStoredEncrypted(abs).catch(() => true))) state.plaintextLeft++;
        continue;
      }
      visited++;
      if (visited % PROGRESS_EVERY === 0) log.info(`Files at rest: ${visited} files checked, ${state.encrypted} encrypted so far`);
      // An upload, a sync pull or a space rename may be waiting on the same event loop; one file at a time with a
      // yield between keeps the pass from starving them.
      await new Promise(r => setImmediate(r));
      const rel = path.relative(spaceRoot, abs).replace(/\\/g, '/');
      if (!keyed) {
        if (await isStoredEncrypted(abs).catch(() => false)) state.encryptedWithoutSecret++;
        continue;
      }
      try {
        const r = await encryptInPlace(abs);
        if (r.outcome !== 'encrypted') continue;
        state.encrypted++;
        await seedFileHash(spaceId, rel, { size: r.onDiskSize, mtimeMs: r.mtimeMs, sha256: r.sha256, plainSize: r.plainSize })
          .catch(() => { /* a missed seed costs one re-hash on the next manifest, nothing more */ });
        const meta = await getFileMeta(spaceId, rel).catch(() => null);
        if (meta?.sha256 && meta.sha256 !== r.sha256) {
          // Not a reason to stop: the file on disk is what it is, and it is now encrypted as it is. It does mean the
          // record and the bytes disagree, which predates this pass and is worth an operator knowing.
          log.warn(`Files at rest: ${spaceId}/${rel} does not match the hash its record carries (it changed outside Ythril)`);
        }
      } catch (err) {
        state.plaintextLeft++;
        if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
          stop = 'the disk is full';
          log.error(`Files at rest: stopped because the disk is full. ${state.encrypted} encrypted; the rest stay plaintext until the next start.`);
          continue;
        }
        log.warn(`Files at rest: could not encrypt ${spaceId}/${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  state = { ...state, phase: stop ? 'stopped' : 'finished', ...(stop ? { stoppedBecause: stop } : {}), finishedAt: new Date().toISOString() };
  if (keyed) log.info(`Files at rest: pass finished; ${visited} files checked, ${state.encrypted} encrypted, ${state.plaintextLeft} left as plaintext`);
  else if (state.encryptedWithoutSecret > 0) {
    log.warn(`Files at rest: ${state.encryptedWithoutSecret} stored file(s) are encrypted and no master secret is set; they cannot be read until it is`);
  }
  return atRestMigrationState();
}

/** Every regular file under `dir`, depth first. A directory that vanishes mid-walk is skipped, not an error. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(abs);
    else if (e.isFile()) yield abs;
  }
}

/** Tests only: allow {@link startAtRestMigration} to run again in the same process. */
export function resetAtRestMigrationForTests(): void { started = false; state = fresh(); }
