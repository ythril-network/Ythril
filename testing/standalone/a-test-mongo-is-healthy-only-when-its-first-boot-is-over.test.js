/**
 * A test Mongo reports HEALTHY only when the image's own first boot is over: its compose healthcheck asks the image's
 * `runner healthcheck` as well as the replica-set state (b53 G35, found in the CI run of PR #1489).
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
 * ## What is read
 *
 * Every service of the test stack that runs the atlas-local image — derived from the compose file, so a fifth Mongo is held
 * the day it is added — and the one the harness connects to (the service that publishes the harness's port) is among them,
 * so the gate cannot pass by finding a set that leaves out the Mongo the database tests use.
 *
 * Run: node --test testing/standalone/a-test-mongo-is-healthy-only-when-its-first-boot-is-over.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCompose } from '../_shared/compose-file.mjs';
import { TEST_MONGO_PORT } from '../_shared/test-mongo-address.mjs';

const IMAGE = 'mongodb-atlas-local';
const IMAGE_OWN_CHECK = /\/usr\/local\/bin\/runner\s+healthcheck\b/;

const TEST = loadCompose('testing/docker-compose.test.yml');
const mongos = Object.entries(TEST.services).filter(([, s]) => String(s.image ?? '').includes(IMAGE));
/** The command a healthcheck runs, whatever shape compose was given it in (a list, or one shell string). */
const commandOf = (service) => {
  const t = service.healthcheck?.test;
  return Array.isArray(t) ? t.join(' ') : String(t ?? '');
};

describe('a test Mongo is healthy only when its first boot is over', () => {
  it('the test stack has Mongos, and the one the harness connects to is among them', () => {
    assert.ok(mongos.length >= 1, 'no service of the test stack runs the atlas-local image: the gate would hold nothing');
    const harness = mongos.filter(([, s]) => (s.ports ?? []).some(p => String(p).includes(`:${TEST_MONGO_PORT}:`)));
    assert.equal(harness.length, 1, `${harness.length} service(s) of the atlas-local image publish port ${TEST_MONGO_PORT}`);
  });

  for (const [name, service] of mongos) {
    it(`${name}: its healthcheck asks the image's own \`runner healthcheck\``, () => {
      const command = commandOf(service);
      assert.ok(command !== '', `${name} has no healthcheck: \`up --wait\` returns before it is ready at all`);
      assert.match(command, IMAGE_OWN_CHECK,
        `${name}'s healthcheck is \`${command}\`: it passes in the image's second boot phase, before the final mongod restart that closes every open connection`);
    });

    it(`${name}: it still asks for a primary`, () => {
      assert.match(commandOf(service), /replSetGetStatus[^]*myState\s*===\s*1/, `${name}'s healthcheck no longer asks that the node is primary`);
    });
  }
});
