/**
 * A loaded server config that holds exactly the spaces a test names - the one answer to "which spaces does this process configure".
 *
 * ## What it prevents
 *
 * `recordSpaceCall` counts a call only against a configured space (Q-606: an unauthenticated request must not mint a counter, and a
 * stored document, for an id it made up), so a test that records a call for `'alpha'` has said nothing until `alpha` is a space the
 * config holds. Three files wrote that setup by hand; the first to forget it recorded nothing and failed on an empty list, which reads
 * as a broken counter and not as a missing space.
 *
 * It writes a config file under the test's temp directory, points `CONFIG_PATH` at it BEFORE the loader is first imported (the loader
 * reads the variable once), and loads it. The spaces are replaced through `mutateConfig`, the way a created, renamed or deleted space
 * reaches the live config, so a test that deletes a space between a call and a flush does what the server does.
 *
 * Requires a prior `npm run build:server`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spaceRecord = (id) => ({ id, label: id, builtIn: id === 'general', folders: [], meta: {} });

/**
 * @param {string[]} ids the spaces the config holds
 * @param {string} [name] names the temp directory, so a leftover says which suite made it
 * @returns {Promise<{ loader: any, dir: string, setSpaces: (ids: string[]) => void, addSpace: (id: string) => void, removeSpace: (id: string) => void, renameSpace: (from: string, to: string) => void }>}
 */
export async function configureSpaces(ids, name = 'configured-spaces') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-${name}-`));
  process.env['CONFIG_PATH'] = path.join(dir, 'config.json');
  process.env['DATA_ROOT'] = path.join(dir, 'data');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: `${name}-instance`, instanceLabel: name, tokens: [], networks: [], spaces: ids.map(spaceRecord),
  }, null, 2), { mode: 0o600 });
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  const setSpaces = (next) => loader.mutateConfig((cfg) => { cfg.spaces = next.map(spaceRecord); });
  return {
    loader, dir, setSpaces,
    addSpace: (id) => loader.mutateConfig((cfg) => { cfg.spaces.push(spaceRecord(id)); }),
    removeSpace: (id) => loader.mutateConfig((cfg) => { cfg.spaces = cfg.spaces.filter(s => s.id !== id); }),
    renameSpace: (from, to) => loader.mutateConfig((cfg) => { for (const s of cfg.spaces) if (s.id === from) { s.id = to; s.label = to; } }),
  };
}
