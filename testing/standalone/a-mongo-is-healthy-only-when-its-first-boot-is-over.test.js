/**
 * A Mongo reports HEALTHY only when the image's own first boot is over: its compose healthcheck asks the image's
 * `runner healthcheck` FIRST, and the replica-set state behind it (b53 G35, found in the CI run of PR #1489; widened from
 * the test stack to every compose file by `Q-385`, bundle-64).
 *
 * ## The failure this guards
 *
 * `Standalone (database)` failed once, in `a-bounded-bulk-write-is-one-command-db`, with `connection 2 to 127.0.0.1:27117
 * closed` — after a case that had passed in every earlier run and passes locally. Nothing in the client was at fault: the
 * job's own container log showed the harness Mongo's `mongod` STOPPED and started again between the case's first command and
 * its last. `mongodb/mongodb-atlas-local` runs its first boot in three phases (a bare `mongod` to initialise the replica set,
 * a second one with `mongot` started beside it, then a final restart once `mongot` is healthy), and the compose healthcheck
 * — `replSetGetStatus.myState === 1` — passes in the SECOND phase: `up --wait` returned "Healthy" at 10:09:18.9, the tests
 * began a fraction of a second later, and the final restart came at 10:09:25 and closed the connection of the command in
 * flight. The job began this way when the database-backed files got a job of their own (bundle-56): before it they ran after
 * a stack whose apps had been retrying their first connection for as long as that took, and
 * `mongo-connect-retry.test.js` records the same cause from the app's side (`read ECONNRESET` on the first connection of a
 * "healthy" stack).
 *
 * Measured on this image with a client pinging every 250 ms from `docker run`, one CPU and 3 GiB (as the compose file gives
 * it): the compose probe passed at 3.9 s, the final restart took the server away from 7 s to 18 s, `runner healthcheck`
 * stayed failing for the whole of the second phase and passed at 17.3 s, after the restart, and the client never lost its
 * connection again. So the one thing that tells the two phases apart is the image's own check, and a healthcheck that
 * leaves it out reports healthy about a server that is about to be restarted.
 *
 * ## Why every compose file, and not the test stack's
 *
 * This gate was titled for "a test Mongo" and read one file, so the production `docker-compose.yml` — the same image, the
 * same three phases, and the instance an operator's app connects to first — kept the probe the test stack had dropped
 * (`Q-385`). The set is now DERIVED: every tracked compose file (`trackedSources`, floor two) and every service in it that
 * runs the atlas-local image (floor three), so a compose file or a Mongo added next year is held the day it is added.
 *
 * ## Why "begins with", and not "contains"
 *
 * The production probe has two branches (with and without root credentials). A `runner healthcheck` written into ONE of
 * them contains the phrase and still reports healthy in the second boot phase on the other branch. So the rule is on the
 * command the healthcheck RUNS: it begins with `/usr/local/bin/runner healthcheck &&`, which covers every branch behind it.
 * That command is read per form compose accepts — `["CMD-SHELL", s]`, `["CMD", "sh", "-c", s]` and a bare string — by
 * `healthcheckCommand` in `compose-file.mjs`, the one place the forms are known, and the truth table below holds the
 * reading and the rule on each form, including one that reorders the string inside the array form only.
 *
 * ## What else is read
 *
 * Every atlas-local service names ONE image reference, so the image whose phases were measured is the image every probe
 * runs against. And the service the harness connects to (the one publishing the harness's port) is among the test stack's
 * Mongos — a question about the TEST compose only, because no other file publishes the harness's port.
 *
 * Run: node --test testing/standalone/a-mongo-is-healthy-only-when-its-first-boot-is-over.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import * as composeFile from '../_shared/compose-file.mjs';
import { trackedSources } from './_sources.mjs';
import { TEST_MONGO_PORT } from '../_shared/test-mongo-address.mjs';

const IMAGE = 'mongodb-atlas-local';
const IMAGE_OWN_CHECK = /\/usr\/local\/bin\/runner\s+healthcheck\b/;
const ASKS_A_PRIMARY = /replSetGetStatus[^]*myState\s*===\s*1/;
const TEST_COMPOSE = 'testing/docker-compose.test.yml';

/** The rule, on the command a healthcheck runs: the image's own check first, so every branch behind it waits for it. */
const beginsWithImageCheck = (command) => /^\/usr\/local\/bin\/runner\s+healthcheck\s*&&/.test(String(command).trim());

/**
 * The command a healthcheck runs, read by the one module that knows compose's forms. A namespace import, so that while the
 * export does not exist the rows that need it fail by name and every other row of this file still runs.
 */
const healthcheckCommand = (service) => {
  assert.equal(typeof composeFile.healthcheckCommand, 'function',
    'compose-file.mjs exports no healthcheckCommand(service): the command a healthcheck runs is read nowhere, per form');
  return composeFile.healthcheckCommand(service);
};

/** Everything a healthcheck says, joined: what the "contains" rows read, form-blind on purpose. */
const allOf = (service) => {
  const t = service.healthcheck?.test;
  return Array.isArray(t) ? t.join(' ') : String(t ?? '');
};

const COMPOSE_FILES = trackedSources('.', { ext: ['.yml', '.yaml'], floor: 2 })
  .filter((p) => /compose/i.test(basename(p)));
const MONGOS = COMPOSE_FILES.flatMap((file) =>
  Object.entries(composeFile.loadCompose(file).services)
    .filter(([, s]) => String(s?.image ?? '').includes(IMAGE))
    .map(([name, service]) => ({ file, name, service })));

describe('a Mongo is healthy only when its first boot is over', () => {
  it('the set is derived: at least two compose files, the production one among them', () => {
    assert.ok(COMPOSE_FILES.length >= 2, `only ${COMPOSE_FILES.length} tracked compose file(s): ${COMPOSE_FILES.join(', ')}`);
    assert.ok(COMPOSE_FILES.includes('docker-compose.yml'), `the production compose is not among ${COMPOSE_FILES.join(', ')}`);
    assert.ok(COMPOSE_FILES.includes(TEST_COMPOSE), `the test compose is not among ${COMPOSE_FILES.join(', ')}`);
  });

  it('at least three services run the atlas-local image, in more than one file', () => {
    assert.ok(MONGOS.length >= 3, `${MONGOS.length} atlas-local service(s) found: the gate would hold almost nothing`);
    assert.ok(new Set(MONGOS.map((m) => m.file)).size >= 2, `every atlas-local service is in one file: ${MONGOS.map((m) => `${m.file}:${m.name}`).join(', ')}`);
  });

  it('every atlas-local service names one image reference', () => {
    const refs = new Set(MONGOS.map((m) => String(m.service.image)));
    assert.equal(refs.size, 1, `the atlas-local services name ${refs.size} images: ${[...refs].join(' | ')}`);
  });

  it('the test stack\'s Mongo the harness connects to is among them', () => {
    const harness = MONGOS.filter((m) => m.file === TEST_COMPOSE)
      .filter((m) => (m.service.ports ?? []).some((p) => String(p).includes(`:${TEST_MONGO_PORT}:`)));
    assert.equal(harness.length, 1, `${harness.length} service(s) of the atlas-local image publish port ${TEST_MONGO_PORT}`);
  });

  for (const { file, name, service } of MONGOS) {
    const who = `${file}: ${name}`;

    it(`${who}: its healthcheck asks the image's own \`runner healthcheck\``, () => {
      const command = allOf(service);
      assert.ok(command !== '', `${who} has no healthcheck: \`up --wait\` returns before it is ready at all`);
      assert.match(command, IMAGE_OWN_CHECK,
        `${who}'s healthcheck is \`${command}\`: it passes in the image's second boot phase, before the final mongod restart that closes every open connection`);
    });

    it(`${who}: the command it runs BEGINS with \`runner healthcheck &&\`, so every branch waits for it`, () => {
      const command = healthcheckCommand(service);
      assert.ok(beginsWithImageCheck(command),
        `${who} runs \`${command}\`: a branch that does not pass through the image's own check reports healthy before the final restart`);
    });

    it(`${who}: it still asks for a primary`, () => {
      assert.match(allOf(service), ASKS_A_PRIMARY, `${who}'s healthcheck no longer asks that the node is primary`);
    });
  }
});

describe('the command a healthcheck runs, read per form, and the rule on it', () => {
  const PRIMARY = `mongosh --quiet --eval 'db.adminCommand({replSetGetStatus:1}).myState===1 ? 1 : quit(1)'`;
  const GOOD = `/usr/local/bin/runner healthcheck && ${PRIMARY}`;
  const REORDERED = `${PRIMARY} && /usr/local/bin/runner healthcheck`;
  const ONE_BRANCH = `if [ -n "$$U" ]; then /usr/local/bin/runner healthcheck && ${PRIMARY}; else ${PRIMARY}; fi`;
  const NO_RUNNER = `if [ -n "$$U" ]; then ${PRIMARY}; else ${PRIMARY}; fi`;

  const reads = [
    { form: '["CMD-SHELL", s]', test: ['CMD-SHELL', GOOD], command: GOOD, holds: true },
    { form: '["CMD", "sh", "-c", s]', test: ['CMD', 'sh', '-c', GOOD], command: GOOD, holds: true },
    { form: 'a bare string', test: GOOD, command: GOOD, holds: true },
    { form: '["CMD", "sh", "-c", s] with s REORDERED (the seen-red row)', test: ['CMD', 'sh', '-c', REORDERED], command: REORDERED, holds: false },
    { form: '["CMD-SHELL", s] with the check in ONE branch', test: ['CMD-SHELL', ONE_BRANCH], command: ONE_BRANCH, holds: false },
    { form: '["CMD", "sh", "-c", s] as production had it, no image check', test: ['CMD', 'sh', '-c', NO_RUNNER], command: NO_RUNNER, holds: false },
  ];
  for (const row of reads) {
    it(`${row.form}: reads the command, and the rule ${row.holds ? 'holds' : 'is violated'}`, () => {
      const command = healthcheckCommand({ healthcheck: { test: row.test } });
      assert.equal(command, row.command, `${row.form} read as \`${command}\``);
      assert.equal(beginsWithImageCheck(command), row.holds, `the rule on \`${command}\``);
    });
  }

  const refusals = [
    { form: 'an exec form with no shell, ["CMD", "mongosh", ...]', service: { healthcheck: { test: ['CMD', 'mongosh', '--eval', 'x'] } } },
    { form: '["NONE"]', service: { healthcheck: { test: ['NONE'] } } },
    { form: 'no healthcheck at all', service: {} },
  ];
  for (const row of refusals) {
    it(`${row.form}: refused, never read as an empty command`, () => {
      assert.equal(typeof composeFile.healthcheckCommand, 'function',
        'compose-file.mjs exports no healthcheckCommand(service): the command a healthcheck runs is read nowhere, per form');
      assert.throws(() => composeFile.healthcheckCommand(row.service), `${row.form} was read as a command instead of refused`);
    });
  }
});
