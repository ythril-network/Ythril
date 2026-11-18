/**
 * The application's own container is confined, in the compose file that ships and in the test stack (`Q-915`).
 *
 * ## The defect it closes
 *
 * The sidecars that parse uploads were confined long ago (`compose-sidecar-hardening.test.js`); the app was exempt as
 * "the trust boundary" and kept Docker's defaults: fourteen capabilities in its bounding set, a writable root and no
 * process ceiling. It is the one container that holds every token and reaches the database, so what a flaw in it can do
 * to its own container matters most there.
 *
 * ## Why these controls cost nothing, measured
 *
 * On an instance twenty hours in real use: the process runs as uid 1000 with no effective capability, and the only
 * path it wrote outside its two volumes was `/home/node/.ythril-local-connector`. Nothing under `/tmp`; the server names
 * no temporary folder. So all capabilities dropped, no new privileges and a read-only root take nothing it uses, given
 * a tmpfs at `/tmp` and at `/home/node`.
 *
 * ## What is held
 *
 * - `docker-compose.yml`: the app drops all capabilities, forbids new privileges, has a read-only root with a tmpfs at
 *   `/tmp` and at its home folder, and a process ceiling an operator can raise.
 * - `testing/docker-compose.test.yml`: every service that runs the app image carries the same, so every stack suite
 *   runs against a confined app and a control the app cannot live with fails a suite, not an operator's instance.
 *   Which services those are is read from the file (the image they run), never listed here.
 *
 * No CPU ceiling is asked: Docker refuses one above the host's cores ("range of CPUs is from 0.01 to 16.00" for 64 on a
 * 16-core engine), so a default would stop the stack on a smaller host.
 *
 * Run: node --test testing/standalone/the-app-container-is-confined.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompose } from '../_shared/compose-file.mjs';

const PRODUCTION = loadCompose('docker-compose.yml');
const TEST = loadCompose('testing/docker-compose.test.yml');

/** The app's service in the shipped file. */
const APP = 'ythril';
/** The image every app service of the test stack runs: `ythril-a` builds it, the others name it. */
const TEST_APP_IMAGE = 'ythril-test:latest';
/** The folders the app writes outside its volumes: scratch, and its home (the local connector's token and log). */
const WRITABLE = ['/tmp', '/home/node'];

/** The mount point of one tmpfs entry (`/tmp:size=64m,uid=1000` is `/tmp`). */
const tmpfsPath = (entry) => String(entry).split(':')[0];

/** What a service lacks of the app's confinement, as sentences; empty when it carries all of it. */
function confinementShortfalls(name, service) {
  const lacks = [];
  if (!(service.security_opt ?? []).includes('no-new-privileges:true')) lacks.push(`${name}: no \`security_opt: [no-new-privileges:true]\``);
  if (!(service.cap_drop ?? []).includes('ALL')) lacks.push(`${name}: \`cap_drop\` lacks "ALL"`);
  if (service.read_only !== true) lacks.push(`${name}: no \`read_only: true\``);
  const mounted = [].concat(service.tmpfs ?? []).map(tmpfsPath);
  for (const dir of WRITABLE) if (!mounted.includes(dir)) lacks.push(`${name}: no tmpfs at ${dir}, which the app writes on a read-only root`);
  if (service.pids_limit === undefined) lacks.push(`${name}: no \`pids_limit\``);
  return lacks;
}

describe('the application container is confined', () => {
  it('in the compose file that ships', () => {
    assert.ok(PRODUCTION.services[APP], `docker-compose.yml has no service named ${APP}`);
    assert.deepEqual(confinementShortfalls(APP, PRODUCTION.services[APP]), []);
  });

  it('its process ceiling can be raised from .env, not only by editing the file', () => {
    const value = String(PRODUCTION.services[APP]?.pids_limit ?? '');
    assert.match(value, /^\$\{YTHRIL_PIDS_LIMIT:-\d+\}$/, `pids_limit should read \${YTHRIL_PIDS_LIMIT:-<default>}, got "${value}"`);
  });

  it('in the test stack: every service that runs the app image, found from the file', () => {
    const apps = Object.entries(TEST.services).filter(([, svc]) => svc.image === TEST_APP_IMAGE);
    assert.ok(apps.length >= 4, `only ${apps.length} service(s) run ${TEST_APP_IMAGE}: the scan is wrong, not the stack`);
    assert.deepEqual(apps.flatMap(([name, svc]) => confinementShortfalls(name, svc)), []);
  });

  describe('the check itself', () => {
    const confined = () => ({
      security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], read_only: true,
      tmpfs: ['/tmp:size=64m', '/home/node:uid=1000,gid=1000,mode=0700'], pids_limit: 1024,
    });
    const BREAKS = [
      ['new privileges are allowed', (s) => { s.security_opt = ['seccomp=unconfined']; }, /no-new-privileges/],
      ['one capability is dropped, not all', (s) => { s.cap_drop = ['NET_RAW']; }, /lacks "ALL"/],
      ['the root is writable', (s) => { delete s.read_only; }, /read_only/],
      ['the home folder has no tmpfs', (s) => { s.tmpfs = ['/tmp']; }, /tmpfs at \/home\/node/],
      ['there is no scratch folder', (s) => { s.tmpfs = '/home/node'; }, /tmpfs at \/tmp/],
      ['there is no process ceiling', (s) => { delete s.pids_limit; }, /pids_limit/],
    ];

    it('passes a confined service', () => {
      assert.deepEqual(confinementShortfalls('s', confined()), []);
    });

    for (const [what, mutate, expected] of BREAKS) {
      it(`names it when ${what}`, () => {
        const s = confined();
        mutate(s);
        const found = confinementShortfalls('s', s);
        assert.equal(found.length, 1, `expected one shortfall, got ${JSON.stringify(found)}`);
        assert.match(found[0], expected);
      });
    }
  });
});
