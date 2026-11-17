/**
 * One scenario of `a-rerun-of-a-deleted-network-ends-quietly.test.js`, run in a process of its own and answered as JSON on the last line.
 *
 * It is a child because the answer is whether a rejection nobody held reaches `process`: the test runner treats such a rejection as the
 * failure of whatever test is running, so the same process cannot be asked "was there one" and also survive the answer yes (the case that
 * a rerun's OTHER failure is still raised).
 *
 * Usage: CONFIG_PATH=<scratch config.json> node _rerun-scenario.mjs <gone|live|other-failure>
 * Answers `{"unhandled": ["<reason>"…], "lines": ["<level>: <text>"…], "calls": <cycles run by the injected cycle, other-failure only>}`.
 */
import fs from 'node:fs';

const scenario = process.argv[2];
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason)); });

const lines = [];
const { log } = await import('../../server/dist/util/log.js');
for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (msg) => { lines.push(`${level}: ${msg}`); };

fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ spaces: [], networks: [], tokens: [] }, null, 2));
const loader = await import('../../server/dist/config/loader.js');
loader.loadConfig();
const config = loader.getConfig();
const engine = await import('../../server/dist/sync/engine.js');
const runner = await import('../../server/dist/sync/network-cycle-runner.js');

/** Let every promise job and the unhandled-rejection pass of the current turn run. */
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
/** A network as the engine reads it: an id, a label and no members, so a cycle has nobody to reach. */
const network = (id) => ({ id, label: `Rerun ${id}`, type: 'closed', members: [], spaces: [] });

let calls = 0;
if (scenario === 'gone' || scenario === 'live') {
  const id = `${scenario}-network`;
  config.networks = [network(id)];
  const first = engine.runSyncForNetwork(id).catch(() => {});
  const joined = engine.runSyncForNetwork(id).catch(() => {}); // joins the running cycle and queues the one rerun
  if (scenario === 'gone') config.networks = [];
  await Promise.all([first, joined]);
} else if (scenario === 'other-failure') {
  const cycle = async () => {
    calls += 1;
    if (calls === 2) throw new Error('rerun-store-down');
    return { synced: 0, errors: 0, members: [], outcome: 'success' };
  };
  const first = runner.runNetworkCycle('other-failure-network', cycle).catch(() => {});
  const joined = runner.runNetworkCycle('other-failure-network', cycle).catch(() => {});
  await Promise.all([first, joined]);
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
await runner.syncCyclesSettled(5_000);
await drain();
console.log(JSON.stringify({ unhandled, lines, calls }));
process.exit(0);
