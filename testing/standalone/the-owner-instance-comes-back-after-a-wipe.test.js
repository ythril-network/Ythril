/**
 * The owner's instance comes back after a wipe: `scripts/owner-instance.ps1` records what runs, refuses a wipe that would
 * delete data, stops it cleanly and brings it back (`Q-294`, bundle-64).
 *
 * ## The failure this guards
 *
 * `docker-wipe.ps1` deletes Docker's data disk, and with it every image and container of the owner's running instance.
 * Its data survives — it lives in bind mounts under the checkout (`local-data/`, `config/`) — but nothing recorded what
 * ran, so after a wipe the instance stayed down until someone remembered how it had been started, from which commit, with
 * which override. And a wipe is only harmless while EVERY volume it deletes is disposable: one named volume under
 * `/data` and the wipe deletes the database it was trusted not to touch.
 *
 * ## How the module is reached, and why that way
 *
 * The scripts run under Windows PowerShell 5.1 here, which is what this spawns (`powershell.exe`, else `pwsh`). The module
 * is DOT-SOURCED and its functions called directly; docker and git are reached through a parameter seam (`-Docker`,
 * `-Git`), never a PATH shim, so every case answers from canned JSON and no case touches the engine — the owner's
 * instance is live on this machine. All cases run in one PowerShell process, each with its own scratch directory and its
 * own `try`, so one case's failure is its own row. Files are read with `[IO.File]`, never `Get-Content`: a string from
 * `Get-Content` carries its provider as extra properties, and serialising those is what makes the harness hang.
 *
 * ## The contract (these names and parameters ARE the module's interface; the implementation is written against them)
 *
 * Dot-sourcing `scripts/owner-instance.ps1` defines functions and runs nothing.
 *
 * Pure (string in, value out; literal Windows strings, no file system):
 * - `ConvertTo-ComparablePath -Path <string>` → `\` turned to `/`, case folded to lower, trailing `/` dropped.
 * - `Test-SameDirectory -Path <string> -Root <string>` → `$true` when both name one directory, whatever the spelling.
 * - `Test-PathUnder -Path <string> -Root <string>` → `$true` for the root itself or anything below it, with a boundary
 *   (`O:\Projects\Ythril-old` is NOT under `O:\Projects\Ythril`).
 * - `Split-ConfigFiles -Value <string>` → the `com.docker.compose.project.config_files` label split on commas, trimmed,
 *   empties dropped.
 *
 * The seam: `-Docker` and `-Git` are scriptblocks called as `& $Docker <arg> <arg> ...`; they return stdout and THROW on
 * failure (the default wraps the real CLI and throws on a non-zero exit). The module never reads `$LASTEXITCODE`.
 *
 * - `Get-OwnerInstance -RepoRoot <path> -Docker <sb> -Git <sb>` → the record (below), or `$null` when no project of this
 *   checkout runs. It reads `& $Docker ps -q`, then `& $Docker inspect <id> ...` (labels
 *   `com.docker.compose.project`, `.project.working_dir`, `.project.config_files`, `com.docker.compose.service`), takes the
 *   ONE project whose working_dir is `-RepoRoot` (`Test-SameDirectory`), and REFUSES (throws, naming them) when no project
 *   matched and another project runs that is not a test project (named `ythril-test`). It reads the resolved config with
 *   `& $Docker compose -p <project> --project-directory <working_dir> -f <file> ... config --format json` and the commit
 *   with `& $Git -C <working_dir> rev-parse HEAD`. It records only the services that RUN, and only named fields.
 * - The data guard, applied by `Get-OwnerInstance` before it returns: every named volume mounted by a recorded service must
 *   be named disposable in the config's top-level extension `x-ythril: disposable-volumes: [...]` (not a volume label: a
 *   label added to an existing volume makes compose ask to recreate it, deleting it, on every install); a named volume
 *   at `/data`, `/data/db` or `/data/configdb` is refused even when named there. The refusal throws and names the
 *   service, the volume and the mount target. Binds are never refused (they survive the wipe), wherever they point.
 * - `Save-OwnerInstance -Record <obj> -Path <file> [-UseRecord] [-DiscardRecord]` → the record the caller restores. Writes
 *   atomically (no partial file and no leftover temporary file), creating the directory. A `pending` record at `-Path` is
 *   never overwritten: with neither switch it throws, naming its age, commit and services; `-UseRecord` keeps it and
 *   returns IT; `-DiscardRecord` replaces it; both switches together throw. A `restored` record is replaced freely.
 * - `Stop-OwnerInstance -Record <obj> -Docker <sb>` → `compose -p <project> --project-directory <wd> -f ... stop -t 60
 *   <recorded services>`.
 * - `Start-OwnerInstance -Record <obj> -Docker <sb>` → `compose ... up -d --no-build --wait <recorded services>` (what
 *   `docker-compact.ps1` uses: nothing was deleted, so nothing is rebuilt).
 * - `Restore-OwnerInstance -Path <file> -Docker <sb> -Git <sb> [-RestoreOnly]` → rebuilds and starts a pending record;
 *   with `-RestoreOnly` on a `restored` record it says so and does nothing.
 * - `Wait-Engine -Docker <sb> [-TimeoutSeconds 300] [-IntervalSeconds 5]` → returns once `& $Docker info` answers; throws
 *   when it has not by the timeout. `-IntervalSeconds 0` is accepted (the cases poll without sleeping).
 *
 * The record, as JSON:
 * `{ schema: 1, state: 'pending'|'restored', savedAt: <ISO-8601>, project, workingDir, configFiles: [..], commit,
 *    services: { <name>: { image, build: { context, dockerfile, args, target } | null, binds: [{ source, target }] } } }`
 * — never an environment, never the config text: the resolved config carries the Mongo password.
 *
 * ## What red looks like
 *
 * On a tree without the module every case fails with the same reason, `scripts/owner-instance.ps1 could not be
 * dot-sourced`, and that is the expected red. Each case asserts its own rule after that line, so a module that exists but
 * breaks one rule fails that row by name.
 *
 * Run: node --test testing/standalone/the-owner-instance-comes-back-after-a-wipe.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from './_sources.mjs';

const MODULE = join(REPO_ROOT, 'scripts', 'owner-instance.ps1');
const REPO = 'O:\\Projects\\Ythril';
const FILES = [`${REPO}\\docker-compose.yml`, `${REPO}\\docker-compose.override.yml`];
const SECRET = 'fake-mongo-pw-7f3a';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const EXT = 'x-ythril';
const DISPOSABLE = 'disposable-volumes';
const MONGO_IMAGE = 'mongodb/mongodb-atlas-local:latest@sha256:1cd040bb';

// ── canned docker answers ──────────────────────────────────────────────────────────────────────────────────────────

const bind = (source, target) => ({ type: 'bind', source, target, bind: { create_host_path: true } });
const vol = (source, target) => ({ type: 'volume', source, target, volume: {} });

/** A running container of a compose project, as `docker inspect` shows it. */
const container = (id, project, workingDir, configFiles, service) => ({
  Id: id, Name: `/${project}-${service}-1`,
  Config: { Image: `${project}-${service}`, Labels: {
    'com.docker.compose.project': project,
    'com.docker.compose.project.working_dir': workingDir,
    'com.docker.compose.project.config_files': configFiles.join(','),
    'com.docker.compose.service': service,
  } },
});

/** The owner's project's resolved config, as `compose config --format json` prints it — the password included. */
const ownerConfig = (edit = (c) => c) => edit({
  name: 'ythril',
  services: {
    ythril: {
      image: 'ythril-local',
      build: { context: REPO, dockerfile: 'Dockerfile', args: { NODE_VERSION: '22' } },
      environment: { MONGO_URI: `mongodb://ythril:${SECRET}@ythril-mongo:27017/?replicaSet=rs0`, MONGO_PASSWORD: SECRET },
      volumes: [bind(`${REPO}\\local-data\\ythril`, '/data'), bind(`${REPO}\\config`, '/config'),
        bind('C:\\Users\\owner\\.ythril\\connectors', '/connectors')],
    },
    'ythril-mongo': {
      image: MONGO_IMAGE,
      environment: { MONGODB_INITDB_ROOT_USERNAME: 'ythril', MONGODB_INITDB_ROOT_PASSWORD: SECRET },
      volumes: [bind(`${REPO}\\local-data\\mongo\\db`, '/data/db'), bind(`${REPO}\\local-data\\mongo\\configdb`, '/data/configdb')],
    },
    ollama: { image: 'ollama/ollama:latest', volumes: [vol('ythril-ollama-models', '/root/.ollama')] },
    whisper: { image: 'fedirz/faster-whisper-server:latest-cpu', volumes: [vol('ythril-whisper-cache', '/root/.cache')] },
    'doc-render': { image: 'ythril-doc-render:0.1.0', build: { context: `${REPO}\\sidecars\\doc-render` }, volumes: [vol('render-scratch', '/scratch')] },
  },
  volumes: {
    'ythril-ollama-models': { name: 'ythril_ythril-ollama-models' },
    'ythril-whisper-cache': { name: 'ythril_ythril-whisper-cache' },
    'render-scratch': { name: 'ythril_render-scratch' },
  },
  [EXT]: { [DISPOSABLE]: ['ythril-ollama-models', 'ythril-whisper-cache'] },
});
/** Name a volume disposable, as a compose file's `x-ythril: disposable-volumes:` does. */
const declareDisposable = (c, name) => { c[EXT][DISPOSABLE].push(name); };

/** The files of a scenario: which containers run, and each project's config. */
const scenario = ({ running, configs }) => ({
  'ps.txt': running.map((c) => c.Id).join('\n'),
  'inspect.json': JSON.stringify(running),
  ...Object.fromEntries(Object.entries(configs).map(([p, c]) => [`config-${p}.json`, JSON.stringify(c)])),
});

const owner = (services) => services.map((s, i) => container(`own${i}`, 'ythril', REPO, FILES, s));
const testStack = [container('tst0', 'ythril-test', `${REPO}\\testing`, [`${REPO}\\testing\\docker-compose.test.yml`], 'ythril-a'),
  container('tst1', 'ythril-test', `${REPO}\\testing`, [`${REPO}\\testing\\docker-compose.test.yml`], 'ythril-mongo-a')];
const ALL_FOUR = ['ythril', 'ythril-mongo', 'ollama', 'whisper'];

/** A stored record, as the module writes one. */
const storedRecord = (state, commit) => JSON.stringify({
  schema: 1, state, savedAt: '2026-10-20T08:00:00Z', project: 'ythril', workingDir: REPO, configFiles: FILES, commit,
  services: { ythril: { image: 'ythril-local', build: null, binds: [] }, 'ythril-mongo': { image: MONGO_IMAGE, build: null, binds: [] } },
});
// Parenthesised: it is passed as a command argument, where a bare hashtable literal does not parse.
const RECORD_PS = `([pscustomobject]@{ schema = 1; project = 'ythril'; workingDir = '${REPO}'; configFiles = @('${FILES[0]}', '${FILES[1]}'); commit = '${HEAD}'; services = [pscustomobject]@{ ythril = [pscustomobject]@{ image = 'ythril-local'; build = $null; binds = @() }; 'ythril-mongo' = [pscustomobject]@{ image = '${MONGO_IMAGE}'; build = $null; binds = @() } } })`;
const STATE = 'state\\owner-instance.json';

// ── the cases: files to lay down, PowerShell that sets $V, and what must hold ───────────────────────────────────────

const getCase = (running, configs = { ythril: ownerConfig() }, repoRoot = REPO) => ({
  files: scenario({ running, configs }),
  body: `$V = Get-OwnerInstance -RepoRoot '${repoRoot}' -Docker $Docker -Git $Git`,
});
/** A case that expects a refusal first proves the function exists, so "the command is not recognised" cannot pass it. */
const MUST_EXIST = (fn) => `$null = Get-Command ${fn} -CommandType Function;`;
const refusedNaming = (...names) => (r) => {
  assert.ok(r.error, `Get-OwnerInstance returned instead of refusing: ${JSON.stringify(r.value)}`);
  assert.doesNotMatch(r.error, /is not recognized|ObjectNotFound|could not find the command/i, `the refusal is a missing command: ${r.error}`);
  for (const n of names) assert.ok(r.error.includes(n), `the refusal does not name ${n}: ${r.error}`);
};
const recorded = (r) => {
  assert.equal(r.error, null, `Get-OwnerInstance threw: ${r.error}`);
  assert.ok(r.value && typeof r.value === 'object', `Get-OwnerInstance returned ${JSON.stringify(r.value)}`);
  return r.value;
};
const sameFile = (before) => (r) => {
  assert.equal(r.value?.text, before, 'the record on disk changed');
};

const CASES = [
  // pure
  { name: 'ConvertTo-ComparablePath folds case and the separator, and drops a trailing slash',
    body: `$V = @((ConvertTo-ComparablePath -Path 'O:\\Projects\\Ythril'), (ConvertTo-ComparablePath -Path 'o:/projects/ythril/'))`,
    expect: (r) => assert.deepEqual(r.value, ['o:/projects/ythril', 'o:/projects/ythril']) },
  { name: 'Test-SameDirectory: O:\\Projects\\Ythril is o:/projects/ythril, and is not O:\\Projects\\Ythril2',
    body: `$V = @((Test-SameDirectory -Path 'O:\\Projects\\Ythril' -Root 'o:/projects/ythril'), (Test-SameDirectory -Path 'O:\\Projects\\Ythril2' -Root 'O:\\Projects\\Ythril'))`,
    expect: (r) => assert.deepEqual(r.value, [true, false]) },
  { name: 'Test-PathUnder holds the root and below it, with a boundary',
    body: `$V = @((Test-PathUnder -Path 'O:\\Projects\\Ythril\\local-data\\mongo\\db' -Root 'o:/projects/ythril'), (Test-PathUnder -Path 'O:\\Projects\\Ythril' -Root 'O:\\Projects\\Ythril\\'), (Test-PathUnder -Path 'O:\\Projects\\Ythril-old\\data' -Root 'O:\\Projects\\Ythril'), (Test-PathUnder -Path 'C:\\Users\\owner\\.ythril' -Root 'O:\\Projects\\Ythril'))`,
    expect: (r) => assert.deepEqual(r.value, [true, true, false, false]) },
  { name: 'Split-ConfigFiles splits the label on commas, trimmed, empties dropped',
    body: `$V = @{ two = @(Split-ConfigFiles -Value '${FILES.join(',')}'); spaced = @(Split-ConfigFiles -Value ' a.yml , ,b.yml '); none = @(Split-ConfigFiles -Value '').Count }`,
    expect: (r) => assert.deepEqual(r.value, { two: FILES, spaced: ['a.yml', 'b.yml'], none: 0 }) },

  // Get: which project
  { name: 'Get selects this checkout\'s project and not the test stack under it', ...getCase([...owner(['ythril', 'ythril-mongo']), ...testStack]),
    expect: (r) => { const v = recorded(r); assert.equal(v.project, 'ythril'); assert.equal(v.workingDir, REPO); } },
  { name: 'Get matches working_dir whatever its spelling (o:/projects/ythril/ against O:\\Projects\\Ythril)',
    ...getCase(owner(['ythril', 'ythril-mongo']), undefined, 'o:/projects/ythril/'),
    expect: (r) => assert.equal(recorded(r).project, 'ythril') },
  { name: 'Get returns nothing, and does not refuse, when only the test stack runs', ...getCase(testStack, {}),
    expect: (r) => { assert.equal(r.error, null, `it refused: ${r.error}`); assert.equal(r.value, null); } },
  { name: 'Get refuses, naming it, when another non-test project runs and none matched',
    ...getCase([container('oth0', 'notes', 'D:\\work\\notes', ['D:\\work\\notes\\compose.yml'], 'app'), ...testStack], {}),
    expect: refusedNaming('notes') },
  { name: 'Read (compaction\'s read) returns nothing, and does not refuse, when another non-test project runs and none matched',
    files: scenario({ running: [container('oth0', 'notes', 'D:\\work\\notes', ['D:\\work\\notes\\compose.yml'], 'app'), ...testStack], configs: {} }),
    body: `$V = Read-OwnerInstance -RepoRoot '${REPO}' -Docker $Docker -Git $Git`,
    expect: (r) => { assert.equal(r.error, null, `it refused: ${r.error}`); assert.equal(r.value, null); } },
  { name: 'Get records the running services, not every service of the config',
    ...getCase(owner(['ythril', 'ythril-mongo', 'ollama'])),
    expect: (r) => assert.deepEqual(Object.keys(recorded(r).services).sort(), ['ollama', 'ythril', 'ythril-mongo']) },
  { name: 'Get splits config_files into the record',
    ...getCase(owner(['ythril', 'ythril-mongo'])),
    expect: (r) => assert.deepEqual(recorded(r).configFiles, FILES) },
  { name: 'Get reads the config from working_dir, for this project, with every config file',
    ...getCase(owner(['ythril', 'ythril-mongo'])),
    expect: (r) => {
      recorded(r);
      const call = r.calls.find((c) => c.startsWith('docker compose') && / config\b/.test(c));
      assert.ok(call, `no compose config call among ${JSON.stringify(r.calls)}`);
      for (const part of ['-p ythril', `--project-directory ${REPO}`, `-f ${FILES[0]}`, `-f ${FILES[1]}`]) {
        assert.ok(call.includes(part), `the config call lacks \`${part}\`: ${call}`);
      }
    } },
  { name: 'Get records the commit the checkout is at',
    ...getCase(owner(['ythril', 'ythril-mongo'])),
    expect: (r) => {
      assert.equal(recorded(r).commit, HEAD);
      assert.ok(r.calls.some((c) => c.startsWith('git') && c.includes(`-C ${REPO}`) && c.includes('rev-parse HEAD')), `no git -C <repo> rev-parse HEAD among ${JSON.stringify(r.calls)}`);
    } },
  { name: 'Get keeps only named fields: no environment, no password, no config text',
    ...getCase(owner(['ythril', 'ythril-mongo'])),
    expect: (r) => {
      const v = recorded(r);
      const text = JSON.stringify(v);
      assert.ok(!text.includes(SECRET), 'the record holds the Mongo password');
      assert.ok(!/environment/i.test(text), 'the record holds an environment');
      for (const [name, s] of Object.entries(v.services)) {
        assert.deepEqual(Object.keys(s).filter((k) => !['image', 'build', 'binds'].includes(k)), [], `${name} records more than image, build, binds`);
        if (s.build) assert.deepEqual(Object.keys(s.build).filter((k) => !['context', 'dockerfile', 'args', 'target'].includes(k)), [], `${name}'s build records more than context, dockerfile, args, target`);
      }
      assert.equal(v.services.ythril.image, 'ythril-local');
      assert.equal(v.services.ythril.build.context, REPO);
      assert.ok(v.services['ythril-mongo'].binds.some((b) => b.target === '/data/db' && b.source === `${REPO}\\local-data\\mongo\\db`), 'the mongo /data/db bind is not recorded');
    } },

  // the data guard
  { name: 'the guard passes disposable media volumes, and binds wherever they point',
    ...getCase(owner(ALL_FOUR)),
    expect: (r) => assert.deepEqual(Object.keys(recorded(r).services).sort(), [...ALL_FOUR].sort()) },
  // Each is named disposable on purpose: a volume not named is refused by that rule anyway, so only a named one
  // shows that /data, /data/db and /data/configdb are refused for what they hold.
  { name: 'the guard refuses a named volume at ythril /data, even one named disposable',
    ...getCase(owner(ALL_FOUR), { ythril: ownerConfig((c) => { c.services.ythril.volumes[0] = vol('ythril-data', '/data'); c.volumes['ythril-data'] = { name: 'ythril_ythril-data' }; declareDisposable(c, 'ythril-data'); return c; }) }),
    expect: refusedNaming('ythril-data', '/data') },
  { name: 'the guard refuses a named volume at mongo /data/db, even one named disposable',
    ...getCase(owner(ALL_FOUR), { ythril: ownerConfig((c) => { c.services['ythril-mongo'].volumes[0] = vol('ythril-mongo-data', '/data/db'); c.volumes['ythril-mongo-data'] = { name: 'ythril_ythril-mongo-data' }; declareDisposable(c, 'ythril-mongo-data'); return c; }) }),
    expect: refusedNaming('ythril-mongo-data', '/data/db') },
  { name: 'the guard refuses a named volume at mongo /data/configdb, even one named disposable',
    ...getCase(owner(ALL_FOUR), { ythril: ownerConfig((c) => { c.services['ythril-mongo'].volumes[1] = vol('ythril-mongo-configdb', '/data/configdb'); c.volumes['ythril-mongo-configdb'] = { name: 'ythril_ythril-mongo-configdb' }; declareDisposable(c, 'ythril-mongo-configdb'); return c; }) }),
    expect: refusedNaming('ythril-mongo-configdb', '/data/configdb') },
  { name: 'the guard refuses a named volume not declared disposable on a running service',
    ...getCase(owner(ALL_FOUR), { ythril: ownerConfig((c) => { c.services.ythril.volumes.push(vol('work-area', '/work')); c.volumes['work-area'] = { name: 'ythril_work-area' }; return c; }) }),
    expect: refusedNaming('work-area', '/work') },
  { name: 'the guard ignores a non-disposable named volume of a service that does not run',
    ...getCase(owner(['ythril', 'ythril-mongo'])),
    expect: (r) => assert.ok(!('doc-render' in recorded(r).services), 'a stopped service was recorded') },

  // Save
  { name: 'Save writes a pending record atomically, creating its directory, and leaves no temporary file',
    body: `$p = Join-Path $fx '${STATE}'; $ret = Save-OwnerInstance -Record ${RECORD_PS} -Path $p; $V = @{ names = @(Get-ChildItem -Force -LiteralPath (Split-Path $p) | ForEach-Object Name); record = ([IO.File]::ReadAllText($p) | ConvertFrom-Json); returned = $ret.commit }`,
    expect: (r) => {
      assert.equal(r.error, null, `Save threw: ${r.error}`);
      assert.deepEqual(r.value.names, ['owner-instance.json'], `the directory holds ${JSON.stringify(r.value.names)}`);
      assert.equal(r.value.record.state, 'pending');
      assert.equal(r.value.record.commit, HEAD);
      assert.ok(!Number.isNaN(Date.parse(r.value.record.savedAt)), `savedAt is ${r.value.record.savedAt}`);
      assert.equal(r.value.returned, HEAD);
    } },
  { name: 'Save never overwrites a pending record: it refuses, naming its commit and services',
    files: { [STATE]: storedRecord('pending', OLD) },
    body: `${MUST_EXIST('Save-OwnerInstance')} $p = Join-Path $fx '${STATE}'; try { Save-OwnerInstance -Record ${RECORD_PS} -Path $p | Out-Null; $msg =$null } catch { $msg = $_.Exception.Message }; $V = @{ msg = $msg; text = [IO.File]::ReadAllText($p) }`,
    expect: (r) => {
      assert.equal(r.error, null, `the case itself failed: ${r.error}`);
      assert.ok(r.value.msg, 'Save overwrote a pending record without being told to');
      for (const n of [OLD.slice(0, 7), 'ythril-mongo']) assert.ok(r.value.msg.includes(n), `the refusal does not name ${n}: ${r.value.msg}`);
      sameFile(storedRecord('pending', OLD))(r);
    } },
  { name: 'Save -UseRecord keeps the pending record and returns it',
    files: { [STATE]: storedRecord('pending', OLD) },
    body: `$p = Join-Path $fx '${STATE}'; $ret = Save-OwnerInstance -Record ${RECORD_PS} -Path $p -UseRecord; $V = @{ returned = $ret.commit; text = [IO.File]::ReadAllText($p) }`,
    expect: (r) => { assert.equal(r.error, null, `Save threw: ${r.error}`); assert.equal(r.value.returned, OLD); sameFile(storedRecord('pending', OLD))(r); } },
  { name: 'Save -DiscardRecord replaces the pending record',
    files: { [STATE]: storedRecord('pending', OLD) },
    body: `$p = Join-Path $fx '${STATE}'; $ret = Save-OwnerInstance -Record ${RECORD_PS} -Path $p -DiscardRecord; $V = @{ returned = $ret.commit; record = ([IO.File]::ReadAllText($p) | ConvertFrom-Json) }`,
    expect: (r) => { assert.equal(r.error, null, `Save threw: ${r.error}`); assert.equal(r.value.record.commit, HEAD); assert.equal(r.value.record.state, 'pending'); assert.equal(r.value.returned, HEAD); } },
  { name: 'Save refuses -UseRecord and -DiscardRecord together',
    files: { [STATE]: storedRecord('pending', OLD) },
    body: `${MUST_EXIST('Save-OwnerInstance')} $p = Join-Path $fx '${STATE}'; try { Save-OwnerInstance -Record ${RECORD_PS} -Path $p -UseRecord -DiscardRecord | Out-Null; $msg = $null } catch { $msg = $_.Exception.Message }; $V = @{ msg = $msg; text = [IO.File]::ReadAllText($p) }`,
    expect: (r) => { assert.equal(r.error, null, `the case itself failed: ${r.error}`); assert.ok(r.value.msg, 'both switches were accepted'); sameFile(storedRecord('pending', OLD))(r); } },
  { name: 'Save replaces a restored record without being told to',
    files: { [STATE]: storedRecord('restored', OLD) },
    body: `$p = Join-Path $fx '${STATE}'; Save-OwnerInstance -Record ${RECORD_PS} -Path $p | Out-Null; $V = @{ record = ([IO.File]::ReadAllText($p) | ConvertFrom-Json) }`,
    expect: (r) => { assert.equal(r.error, null, `Save threw: ${r.error}`); assert.equal(r.value.record.commit, HEAD); assert.equal(r.value.record.state, 'pending'); } },

  // Restore, Stop, Start, Wait-Engine
  { name: 'Restore -RestoreOnly on a restored record says so and does nothing',
    files: { [STATE]: storedRecord('restored', OLD) },
    body: `$p = Join-Path $fx '${STATE}'; $said = (Restore-OwnerInstance -Path $p -Docker $Docker -Git $Git -RestoreOnly 6>&1 | Out-String); $V = @{ said = $said; text = [IO.File]::ReadAllText($p) }`,
    expect: (r) => {
      assert.equal(r.error, null, `Restore threw: ${r.error}`);
      assert.match(r.value.said, /restored/i, `it did not say the record is already restored: ${r.value.said}`);
      assert.deepEqual(r.calls, [], 'it called docker or git');
      sameFile(storedRecord('restored', OLD))(r);
    } },
  { name: 'Stop stops only the recorded services, with a 60 s grace',
    body: `Stop-OwnerInstance -Record ${RECORD_PS} -Docker $Docker | Out-Null; $V = $true`,
    expect: (r) => {
      assert.equal(r.error, null, `Stop threw: ${r.error}`);
      const call = r.calls.find((c) => / stop\b/.test(c));
      assert.ok(call, `no compose stop among ${JSON.stringify(r.calls)}`);
      for (const part of ['-p ythril', `--project-directory ${REPO}`, '-t 60', ' ythril', ' ythril-mongo']) assert.ok(call.includes(part), `the stop call lacks \`${part}\`: ${call}`);
      assert.ok(!/\b(ollama|whisper)\b/.test(call), `the stop call names a service that was not recorded: ${call}`);
      assert.ok(!r.calls.some((c) => /\s(down|rm)\b/.test(c)), `it removed something: ${JSON.stringify(r.calls)}`);
    } },
  { name: 'Start brings the recorded services up and waits, without building',
    body: `Start-OwnerInstance -Record ${RECORD_PS} -Docker $Docker | Out-Null; $V = $true`,
    expect: (r) => {
      assert.equal(r.error, null, `Start threw: ${r.error}`);
      const call = r.calls.find((c) => / up\b/.test(c));
      assert.ok(call, `no compose up among ${JSON.stringify(r.calls)}`);
      for (const part of ['-p ythril', `--project-directory ${REPO}`, '--wait', '--no-build', ' ythril-mongo']) assert.ok(call.includes(part), `the up call lacks \`${part}\`: ${call}`);
      assert.ok(!/\b(ollama|whisper)\b/.test(call), `the up call starts a service that was not recorded: ${call}`);
    } },
  { name: 'Wait-Engine returns once the engine answers',
    body: `$global:InfoFailures = 2; Wait-Engine -Docker $Docker -TimeoutSeconds 30 -IntervalSeconds 0 | Out-Null; $V = $global:InfoCalls`,
    expect: (r) => { assert.equal(r.error, null, `Wait-Engine threw: ${r.error}`); assert.equal(r.value, 3, `docker info was asked ${r.value} times`); } },
  { name: 'Wait-Engine throws when the engine has not answered by the timeout',
    body: `${MUST_EXIST('Wait-Engine')} $global:InfoFailures = 1000000; try { Wait-Engine -Docker $Docker -TimeoutSeconds 1 -IntervalSeconds 0 | Out-Null; $V = 'returned' } catch { $V = 'threw' }; $global:Calls.Clear()`,
    expect: (r) => { assert.equal(r.error, null, `the case itself failed: ${r.error}`); assert.equal(r.value, 'threw'); } },
];

// ── the harness ────────────────────────────────────────────────────────────────────────────────────────────────────

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$results = @{}
function New-DockerStub([string]$fx) {
  return {
    $a = @($args)
    [void]$global:Calls.Add('docker ' + ($a -join ' '))
    switch ($a[0]) {
      'ps' { return @([IO.File]::ReadAllLines((Join-Path $fx 'ps.txt')) | Where-Object { $_ }) }
      'inspect' {
        $all = [IO.File]::ReadAllText((Join-Path $fx 'inspect.json')) | ConvertFrom-Json
        return (ConvertTo-Json -InputObject @($all | Where-Object { $a -contains $_.Id }) -Depth 20)
      }
      'info' { $global:InfoCalls++; if ($global:InfoCalls -le $global:InfoFailures) { throw 'the engine is not answering' }; return 'Server Version: stub' }
      'compose' {
        if ($a -contains 'config') { $p = $a[[array]::IndexOf($a, '-p') + 1]; return [IO.File]::ReadAllText((Join-Path $fx "config-$p.json")) }
        return ''
      }
    }
    throw "the stub has no answer for: docker $($a -join ' ')"
  }.GetNewClosure()
}
$GitStub = {
  $a = @($args)
  [void]$global:Calls.Add('git ' + ($a -join ' '))
  if ($a -contains 'rev-parse') { return ${q(HEAD)} }
  throw "the stub has no answer for: git $($a -join ' ')"
}
`;
const caseScript = (id, dir, body) => `
$global:Calls = New-Object System.Collections.ArrayList
$global:InfoCalls = 0; $global:InfoFailures = 0
$fx = ${q(dir)}
$Docker = New-DockerStub $fx
$Git = $GitStub
$V = $null; $err = $null; $loaded = $false
try {
  . ${q(MODULE)}
  $loaded = $true
  ${body}
} catch { $err = $_.Exception.Message }
$results[${q(id)}] = @{ loaded = $loaded; error = $err; value = $V; calls = @($global:Calls) }
`;

/** powershell.exe where it exists (the runtime these scripts run under here), else pwsh. */
function runPowerShell(file) {
  for (const exe of ['powershell.exe', 'pwsh']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error?.code === 'ENOENT') continue;
    return r;
  }
  throw new Error('neither powershell.exe nor pwsh is on PATH: the module cannot be exercised');
}

describe('the owner\'s instance comes back after a wipe', () => {
  let scratch;
  let results = {};

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ythril-owner-instance-'));
    let script = PRELUDE;
    CASES.forEach((c, i) => {
      const dir = join(scratch, `case-${i}`);
      mkdirSync(dir, { recursive: true });
      for (const [rel, text] of Object.entries(c.files ?? {})) {
        const path = join(dir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, text);
      }
      script += caseScript(String(i), dir, c.body);
    });
    script += `\n'@@RESULT@@' + (ConvertTo-Json -InputObject $results -Depth 12 -Compress)\n`;
    const file = join(scratch, 'cases.ps1');
    writeFileSync(file, '\ufeff' + script, 'utf8');
    const run = runPowerShell(file);
    const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('@@RESULT@@'));
    if (!line) throw new Error(`the PowerShell harness printed no result (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
    results = JSON.parse(line.slice('@@RESULT@@'.length));
  });

  after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('there are enough cases to call this a contract', () => {
    assert.ok(CASES.length >= 25, `only ${CASES.length} cases`);
  });

  CASES.forEach((c, i) => {
    it(c.name, () => {
      const r = results[String(i)];
      assert.ok(r, `case ${i} produced no result`);
      assert.ok(r.loaded, `scripts/owner-instance.ps1 could not be dot-sourced: ${r.error}`);
      r.calls = r.calls ?? [];
      c.expect(r);
    });
  });
});
