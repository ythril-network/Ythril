/**
 * The test stack's take-down leaves a container another session holds, with its volumes, and a start is refused while anything is held.
 *
 * ## What happened
 *
 * `npm run test:down` and `npm run test:up` ran `docker compose ... down -v` on both projects of the stack, whoever was using it. The stack's
 * database container `ythril-mongo-a` has a fixed name and is the one the container runner's other modes need, so a session that held it (a
 * booking `ythril/harness-mongo-a`) lost it, with its data, the moment another session took the stack down or started it again.
 *
 * ## The rule
 *
 * `testing/_init/stack-down.mjs` is the one place that takes the stack down. A live hold (a JSON file in the directory
 * `YTHRIL_TEST_STACK_HOLDS_DIR` names) keeps the containers it names, and the volumes they mount; every other container and volume of the stack goes;
 * a start (`--for-start`) is refused while anything of the stack is held. Docker that does not answer, and a hold that cannot be read, end the run
 * before anything is removed.
 *
 * ## What this file pins, offline
 *
 * The hold rule as a truth table (one row per way a hold file can be right, expired, stale or wrong, the fixture shaped exactly like a real booking
 * file), the parser on captured real `docker ps` and `docker volume ls` lines, the plan for a take-down, a start and an ignored hold, and the act
 * over a stubbed `exec`: a listing that fails, one that times out, one that prints rubbish, and a removal that fails. The same rule on real
 * containers is `the-test-stack-take-down-keeps-a-held-container-docker.test.js`.
 *
 * Run: node --test testing/standalone/the-test-stack-take-down-leaves-what-another-holds.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import {
  DEFAULT_PROJECTS, DEFAULT_COMPOSE_FILE, HOLDS_DIR_VARIABLE, liveHolds, parseContainers, parseVolumes, stackDownPlan, stackDown, parseArgs,
} from '../_init/stack-down.mjs';

const NOW = 1795030000000;

/** A booking file exactly as the machine's booking tool writes it (copied from a real one, `ythril/harness-mongo-a`). */
const BOOKING = { id: '1795020301757-35428', pid: 35428, mem: 3, label: 'ythril/harness-mongo-a', startedAt: 1795020301757, expiresAt: 1795063501757, containers: ['ythril-mongo-a'] };

/** One line of `docker ps -a --no-trunc --format '{{json .}}'` for the harness database, captured from the running stack. */
const PS_LINE = String.raw`{"Command":"\"/usr/local/bin/runner server\"","CreatedAt":"2026-11-18 17:45:01 +0100 CET","HealthStatus":"healthy","ID":"f6b405eeda56ca5050083308c87d2179fdd1759c0bf2277be8312ea08b905ed9","Image":"mongodb/mongodb-atlas-local:latest@sha256:1cd040bb201bb7f910c7c6ab7f6cb8ab9dd79331f6a213f37025adc6804e96aa","Labels":"architecture=x86_64,build-date=2025-05-13T04:42:10,com.docker.compose.config-hash=4f6e64f4ae70c52abb3da3667c42df9c4ff610b265cb46bb4081a493cb0c9f8b,com.docker.compose.container-number=1,com.docker.compose.depends_on=,com.docker.compose.image=sha256:092b295b93def153e6532bee8eb0f9f3aae932fd710102cc8c27ed218250b551,com.docker.compose.oneoff=False,com.docker.compose.project.config_files=E:\\TMP\\Ythril\\data\\wt-b284\\testing\\docker-compose.test.yml,com.docker.compose.project.working_dir=E:\\TMP\\Ythril\\data\\wt-b284\\testing,com.docker.compose.project=ythril-test,com.docker.compose.service=ythril-mongo-a,com.docker.compose.version=5.4.0,com.redhat.component=ubi9-minimal-container,com.redhat.license_terms=https://www.redhat.com/en/about/red-hat-end-user-license-agreements#UBI,description=Container configured with a single node replicaset instance of MongoDB and Atlas Search,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/27017/tcp=127.0.0.1:27117,distribution-scope=public,io.buildah.version=1.39.0-dev,io.k8s.description=The Universal Base Image Minimal is a stripped down image that uses microdnf as a package manager. This base image is freely redistributable, but Red Hat only supports Red Hat technologies through subscriptions for Red Hat products. This image is maintained by Red Hat and updated regularly.,io.k8s.display-name=Red Hat Universal Base Image 9 Minimal,io.openshift.expose-services=,io.openshift.tags=minimal rhel9,maintainer=support@mongodb.com,mongodb-atlas-local=container,mongodb-type=community,mongot-edition=localDev,mongot-version=1.71.0-1-g9cf3495129,name=MongoDB Atlas Local,release=1747111267,summary=MongoDB Atlas Local Container,url=https://www.redhat.com,vcs-ref=7575d7eb45eb7f545fef31ba067dfe3d8e52c4eb,vcs-type=git,vendor=MongoDB,version=8.3.4","LocalVolumes":"2","Mounts":"ythril-test_ythril-mongo-a-configdb,ythril-test_ythril-mongo-a-data","Names":"ythril-mongo-a","Networks":"ythril-test_ythril-test","Platform":{"architecture":"amd64","os":"linux"},"Ports":"127.0.0.1:27117-\u003e27017/tcp","RunningFor":"7 hours ago","Size":"68.1MB (virtual 1.49GB)","State":"running","Status":"Up 7 hours (healthy)"}`;

/** Two lines of `docker volume ls --filter label=com.docker.compose.project=ythril-test --format '{{json .}}'`, captured from the same stack. */
const VOLUME_LINES = [
  String.raw`{"Availability":"N/A","Driver":"local","Group":"N/A","Labels":"com.docker.compose.config-hash=fac258809a118377eb0f0bdb8b69817301f83b72a60febebe924211b7d2f7b1d,com.docker.compose.project=ythril-test,com.docker.compose.version=5.4.0,com.docker.compose.volume=ythril-data-a","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/ythril-test_ythril-data-a/_data","Name":"ythril-test_ythril-data-a","Scope":"local","Size":"N/A","Status":"N/A"}`,
  String.raw`{"Availability":"N/A","Driver":"local","Group":"N/A","Labels":"com.docker.compose.config-hash=0fe6d780da606f2357172d2f24f828c49f4ec577fae603891dc3c8866092c99c,com.docker.compose.project=ythril-test,com.docker.compose.version=5.4.0,com.docker.compose.volume=ythril-data-b","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/ythril-test_ythril-data-b/_data","Name":"ythril-test_ythril-data-b","Scope":"local","Size":"N/A","Status":"N/A"}`,
];

const scratch = mkdtempSync(join(tmpdir(), 'q922-offline-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let dirCount = 0;

/** A holds directory holding `files` (name -> text, or an object written as JSON). */
function holdsDir(files) {
  const dir = join(scratch, `holds-${++dirCount}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

const running = (name, project = 'ythril-test') => ({ name, project, state: 'running' });
const box = (name, project = 'ythril-test', over = {}) => ({ id: `id-${name}`, name, project, service: name, state: 'running', mounts: [], ...over });
const hold = (label, keys, over = {}) => ({ file: `${label}.json`, label, keys, all: false, ...over });

describe('liveHolds: when a hold file keeps what it names', () => {
  it('a real booking file is live while its container runs, and gives the label and its key', () => {
    const dir = holdsDir({ '1795020301757-35428.json': BOOKING });
    const holds = liveHolds({ dir, running: [running('ythril-mongo-a')], now: NOW });
    assert.equal(holds.length, 1);
    assert.equal(holds[0].label, 'ythril/harness-mongo-a');
    assert.deepEqual(holds[0].keys, ['ythril-mongo-a']);
    assert.equal(holds[0].all, false);
  });

  it('is not live when its named container does not run (the holder is gone, or has not started yet)', () => {
    const dir = holdsDir({ 'a.json': BOOKING });
    assert.deepEqual(liveHolds({ dir, running: [running('ythril-mongo-b')], now: NOW }), []);
    assert.deepEqual(liveHolds({ dir, running: [], now: NOW }), []);
    assert.deepEqual(liveHolds({ dir, running: [{ name: 'ythril-mongo-a', project: 'ythril-test', state: 'exited' }], now: NOW }), [], 'a stopped container is not running');
  });

  it('is not live once expired: expiresAt at or before now (epoch milliseconds), live a millisecond before it', () => {
    const at = (expiresAt) => liveHolds({ dir: holdsDir({ 'a.json': { ...BOOKING, expiresAt } }), running: [running('ythril-mongo-a')], now: NOW });
    assert.equal(at(NOW + 1).length, 1);
    assert.deepEqual(at(NOW), []);
    assert.deepEqual(at(NOW - 1), []);
    assert.deepEqual(at(0), []);
  });

  it('is live with an open end: expiresAt null, or absent', () => {
    const { expiresAt, ...withoutExpiry } = BOOKING;
    assert.ok(expiresAt);
    for (const body of [{ ...BOOKING, expiresAt: null }, withoutExpiry]) {
      assert.equal(liveHolds({ dir: holdsDir({ 'a.json': body }), running: [running('ythril-mongo-a')], now: NOW }).length, 1);
    }
  });

  it('a project key matches the compose project of a running container', () => {
    const dir = holdsDir({ 'a.json': { label: 'h', expiresAt: null, project: 'ythril-test' } });
    assert.equal(liveHolds({ dir, running: [running('ythril-a', 'ythril-test')], now: NOW }).length, 1);
    assert.deepEqual(liveHolds({ dir, running: [running('ythril-a', 'testing')], now: NOW }), []);
  });

  it('every key is matched against names and projects alike, as the booking tool does', () => {
    const asProject = holdsDir({ 'a.json': { label: 'h', expiresAt: null, project: 'ythril-mongo-a' } });
    assert.equal(liveHolds({ dir: asProject, running: [running('ythril-mongo-a')], now: NOW }).length, 1, 'a project key equal to a container name');
    const asContainer = holdsDir({ 'a.json': { label: 'h', expiresAt: null, containers: ['ythril-test'] } });
    assert.equal(liveHolds({ dir: asContainer, running: [running('ythril-a', 'ythril-test')], now: NOW }).length, 1, 'a containers entry equal to a compose project');
  });

  it('only *.json files are read; a stray file of another kind is no hold', () => {
    const dir = holdsDir({ 'notes.txt': 'not json at all', 'a.json': BOOKING, 'b.json.tmp': '{' });
    assert.equal(liveHolds({ dir, running: [running('ythril-mongo-a')], now: NOW }).length, 1);
  });

  it('strips control characters from a label, and names the file when a hold has none', () => {
    const dir = holdsDir({ 'a.json': { ...BOOKING, label: 'ythril/x\u001b[31m\nforged line' }, 'b.json': { containers: ['ythril-mongo-a'], expiresAt: null } });
    const labels = liveHolds({ dir, running: [running('ythril-mongo-a')], now: NOW }).map((h) => h.label).sort();
    assert.deepEqual(labels, ['b.json', 'ythril/x[31mforged line']);
  });
});

describe('liveHolds: a hold that cannot be understood keeps everything (fail closed)', () => {
  const live = (body) => liveHolds({ dir: holdsDir({ 'odd.json': body }), running: [running('ythril-mongo-a')], now: NOW });

  it('a file with neither containers nor project holds everything, and says so', () => {
    const [h] = live({ label: 'no keys', expiresAt: null });
    assert.equal(h.all, true);
    assert.match(h.note, /odd\.json/);
    assert.match(h.note, /containers|project/);
  });

  it('an empty containers list with no project is no key either', () => {
    assert.equal(live({ label: 'empty', containers: [], expiresAt: null })[0].all, true);
  });

  it('an expiresAt that is not null, absent or a finite number holds everything: text, a boolean, an object, and a number JSON reads as infinite', () => {
    for (const expiresAt of ['2027-01-01', true, {}, [1]]) assert.equal(live({ ...BOOKING, expiresAt })[0].all, true, JSON.stringify(expiresAt));
    const infinite = liveHolds({ dir: holdsDir({ 'odd.json': '{"label":"inf","containers":["x"],"expiresAt":1e999}' }), running: [running('ythril-mongo-a')], now: NOW });
    assert.equal(infinite[0].all, true, '1e999 is Infinity once parsed: not a finite number');
  });

  it('containers that is not a list of names holds everything', () => {
    assert.equal(live({ label: 'x', containers: 'ythril-mongo-a', expiresAt: null })[0].all, true);
    assert.equal(live({ label: 'x', containers: [7], expiresAt: null })[0].all, true);
  });

  it('JSON that is not an object (a list, null, a number) holds everything', () => {
    for (const body of ['[]', 'null', '42']) assert.equal(live(body)[0].all, true, body);
  });

  it('is live even when nothing it could name runs, so the plan decides what that keeps', () => {
    const dir = holdsDir({ 'odd.json': { label: 'x', expiresAt: null } });
    assert.equal(liveHolds({ dir, running: [], now: NOW }).length, 1);
  });

  it('a past expiry ends it whatever else the file says', () => {
    assert.deepEqual(live({ label: 'x', expiresAt: NOW - 5 }), []);
  });
});

describe('liveHolds: what it refuses to guess about', () => {
  it('a variable that is unset or empty names no directory: no hold, nothing read', () => {
    assert.deepEqual(liveHolds({ dir: undefined, running: [], now: NOW }), []);
    assert.deepEqual(liveHolds({ dir: '', running: [], now: NOW }), []);
  });

  it('a directory that does not exist is refused, naming it', () => {
    const dir = join(scratch, 'no-such-holds-dir');
    assert.throws(() => liveHolds({ dir, running: [], now: NOW }), (e) => e.message.includes(dir));
  });

  it('a path that is a file, not a directory, is refused, naming it', () => {
    const dir = holdsDir({ 'a.json': BOOKING });
    const file = join(dir, 'a.json');
    assert.throws(() => liveHolds({ dir: file, running: [], now: NOW }), (e) => e.message.includes(file));
  });

  it('a file that cannot be read is tried once more: read on the second try it is a hold like any other', () => {
    const dir = holdsDir({ 'a.json': BOOKING });
    const calls = [];
    const readFile = (path, enc) => { calls.push(path); if (calls.length === 1) throw new Error('EBUSY'); return JSON.stringify(BOOKING); };
    const holds = liveHolds({ dir, running: [running('ythril-mongo-a')], now: NOW, readFile });
    assert.equal(holds.length, 1);
    assert.equal(calls.length, 2);
  });

  it('a file that cannot be read twice refuses, naming the file', () => {
    const dir = holdsDir({ 'a.json': BOOKING });
    let calls = 0;
    const readFile = () => { calls++; throw new Error('EACCES'); };
    assert.throws(() => liveHolds({ dir, running: [], now: NOW, readFile }), (e) => e.message.includes(join(dir, 'a.json')) && /EACCES/.test(e.message));
    assert.equal(calls, 2);
  });

  it('a file whose JSON is cut off (written while read) is tried again and then refused, naming the file', () => {
    const dir = holdsDir({ 'half.json': '{"label":"x","contain' });
    assert.throws(() => liveHolds({ dir, running: [], now: NOW }), (e) => e.message.includes(join(dir, 'half.json')));
  });
});

describe('parseContainers and parseVolumes: Docker\'s JSON lines as plain objects', () => {
  it('reads the captured docker ps line: name, id, state, compose project and service, and the volumes it mounts', () => {
    const [c] = parseContainers(`${PS_LINE}\n`);
    assert.equal(c.name, 'ythril-mongo-a');
    assert.equal(c.id, 'f6b405eeda56ca5050083308c87d2179fdd1759c0bf2277be8312ea08b905ed9');
    assert.equal(c.state, 'running');
    assert.equal(c.project, 'ythril-test');
    assert.equal(c.service, 'ythril-mongo-a');
    assert.deepEqual(c.mounts, ['ythril-test_ythril-mongo-a-configdb', 'ythril-test_ythril-mongo-a-data']);
  });

  it('reads every line, skips blank ones, and gives an empty list for no output at all', () => {
    const second = JSON.stringify({ ...JSON.parse(PS_LINE), Names: 'ythril-a', State: 'exited', Mounts: '' });
    const found = parseContainers(`${PS_LINE}\r\n\r\n${second}\n`);
    assert.deepEqual(found.map((c) => [c.name, c.state, c.mounts.length]), [['ythril-mongo-a', 'running', 2], ['ythril-a', 'exited', 0]]);
    assert.deepEqual(parseContainers(''), []);
    assert.deepEqual(parseContainers('\n'), []);
  });

  it('reads the captured docker volume ls lines: name and compose project', () => {
    const found = parseVolumes(`${VOLUME_LINES.join('\n')}\n`);
    assert.deepEqual(found, [{ name: 'ythril-test_ythril-data-a', project: 'ythril-test' }, { name: 'ythril-test_ythril-data-b', project: 'ythril-test' }]);
  });

  it('refuses output that is not JSON lines, naming what it saw, instead of reading it as an empty list', () => {
    assert.throws(() => parseContainers('Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine'), /Cannot connect/);
    assert.throws(() => parseContainers(`${PS_LINE}\n{"Names":"ythril-a"`), /not JSON|JSON/);
    assert.throws(() => parseVolumes('error during connect'), /error during connect/);
  });

  it('refuses a JSON line that has no container name or no id', () => {
    assert.throws(() => parseContainers('{"State":"running"}'), /Names|name/);
    assert.throws(() => parseContainers('[1,2]'));
    assert.throws(() => parseVolumes('{"Driver":"local"}'), /Name/);
  });
});

describe('stackDownPlan: what goes, what stays, what is wiped, and when a start is refused', () => {
  const stack = [
    box('ythril-mongo-a', 'ythril-test', { mounts: ['ythril-test_ythril-mongo-a-data', 'ythril-test_ythril-mongo-a-configdb'] }),
    box('ythril-a', 'ythril-test', { mounts: ['ythril-test_ythril-data-a'] }),
    box('ythril-b', 'ythril-test', { mounts: ['ythril-test_ythril-data-b'] }),
    box('ythril-c', 'testing', { mounts: ['testing_ythril-data-c'] }),
  ];
  const volumes = [
    { name: 'ythril-test_ythril-mongo-a-data', project: 'ythril-test' },
    { name: 'ythril-test_ythril-mongo-a-configdb', project: 'ythril-test' },
    { name: 'ythril-test_ythril-data-a', project: 'ythril-test' },
    { name: 'ythril-test_ythril-data-b', project: 'ythril-test' },
    { name: 'testing_ythril-data-c', project: 'testing' },
    { name: 'testing_ythril-data-orphan', project: 'testing' },
  ];
  const plan = (over = {}) => stackDownPlan({ containers: stack, volumes, holds: [], forStart: false, ignoreHolds: false, ...over });

  it('with nothing held, everything goes by the project\'s own down, and every instance config is wiped', () => {
    const p = plan();
    assert.equal(p.mode, 'down-all');
    assert.deepEqual(p.kept, []);
    assert.deepEqual(p.wipeInstances, ['a', 'b', 'c', 'd']);
    assert.equal(p.refusal, null);
  });

  it('keeps the held container and its volumes; removes every other container and every other volume of the projects', () => {
    const p = plan({ holds: [hold('ythril/harness-mongo-a', ['ythril-mongo-a'])] });
    assert.equal(p.mode, 'selective');
    assert.deepEqual(p.kept.map((k) => [k.name, k.holders]), [['ythril-mongo-a', ['ythril/harness-mongo-a']]]);
    assert.deepEqual(p.removeContainers.sort(), ['ythril-a', 'ythril-b', 'ythril-c']);
    assert.deepEqual(p.keptVolumes.sort(), ['ythril-test_ythril-mongo-a-configdb', 'ythril-test_ythril-mongo-a-data']);
    assert.deepEqual(p.removeVolumes.sort(), ['testing_ythril-data-c', 'testing_ythril-data-orphan', 'ythril-test_ythril-data-a', 'ythril-test_ythril-data-b']);
  });

  it('wipes the config of an instance whose container went and keeps the config of one that is kept', () => {
    const p = plan({ holds: [hold('h', ['ythril-b'])] });
    assert.deepEqual(p.wipeInstances, ['a', 'c', 'd']);
    const onlyMongo = plan({ holds: [hold('h', ['ythril-mongo-a'])] });
    assert.deepEqual(onlyMongo.wipeInstances, ['a', 'b', 'c', 'd'], 'a kept database is no kept instance');
  });

  it('a hold by project keeps every container of that project and none of another', () => {
    const p = plan({ holds: [hold('h', ['ythril-test'])] });
    assert.deepEqual(p.kept.map((k) => k.name).sort(), ['ythril-a', 'ythril-b', 'ythril-mongo-a']);
    assert.deepEqual(p.removeContainers, ['ythril-c']);
    assert.ok(p.keptVolumes.includes('ythril-test_ythril-data-a'));
    assert.ok(p.removeVolumes.includes('testing_ythril-data-c'));
  });

  it('a hold on everything keeps every container', () => {
    const p = plan({ holds: [hold('odd', [], { all: true })] });
    assert.equal(p.kept.length, 4);
    assert.deepEqual(p.removeContainers, []);
    assert.deepEqual(p.removeVolumes, ['testing_ythril-data-orphan'], 'only a volume no kept container mounts');
    assert.deepEqual(p.wipeInstances, ['d']);
  });

  it('names every holder of a container', () => {
    const p = plan({ holds: [hold('first', ['ythril-mongo-a']), hold('second', ['ythril-test'])] });
    assert.deepEqual(p.kept.find((k) => k.name === 'ythril-mongo-a').holders.sort(), ['first', 'second']);
  });

  it('a start is refused while anything is held: the holder\'s label, how to end the hold, and nothing removed or wiped', () => {
    const p = plan({ forStart: true, holds: [hold('ythril/harness-mongo-a', ['ythril-mongo-a'])] });
    assert.equal(p.mode, 'refused');
    assert.match(p.refusal, /ythril\/harness-mongo-a/);
    assert.match(p.refusal, /ythril-mongo-a/);
    assert.match(p.refusal, /test:down:all/);
    assert.deepEqual([p.removeContainers, p.removeVolumes, p.wipeInstances], [[], [], []]);
  });

  it('a start with nothing held is the full take-down, so the stack starts clean', () => {
    const p = plan({ forStart: true });
    assert.equal(p.mode, 'down-all');
    assert.equal(p.refusal, null);
  });

  it('a hold that names a container the stack does not have keeps nothing and refuses nothing', () => {
    const p = plan({ forStart: true, holds: [hold('h', ['some-other-container'])] });
    assert.equal(p.mode, 'down-all');
  });

  it('ignoring holds takes everything down, for a take-down and for a start alike', () => {
    for (const forStart of [false, true]) {
      const p = plan({ forStart, ignoreHolds: true, holds: [hold('h', ['ythril-mongo-a']), hold('odd', [], { all: true })] });
      assert.equal(p.mode, 'down-all', `forStart ${forStart}`);
      assert.deepEqual(p.kept, []);
      assert.equal(p.refusal, null);
    }
  });

  it('a stack of nothing has nothing to keep, whatever is held', () => {
    const p = stackDownPlan({ containers: [], volumes: [], holds: [hold('odd', [], { all: true })], forStart: true, ignoreHolds: false });
    assert.equal(p.mode, 'down-all');
  });

  it('wipes the instances the caller names, and only those', () => {
    const p = stackDownPlan({ containers: [box('x-app')], volumes: [], holds: [hold('h', ['x-app'])], forStart: false, ignoreHolds: false, instances: [{ id: 'p', container: 'x-app' }, { id: 'q', container: 'x-gone' }] });
    assert.deepEqual(p.wipeInstances, ['q']);
  });
});

describe('parseArgs', () => {
  it('reads the two flags, and neither by default', () => {
    assert.deepEqual(parseArgs([]), { forStart: false, ignoreHolds: false });
    assert.deepEqual(parseArgs(['--for-start']), { forStart: true, ignoreHolds: false });
    assert.deepEqual(parseArgs(['--ignore-holds']), { forStart: false, ignoreHolds: true });
  });

  it('refuses anything else: a misspelt flag must not be read as "no flag" and take the stack down', () => {
    assert.throws(() => parseArgs(['--for-strat']), /--for-strat/);
    assert.throws(() => parseArgs(['all']), /all/);
  });

  it('the command line exits 2 on an unknown flag before it asks Docker anything', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'testing', '_init', 'stack-down.mjs'), '--for-strat'], { encoding: 'utf8', env: testChildEnv(), timeout: 30_000 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--for-strat/);
  });

  it('the real project names are the command line\'s defaults, with the default project named explicitly', () => {
    assert.deepEqual(DEFAULT_PROJECTS, ['ythril-test', 'testing']);
    assert.equal(DEFAULT_COMPOSE_FILE, 'testing/docker-compose.test.yml');
    assert.equal(HOLDS_DIR_VARIABLE, 'YTHRIL_TEST_STACK_HOLDS_DIR');
  });
});

/**
 * A Docker that answers from a table: `projects` is `{ project: { containers: [box...], volumes: [name...] } }`; `fail` maps a call's first
 * distinguishing word (`ps`, `volume-ls`, `rm`, `volume-rm`, `down`) to what that call returns instead; `garbage` makes the container listing print rubbish.
 */
function dockerWorld({ projects = {}, fail = {}, garbage = false } = {}) {
  const calls = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', timedOut: false });
  const exec = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    const label = args.find((a) => a.startsWith('label=com.docker.compose.project='));
    const project = label?.slice('label=com.docker.compose.project='.length);
    const kind = args[0] === 'ps' ? 'ps' : args[0] === 'volume' ? `volume-${args[1]}` : args[0] === 'compose' ? 'down' : args[0];
    const name = args.at(-1);
    const failure = fail[`${kind} ${name}`] ?? fail[kind];
    if (failure) return { status: 1, stdout: '', stderr: '', timedOut: false, ...failure };
    if (kind === 'ps') {
      if (garbage) return ok('Cannot connect to the Docker daemon');
      return ok((projects[project]?.containers ?? []).map((c) => JSON.stringify({ ID: c.id, Names: c.name, State: c.state, Labels: `com.docker.compose.project=${project},com.docker.compose.service=${c.service}`, Mounts: c.mounts.join(',') })).join('\n'));
    }
    if (kind === 'volume-ls') return ok((projects[project]?.volumes ?? []).map((v) => JSON.stringify({ Name: v, Labels: `com.docker.compose.project=${project}` })).join('\n'));
    return ok();
  };
  const removals = () => calls.filter((c) => c.args[0] === 'rm' || (c.args[0] === 'volume' && c.args[1] === 'rm') || c.args[0] === 'compose').map((c) => c.args);
  return { exec, calls, removals };
}

describe('stackDown: the act, over a stubbed Docker', () => {
  const stack = {
    'ythril-test': { containers: [box('ythril-mongo-a', 'ythril-test', { mounts: ['ythril-test_mongo-a-data'] }), box('ythril-a', 'ythril-test', { mounts: ['ythril-test_data-a'] })], volumes: ['ythril-test_mongo-a-data', 'ythril-test_data-a'] },
    testing: { containers: [], volumes: ['testing_stray'] },
  };
  const COMPOSE = 'E:/somewhere/testing/docker-compose.test.yml';

  function run(over = {}) {
    const lines = [];
    const errors = [];
    const configsDir = join(scratch, `configs-${++dirCount}`);
    for (const x of ['a', 'b', 'c', 'd']) { mkdirSync(join(configsDir, x), { recursive: true }); writeFileSync(join(configsDir, x, 'config.json'), '{}'); }
    const world = over.world ?? dockerWorld({ projects: stack });
    const code = stackDown({
      projects: ['ythril-test', 'testing'], composeFile: COMPOSE, holdsDir: undefined, forStart: false, ignoreHolds: false,
      exec: world.exec, configsDir, now: NOW, log: (l) => lines.push(l), error: (l) => errors.push(l), ...over.args,
    });
    const wiped = () => ['a', 'b', 'c', 'd'].filter((x) => readdirSync(join(configsDir, x)).length === 0);
    return { code, lines, errors, text: [...lines, ...errors].join('\n'), world, wiped };
  }

  it('with no holds directory set, says nothing is kept, then downs both projects by name, each with -v and --remove-orphans', () => {
    const r = run();
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`${HOLDS_DIR_VARIABLE}.*nothing is kept`));
    const downs = r.world.removals().filter((a) => a[0] === 'compose');
    assert.deepEqual(downs, [
      ['compose', '-p', 'ythril-test', '-f', COMPOSE, 'down', '-v', '--remove-orphans'],
      ['compose', '-p', 'testing', '-f', COMPOSE, 'down', '-v', '--remove-orphans'],
    ]);
    assert.deepEqual(r.wiped(), ['a', 'b', 'c', 'd']);
  });

  it('with a live hold on the database: removes the other container and the volumes no kept container mounts, never the held ones, and names the holder', () => {
    const dir = holdsDir({ 'b.json': BOOKING });
    const r = run({ args: { holdsDir: dir } });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(r.world.removals(), [['rm', '-f', '-v', 'ythril-a'], ['volume', 'rm', 'ythril-test_data-a'], ['volume', 'rm', 'testing_stray']]);
    assert.match(r.text, /kept ythril-mongo-a.*ythril\/harness-mongo-a/);
    assert.deepEqual(r.wiped(), ['a', 'b', 'c', 'd'], 'ythril-a went, so its config goes; no instance is kept');
  });

  it('a kept instance keeps its config', () => {
    const dir = holdsDir({ 'b.json': { label: 'holder', expiresAt: null, containers: ['ythril-a'] } });
    const r = run({ args: { holdsDir: dir } });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(r.wiped(), ['b', 'c', 'd']);
  });

  it('a holds directory that is set but missing ends with 1, naming it, before anything is removed', () => {
    const dir = join(scratch, 'missing-holds');
    const r = run({ args: { holdsDir: dir } });
    assert.equal(r.code, 1);
    assert.ok(r.text.includes(dir), r.text);
    assert.deepEqual(r.world.removals(), []);
    assert.deepEqual(r.wiped(), []);
  });

  it('a start with a live hold ends with 1, the holder\'s label and how to end the hold, and removes and wipes nothing', () => {
    const dir = holdsDir({ 'b.json': BOOKING });
    const r = run({ args: { holdsDir: dir, forStart: true } });
    assert.equal(r.code, 1);
    assert.match(r.text, /ythril\/harness-mongo-a/);
    assert.match(r.text, /test:down:all/);
    assert.deepEqual(r.world.removals(), []);
    assert.deepEqual(r.wiped(), []);
  });

  it('a start with nothing held downs both projects', () => {
    const r = run({ args: { forStart: true, holdsDir: holdsDir({ 'old.json': { ...BOOKING, expiresAt: NOW - 1 } }) } });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.world.removals().filter((a) => a[0] === 'compose').length, 2);
  });

  it('ignoring holds does not read them: a missing directory does not matter, and a held container goes', () => {
    const r = run({ args: { holdsDir: join(scratch, 'missing-holds'), ignoreHolds: true, forStart: true } });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /holds are ignored/);
    assert.equal(r.world.removals().filter((a) => a[0] === 'compose').length, 2);
  });

  it('a listing that fails ends with 1 and the reason, and removes nothing (never read as an empty stack)', () => {
    const world = dockerWorld({ projects: stack, fail: { ps: { status: 1, stderr: 'Cannot connect to the Docker daemon at npipe\n' } } });
    const r = run({ world });
    assert.equal(r.code, 1);
    assert.match(r.text, /Cannot connect to the Docker daemon/);
    assert.deepEqual(world.removals(), []);
    assert.deepEqual(r.wiped(), []);
  });

  it('a volume listing that fails ends with 1 before any removal, although the container listing worked', () => {
    const world = dockerWorld({ projects: stack, fail: { 'volume-ls': { status: 125, stderr: 'volume list failed' } } });
    const r = run({ world, args: { holdsDir: holdsDir({ 'b.json': BOOKING }) } });
    assert.equal(r.code, 1);
    assert.match(r.text, /volume list failed/);
    assert.deepEqual(world.removals(), []);
  });

  it('a listing that times out ends with 1 and says it timed out, and removes nothing', () => {
    const world = dockerWorld({ projects: stack, fail: { ps: { status: null, timedOut: true } } });
    const r = run({ world });
    assert.equal(r.code, 1);
    assert.match(r.text, /timed out/i);
    assert.deepEqual(world.removals(), []);
  });

  it('every Docker call has a timeout', () => {
    const r = run({ args: { holdsDir: holdsDir({ 'b.json': BOOKING }) } });
    assert.ok(r.world.calls.length >= 5);
    for (const c of r.world.calls) assert.ok(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0, c.args.join(' '));
  });

  it('a listing that prints rubbish ends with 1, naming it, and removes nothing', () => {
    const world = dockerWorld({ projects: stack, garbage: true });
    const r = run({ world });
    assert.equal(r.code, 1);
    assert.match(r.text, /Cannot connect to the Docker daemon/);
    assert.deepEqual(world.removals(), []);
  });

  it('a removal that fails is named and ends with 1 after the others were tried; configs are not wiped on a failure', () => {
    const many = { ...stack, 'ythril-test': { containers: [...stack['ythril-test'].containers, box('ythril-b', 'ythril-test', { mounts: ['ythril-test_data-b'] })], volumes: [...stack['ythril-test'].volumes, 'ythril-test_data-b'] } };
    const world = dockerWorld({ projects: many, fail: { 'rm ythril-a': { status: 1, stderr: 'removal of container ythril-a is already in progress' } } });
    const r = run({ world, args: { holdsDir: holdsDir({ 'b.json': BOOKING }) } });
    assert.equal(r.code, 1);
    assert.match(r.text, /ythril-a/);
    assert.match(r.text, /already in progress/);
    assert.ok(world.removals().some((a) => a.at(-1) === 'ythril-b'), 'the removal after the failed one was still tried');
    assert.ok(world.removals().some((a) => a[1] === 'rm' && a.at(-1) === 'ythril-test_data-b'), 'a volume removal still ran');
    assert.deepEqual(r.wiped(), []);
  });

  it('a project\'s down that fails is named and ends with 1, after the other project was also taken down', () => {
    const world = dockerWorld({ projects: stack, fail: { down: { status: 1, stderr: 'compose exploded' } } });
    const r = run({ world });
    assert.equal(r.code, 1);
    assert.match(r.text, /compose exploded/);
    assert.equal(world.removals().filter((a) => a[0] === 'compose').length, 2);
    assert.deepEqual(r.wiped(), []);
  });

  it('removes volumes of no project it was not given (the listing is by the projects\' label)', () => {
    const r = run({ args: { holdsDir: holdsDir({ 'b.json': BOOKING }) } });
    const asked = r.world.calls.filter((c) => c.args[0] === 'ps' || c.args[1] === 'ls').map((c) => c.args.find((a) => a.startsWith('label=')));
    assert.deepEqual([...new Set(asked)].sort(), ['label=com.docker.compose.project=testing', 'label=com.docker.compose.project=ythril-test']);
  });

  it('a config directory that does not exist is no failure', () => {
    const r = run({ args: { configsDir: join(scratch, 'no-configs-here') } });
    assert.equal(r.code, 0, r.text);
    assert.ok(!existsSync(join(scratch, 'no-configs-here')));
  });
});
