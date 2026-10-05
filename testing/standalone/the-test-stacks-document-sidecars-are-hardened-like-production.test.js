/**
 * The test stack's document sidecars carry the hardening production gives them, and EVERY port the test stack publishes is on loopback.
 *
 * ## What this prevents
 *
 * `doc-render` and `doc-office` parse UNTRUSTED documents — a PDF or an office file is a parser's worst input. In the
 * production compose both run read-only, with every capability dropped, `no-new-privileges`, a process ceiling and
 * (for the office one, which LibreOffice needs it for) a tmpfs, on an internal network with no egress; the compose
 * comments say exactly why. The TEST stack's `doc-render` carried none of it and published `8100:8100` on every
 * interface, so a CI runner or a developer's machine ran the same parser, with the same inputs the tests feed it,
 * wide open and reachable from the network — and the suite that tests the sidecar proved nothing about the hardened
 * one. `doc-office` is added to the test stack so the office extraction path is tested rather than skipped; it must
 * arrive hardened, not become the second sidecar to be fixed afterwards.
 *
 * ## How the set is derived
 *
 * The keys are READ OUT OF THE PRODUCTION SERVICE: every key it carries that is not deployment plumbing (the
 * `PLUMBING` list below — image, ports, volumes, healthcheck, resource ceilings, which the machine-room gate holds)
 * is a hardening key, and the test service must carry it at least as strictly. It is a denylist on purpose, so a
 * hardening key added to production tomorrow (`user:`, `sysctls:`) is required of the test stack without anyone
 * editing a list here. The "at least as strict" comparison is per kind of value: a flag must be equal, a list must
 * contain every production entry (a mount is compared by its path, so the test may size a tmpfs differently), a
 * scalar ceiling must be present.
 *
 * **Loopback**: a published port with no host address binds `0.0.0.0`. Every port of both sidecars must name
 * `127.0.0.1`. The ports are there so the render and office tests, which run on the host, can reach the service
 * directly; that is a reason to publish them to the host, not to the network.
 *
 * **Every service, not only the sidecars** (bundle-56 round S): the app instances published ports 3200 to 3203 on every
 * interface while the sidecars and the database beside them were on loopback, so a CI runner or a developer's machine ran
 * four instances with known tokens and a known database password reachable from its network. The host-side suites reach
 * them by 127.0.0.1 (`testing/sync/helpers.js`, `testing/sync/setup.js`) and the containers reach each other by name on the
 * compose network, so nothing needs the other interfaces. The set is every service of the test compose that publishes a
 * port, read out of the file, with a floor.
 *
 * Run: node --test testing/standalone/the-test-stacks-document-sidecars-are-hardened-like-production.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompose, exposedPorts } from '../_shared/compose-file.mjs';

const PRODUCTION = loadCompose('docker-compose.yml');
const TEST = loadCompose('testing/docker-compose.test.yml');

/** The sidecars that parse untrusted documents. Named, because "which services parse untrusted input" is a judgement. */
const DOCUMENT_SIDECARS = ['doc-render', 'doc-office'];

/**
 * What a service carries that is NOT hardening. Anything outside this list that production declares is treated as
 * hardening and required of the test stack — a denylist fails the right way round when production gains a key.
 */
const PLUMBING = new Set([
  'build', 'image', 'container_name', 'restart', 'healthcheck', 'networks', 'profiles', 'ports', 'volumes',
  'environment', 'depends_on', 'deploy', 'labels', 'command', 'entrypoint',
  // Resource ceilings: held for every service, and by what they sum to, in the-test-stack-leaves-the-machine-room.
  'mem_limit', 'cpus',
]);

/** The floor on a sidecar's hardening keys: read_only, security_opt, cap_drop and a process ceiling at the least. */
const HARDENING_FLOOR = 4;

const hardeningKeys = (service) => Object.keys(service).filter((k) => !PLUMBING.has(k));

/** A list entry's identity for the comparison: a mount is its path, anything else is itself. */
const entryKey = (key, e) => (key === 'tmpfs' ? String(e).split(':')[0] : String(e));

/** Where the test service falls short of the production one, key by key. Empty when it does not. */
function hardeningShortfalls(name, production, test) {
  const v = [];
  for (const key of hardeningKeys(production)) {
    const want = production[key];
    const have = test[key];
    if (have === undefined || have === null) { v.push(`${name}: no \`${key}\` (production has ${JSON.stringify(want)})`); continue; }
    if (typeof want === 'boolean') {
      if (have !== want) v.push(`${name}: \`${key}\` is ${JSON.stringify(have)}, production has ${JSON.stringify(want)}`);
    } else if (Array.isArray(want)) {
      const got = new Set([].concat(have).map((e) => entryKey(key, e)));
      for (const e of want) {
        if (!got.has(entryKey(key, e))) v.push(`${name}: \`${key}\` lacks ${JSON.stringify(e)}, which production has`);
      }
    }
    // A scalar ceiling (pids_limit): present is the whole requirement; its size is the machine-room gate's question.
  }
  return v;
}

describe('the test stack\'s document sidecars, held to production', () => {
  for (const name of DOCUMENT_SIDECARS) {
    describe(name, () => {
      it('is in both compose files (a sidecar that is absent is not tested hardened)', () => {
        assert.ok(PRODUCTION.services?.[name], `docker-compose.yml has no ${name}: the hardening cannot be derived`);
        assert.ok(TEST.services?.[name], `testing/docker-compose.test.yml has no ${name}: the sidecar is not tested at all`);
      });

      it('production carries enough hardening for the derivation to mean something', () => {
        const keys = hardeningKeys(PRODUCTION.services[name]);
        assert.ok(keys.length >= HARDENING_FLOOR, `docker-compose.yml's ${name} has only ${keys}: the denylist is broken, or production lost its hardening`);
      });

      it('the test service carries every hardening key production does, at least as strictly', () => {
        const short = hardeningShortfalls(name, PRODUCTION.services[name], TEST.services?.[name] ?? {});
        assert.deepEqual(short, [], `the test stack parses the same untrusted documents with less protection:\n  ${short.join('\n  ')}`);
      });

      it('publishes at least one port, and every one is bound to 127.0.0.1', () => {
        const svc = TEST.services?.[name] ?? {};
        assert.ok((svc.ports ?? []).length >= 1, `${name} publishes no port: the host-side tests cannot reach it`);
        assert.deepEqual(exposedPorts(svc), [], `${name} listens on every interface of the machine that runs the suite`);
      });
    });
  }
});

describe('every port the test stack publishes is on loopback', () => {
  const publishing = Object.entries(TEST.services).filter(([, svc]) => (svc.ports ?? []).length > 0);

  it('the scan finds the services that publish a port (a floor: an empty scan holds nothing)', () => {
    assert.ok(publishing.length >= 6, `only ${publishing.length} service(s) publish a port: ${publishing.map(([n]) => n)}`);
    for (const name of ['ythril-a', 'ythril-b', 'ythril-c', 'ythril-d']) {
      assert.ok(publishing.some(([n]) => n === name), `${name} is not among the services that publish a port: the scan or the stack has changed`);
    }
  });

  for (const [name, svc] of publishing) {
    it(`${name}: every published port is bound to 127.0.0.1`, () => {
      assert.deepEqual(exposedPorts(svc), [], `${name} listens on every interface of the machine that runs the suite`);
    });
  }
});

describe('the comparison itself, against each way a sidecar can fall short', () => {
  const PROD = {
    read_only: true, tmpfs: ['/tmp:size=512m'], security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
    pids_limit: '${PIDS:-512}', image: 'x', ports: ['1:1'], mem_limit: '2g',
  };
  const ok = () => structuredClone({ ...PROD, tmpfs: ['/tmp:size=64m'] });

  it('production\'s own shape, with a smaller tmpfs and a different image, passes', () => {
    assert.deepEqual(hardeningShortfalls('s', PROD, { ...ok(), image: 'y', ports: [] }), []);
  });

  const BREAKS = [
    ['read_only is dropped', (s) => { delete s.read_only; }, /no `read_only`/],
    ['read_only is false', (s) => { s.read_only = false; }, /`read_only` is false/],
    ['capabilities are not all dropped', (s) => { s.cap_drop = ['NET_RAW']; }, /`cap_drop` lacks "ALL"/],
    ['cap_drop is dropped', (s) => { delete s.cap_drop; }, /no `cap_drop`/],
    ['no-new-privileges is missing', (s) => { s.security_opt = ['seccomp=unconfined']; }, /no-new-privileges/],
    ['the process ceiling is dropped', (s) => { delete s.pids_limit; }, /no `pids_limit`/],
    ['the tmpfs is dropped', (s) => { delete s.tmpfs; }, /no `tmpfs`/],
    ['the tmpfs mounts somewhere else', (s) => { s.tmpfs = ['/var/tmp']; }, /`tmpfs` lacks/],
  ];
  for (const [what, mutate, expected] of BREAKS) {
    it(`flags: ${what}`, () => {
      const s = ok();
      mutate(s);
      const found = hardeningShortfalls('s', PROD, s);
      assert.ok(found.some((m) => expected.test(m)), `wanted ${expected}, got ${JSON.stringify(found)}`);
    });
  }

  it('a hardening key production gains is required without editing this file', () => {
    const found = hardeningShortfalls('s', { ...PROD, user: '1000:1000' }, ok());
    assert.ok(found.some((m) => /no `user`/.test(m)), JSON.stringify(found));
  });

  it('the plumbing production carries is not required', () => {
    const lean = { read_only: true, tmpfs: ['/tmp'], security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], pids_limit: 64 };
    assert.deepEqual(hardeningShortfalls('s', PROD, lean), []);
  });

  it('loopback: only an explicit 127.0.0.1 passes', () => {
    for (const p of ['127.0.0.1:8100:8100', '127.0.0.1:8100:8100/tcp', '${SIDECAR_BIND:-127.0.0.1}:8100:8100', { host_ip: '127.0.0.1', published: 8100, target: 8100 }]) {
      assert.deepEqual(exposedPorts({ ports: [p] }), [], `${JSON.stringify(p)} was flagged`);
    }
    for (const p of ['8100:8100', '8100', '0.0.0.0:8100:8100', '${SIDECAR_BIND:-0.0.0.0}:8100:8100', { published: 8100, target: 8100 }, 8100, '192.168.1.5:8100:8100']) {
      assert.equal(exposedPorts({ ports: [p] }).length, 1, `${JSON.stringify(p)} was not flagged`);
    }
  });
});
