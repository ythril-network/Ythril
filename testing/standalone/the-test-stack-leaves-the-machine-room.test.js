/**
 * The test stack leaves the machine room to work: every service has a CPU and a memory ceiling, and every set of
 * services that one `docker compose up` starts together stays within about half of the Docker VM (`Q-57`).
 *
 * Owner, 2026-09-25: *"you have to cap resources on test-instances. again my whole programs (especially vscode) were
 * killed"*. Nine containers carried memory ceilings that summed to 25 GB — more than the 24 GB the Docker VM is given
 * on the development machine — and no CPU ceiling at all, so a sync run took 602% CPU and the host's editor was killed
 * for memory. A ceiling per service is not enough on its own: nine ceilings each "reasonable" can still add up to
 * the whole machine, so the SUM of what is started TOGETHER is the rule.
 *
 * ## Together, not "in the file" (b56)
 *
 * This gate first summed every service in the file. That counted the opt-in `office` profile's doc-office, which no
 * `docker compose up` starts alongside the full default stack, and the only way to make the sum fit was to cut the
 * document sidecars below what they need (a PDF renderer at 0.25 CPU / 256m, LibreOffice at 320m). A budget that is
 * met by making a service unable to work is not a budget. The sets are now what a command starts —
 * `testing/_shared/compose-start-sets.mjs`: the default set (no `profiles:` key), and each CI job's set, read from the
 * parsed `ci.yml` — and a second rule stops the same escape from the other side: a document sidecar's test default
 * is at least half of what production gives it.
 *
 * Derived from the files, never a list: a service added to the stack without ceilings, or a CI job that starts a
 * bigger set, fails here.
 *
 * Run: node --test testing/standalone/the-test-stack-leaves-the-machine-room.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { REPO_ROOT } from './_sources.mjs';
import { loadCi } from '../_shared/ci-workflow.mjs';
import { startSets, upCommands, defaultServices } from '../_shared/compose-start-sets.mjs';

const loadCompose = (rel) => yaml.load(readFileSync(join(REPO_ROOT, rel), 'utf8'));

/** The Docker VM on the development machine: `.wslconfig` gives it 16 processors and 24 GB. */
const VM_CPUS = 16;
const VM_GIB = 24;

/** A compose value, resolving `${VAR:-default}` to its default; null when absent. */
const ceiling = (svc, key) => {
  const raw = svc?.[key];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  const d = v.match(/^\$\{[A-Z0-9_]+:-([^}]+)\}$/);
  return d ? d[1] : v;
};
const gib = (s) => {
  const m = String(s).match(/^([\d.]+)\s*([gmk])b?$/i);
  assert.ok(m, `unreadable memory value: ${s}`);
  return Number(m[1]) / ({ g: 1, m: 1024, k: 1024 * 1024 })[m[2].toLowerCase()];
};

/** What a set of services adds up to by default. A service with no ceiling counts as the whole VM. */
function sumOf(compose, names) {
  let cpus = 0;
  let mem = 0;
  for (const n of names) {
    cpus += Number(ceiling(compose.services[n], 'cpus') ?? VM_CPUS);
    mem += gib(ceiling(compose.services[n], 'mem_limit') ?? `${VM_GIB}g`);
  }
  return { cpus, mem };
}
const CPU_BUDGET = VM_CPUS / 2 + 0.5;
const MEM_BUDGET = (VM_GIB * 2) / 3;
const overBudget = ({ cpus, mem }) => cpus > CPU_BUDGET || mem > MEM_BUDGET;

const TEST = loadCompose('testing/docker-compose.test.yml');
const PRODUCTION = loadCompose('docker-compose.yml');
const CI = loadCi();

describe('the test stack has ceilings', () => {
  const all = TEST.services;

  it('the file has the stack in it', () => {
    assert.ok(Object.keys(all).length >= 9, `found only ${Object.keys(all).join(', ')}`);
  });

  it('every service has a CPU ceiling and a memory ceiling', () => {
    const missing = Object.entries(all).filter(([, s]) => !ceiling(s, 'cpus') || !ceiling(s, 'mem_limit')).map(([n]) => n);
    assert.deepEqual(missing, [], 'these can take the whole machine');
  });

  it('each ceiling can be raised for a bigger runner without editing the file', () => {
    const raisable = (v) => /^\$\{[A-Z0-9_]+:-[^}]+\}$/.test(String(v).trim());
    const fixed = Object.entries(all).filter(([, s]) => !raisable(s.cpus) || !raisable(s.mem_limit)).map(([n]) => n);
    assert.deepEqual(fixed, [], 'these ceilings are hard-coded');
  });
});

describe('every set of services one `docker compose up` starts leaves the machine room', () => {
  const sets = startSets(TEST, CI);

  it('derives the default set and the CI jobs that start containers', () => {
    assert.equal(sets[0].label, 'the default set (`docker compose up`)');
    assert.deepEqual(sets[0].services, [...defaultServices(TEST)].sort(), 'the default set is every service with no profile');
    assert.ok(sets.length >= 1 + 4, `found only ${sets.map((s) => s.label).join(', ')}`);
    for (const s of sets) assert.ok(s.services.length > 0, `${s.label} starts nothing: the derivation lost its services`);
  });

  it('together, by default, each set leaves at least half the CPUs and a third of the memory to everything else', () => {
    for (const { label, services } of sets) {
      const { cpus, mem } = sumOf(TEST, services);
      assert.ok(cpus <= CPU_BUDGET, `${label} (${services.join(', ')}): the default CPU ceilings sum to ${cpus} of ${VM_CPUS}`);
      assert.ok(mem <= MEM_BUDGET, `${label} (${services.join(', ')}): the default memory ceilings sum to ${mem.toFixed(1)} GB of ${VM_GIB}`);
    }
  });

  it('a service gated by a profile is not in the default set, and is in the set of a job that asks for it', () => {
    const gated = Object.keys(TEST.services).filter((n) => (TEST.services[n].profiles ?? []).length > 0);
    assert.ok(gated.length >= 1, 'the test stack has no opt-in service: this rule has nothing to hold');
    for (const n of gated) assert.ok(!sets[0].services.includes(n), `${n} is gated by a profile and must not be in the default set`);
    const asked = sets.slice(1).filter((s) => gated.some((n) => s.services.includes(n)));
    assert.ok(asked.length >= 1, 'no CI job starts the opt-in service: it would be tested by nothing');
  });
});

describe('the derivation reads what a command starts', () => {
  const compose = {
    services: {
      app: { depends_on: { db: { condition: 'service_healthy' } } },
      db: {},
      side: { profiles: ['extra'] },
      other: {},
    },
  };
  const jobWith = (run, env) => ({ jobs: { j: { env, steps: [{ run }] } } });
  const setOf = (workflow) => startSets(compose, workflow).find((s) => s.label === 'CI job j')?.services;

  it('the default set leaves out a profile-gated service', () => {
    assert.deepEqual(startSets(compose, { jobs: {} })[0].services, ['app', 'db', 'other']);
  });
  it('a named service brings its depends_on closure and nothing else', () => {
    assert.deepEqual(setOf(jobWith('docker compose -p x -f f.yml up -d --wait --wait-timeout 300 --no-build --pull never app')), ['app', 'db']);
  });
  it('an option value is not a service name', () => {
    assert.deepEqual(upCommands('docker compose -p ythril-test -f t.yml --profile extra up -d --wait-timeout 300 --pull never app other'),
      [{ profiles: ['extra'], services: ['app', 'other'] }]);
  });
  it('--profile adds the profile\'s services to what is named', () => {
    assert.deepEqual(setOf(jobWith('docker compose --profile extra up -d app')), ['app', 'db', 'side']);
    assert.deepEqual(setOf(jobWith('docker compose --profile=extra up -d app')), ['app', 'db', 'side']);
  });
  it('COMPOSE_PROFILES switches a profile on the same way', () => {
    assert.deepEqual(setOf(jobWith('docker compose up -d app', { COMPOSE_PROFILES: 'extra' })), ['app', 'db', 'side']);
  });
  it('an up that names nothing starts the default set plus its profiles', () => {
    assert.deepEqual(setOf(jobWith('docker compose up -d --wait')), ['app', 'db', 'other']);
    assert.deepEqual(setOf(jobWith('docker compose --profile extra up -d --wait')), ['app', 'db', 'other', 'side']);
  });
  it('several up commands of one job share a runner, so their services add up', () => {
    assert.deepEqual(setOf(jobWith('docker compose up -d db\ndocker compose up -d other')), ['db', 'other']);
  });
  it('commands that start nothing are not read as starts', () => {
    assert.equal(setOf(jobWith('docker compose config --images | grep x\ndocker compose build app\ndocker compose down')), undefined);
  });
  it('a service it cannot read, or that does not exist, is a failure and not an empty set', () => {
    assert.throws(() => setOf(jobWith('docker compose up -d $SERVICES')), /cannot read/);
    assert.throws(() => setOf(jobWith('docker compose up -d nosuch')), /does not define/);
  });
  it('a bigger set is over budget: the check is not vacuous', () => {
    const big = { services: { a: { cpus: '9', mem_limit: '1g' } } };
    assert.ok(overBudget(sumOf(big, ['a'])), 'a service over the CPU budget is not caught');
    const fat = { services: { a: { cpus: '1', mem_limit: '17g' } } };
    assert.ok(overBudget(sumOf(fat, ['a'])), 'a service over the memory budget is not caught');
    const bare = { services: { a: {} } };
    assert.ok(overBudget(sumOf(bare, ['a'])), 'a service with no ceilings does not count as the whole machine');
  });
});

describe('a budget is not met by starving a service', () => {
  /** The compose services built from `sidecars/`: those production runs too, under its own ceilings. */
  const sidecars = Object.entries(TEST.services).filter(([, s]) => /sidecars\//.test(String(s.build ?? '')));

  it('finds the document sidecars in the test stack', () => {
    assert.ok(sidecars.length >= 2, `found only ${sidecars.map(([n]) => n).join(', ') || 'none'}`);
    for (const [n] of sidecars) assert.ok(PRODUCTION.services[n], `production has no ${n}: its working size cannot be derived`);
  });

  it('a sidecar\'s test default is at least half of what production gives it, in CPU and in memory', () => {
    for (const [n, svc] of sidecars) {
      const prod = PRODUCTION.services[n];
      const cpus = Number(ceiling(svc, 'cpus'));
      const mem = gib(ceiling(svc, 'mem_limit'));
      assert.ok(cpus >= Number(ceiling(prod, 'cpus')) / 2,
        `${n}: ${cpus} CPUs by default is under half of production's ${ceiling(prod, 'cpus')} — fit the budget with the start set, not by starving the service`);
      assert.ok(mem >= gib(ceiling(prod, 'mem_limit')) / 2,
        `${n}: ${mem} GB by default is under half of production's ${ceiling(prod, 'mem_limit')} — fit the budget with the start set, not by starving the service`);
    }
  });
});
