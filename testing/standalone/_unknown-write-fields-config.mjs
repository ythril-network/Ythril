/**
 * A loaded config for a test that asks about a space's `unknownWriteFields` — the question "what does THIS instance do with a field a
 * write does not take" needs a space that refuses and a space that warns, and each pure test would otherwise write its own copy of
 * the temp-directory, `CONFIG_PATH` and `loadConfig` dance (bundle-128, Q-320).
 *
 * ## What it prevents
 *
 * The setting is a top-level field of the space CONFIG, never a `meta` key, so a test that builds a space through any meta door
 * cannot reach it. This writes the stored shape directly (absent, or the one stored value `'refuse'`) and loads it through the
 * server's own `loadConfig`, so the judge reads exactly what a boot would have read.
 *
 * It does not stub the loader and it does not call the judge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ONE directory per process, made when this module is IMPORTED: the loader reads CONFIG_PATH when it is first imported and keeps it,
// so the variable has to be set before any test file imports a server module, and a second directory would leave every later
// loadConfig reading the first one's file.
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b128-config-'));
process.env['CONFIG_PATH'] = path.join(shared, 'config.json');
process.env['DATA_ROOT'] = path.join(shared, 'data');
process.on('exit', () => { try { fs.rmSync(shared, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The two spaces every judge case needs: one with no setting (warns), one set to refuse. Ids are plain `[a-z0-9-]+`. */
export const WARN_SPACE = 'b128-warn';
export const REFUSE_SPACE = 'b128-refuse';

/**
 * Write `spaces` into a fresh temp config and load it.
 *
 * @param {object} o
 * @param {string} o.suite  slug for the temp directory
 * @param {object[]} [o.spaces]  config `spaces` entries (default: {@link WARN_SPACE} and {@link REFUSE_SPACE})
 * @param {object} [o.config]  further top-level config keys
 * @returns {Promise<{ dir: string, configPath: string, loader: object, rewrite: (spaces: object[]) => void, close: () => void }>}
 */
export async function openUnknownWriteFieldsConfig({ suite, spaces, config = {} }) {
  const configPath = process.env['CONFIG_PATH'];
  const write = (list) => fs.writeFileSync(configPath, JSON.stringify({
    instanceId: `${suite}-instance`, instanceLabel: suite, tokens: [], networks: [], ...config, spaces: list,
  }, null, 2), { mode: 0o600 });
  write(spaces ?? [
    { id: WARN_SPACE, label: 'Warns', folders: [], meta: {} },
    { id: REFUSE_SPACE, label: 'Refuses', folders: [], meta: {}, unknownWriteFields: 'refuse' },
  ]);
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  return { dir: shared, configPath, loader, rewrite: write, close: () => {} };
}
