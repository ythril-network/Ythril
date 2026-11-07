/**
 * The shipped database container sizes mongot's heap from a setting an operator can see, keeps mongot's log on a volume that survives the
 * container (Q-373, bundle-72), and gives the runner no log file, which would hold the database password (Q-695).
 *
 * ## The finding
 *
 * `docker-compose.yml`'s `ythril-mongo` runs the atlas-local image, which runs mongot (the vector-search process) inside the same memory
 * limit as mongod. Shipped, it sets neither mongot's heap nor a log file: mongot's heap is a quarter of the container limit by the JVM's
 * default (1 GiB at the 4 GiB default, measured by the b72 premise probe P1), an operator cannot see or set it, and when mongot dies of
 * `java.lang.OutOfMemoryError` the runner stops mongod and the container exits 0 with `docker logs` holding only "Received signal 15" -
 * the cause was in a log file nobody asked for (probe M2). The test stack's compose file has had both settings since Q-564
 * (`the-search-process-has-room-for-every-suite.test.js` reads THAT file only); nothing read the shipped one.
 *
 * ## The rules (DESIGN v3, items 10 and 12)
 *
 *  1. `JAVA_TOOL_OPTIONS` sets `-XX:MaxRAMPercentage` from `YTHRIL_MONGOT_HEAP_PERCENT`, default 25: today's heap made explicit, and still a
 *     share of the container limit, so an operator who raises `YTHRIL_MONGO_MEM_LIMIT` is not left with a fixed small heap.
 *  2. `MONGOT_LOG_FILE` is under `/var/log/mongodb`: the one directory the image owns for its own user. A named volume at a path the image
 *     does not own is root-owned, and the runner crash-loops on `permission denied` (probe P4).
 *  2b. `RUNNER_LOG_FILE` is NOT set (Q-695): the atlas-local runner writes its connection string, root user and password included, to that
 *     file twice per start, and on this volume it outlives the container, is world-readable and never rotates. Without the setting the
 *     runner's output is discarded, as before 6.4; the cause of a mongot death is in mongot.log.
 *  3. A named volume `ythril-mongo-logs` is mounted at `/var/log/mongodb`, declared in the top-level `volumes`, and listed in
 *     `x-ythril: disposable-volumes`: a Docker wipe (`scripts/owner-instance.ps1`) refuses a volume that is not named there.
 *  4. The logging driver stays `"none"`: json-file would put command bodies from mongod's slow-operation lines into host files outside
 *     Ythril's retention (the vet's Sec1).
 *
 * ## Planted failures
 *
 * The rules are one function over a parsed compose file. The last cases write copies of the SHIPPED file with one rule broken each, through
 * the same reader, and require the function to name that rule - so a rule that reads nothing (an empty `environment`, a renamed service)
 * is seen failing, not assumed to hold.
 *
 * Run: node --test testing/standalone/the-shipped-mongo-sizes-mongot-and-keeps-its-logs-on-a-volume.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCompose, environmentOf } from '../_shared/compose-file.mjs';
import { REPO_ROOT } from './_sources.mjs';

const SERVICE = 'ythril-mongo';
const VOLUME = 'ythril-mongo-logs';
const LOG_DIR = '/var/log/mongodb';

/** The rule each violation names, so a planted failure can be matched to the rule it breaks. */
const RULES = {
  heap: 'JAVA_TOOL_OPTIONS sets -XX:MaxRAMPercentage from YTHRIL_MONGOT_HEAP_PERCENT, default 25',
  logFiles: `MONGOT_LOG_FILE is a file under ${LOG_DIR}`,
  noRunnerLog: 'RUNNER_LOG_FILE is not set: the runner writes the database password into it',
  mounted: `a named volume ${VOLUME} is mounted at ${LOG_DIR} and declared under volumes`,
  disposable: `${VOLUME} is listed in x-ythril disposable-volumes`,
  logging: 'the logging driver is "none"',
};

/** The rules broken by this compose file, as `{ rule, why }`; empty when it holds them all. */
function violations(compose) {
  const out = [];
  const bad = (rule, why) => out.push({ rule, why });
  const svc = compose.services?.[SERVICE];
  if (!svc) return [{ rule: 'service', why: `no service named ${SERVICE}` }];
  const env = environmentOf(svc);

  const opts = String(env['JAVA_TOOL_OPTIONS'] ?? '');
  if (!/-XX:MaxRAMPercentage=\$\{YTHRIL_MONGOT_HEAP_PERCENT:-25\}/.test(opts)) {
    bad('heap', `JAVA_TOOL_OPTIONS is ${JSON.stringify(opts)}`);
  }

  const mongotLog = String(env['MONGOT_LOG_FILE'] ?? '');
  if (!mongotLog.startsWith(`${LOG_DIR}/`) || mongotLog.endsWith('/')) bad('logFiles', `MONGOT_LOG_FILE is ${JSON.stringify(mongotLog)}`);
  if ('RUNNER_LOG_FILE' in env) bad('noRunnerLog', `RUNNER_LOG_FILE is ${JSON.stringify(env['RUNNER_LOG_FILE'])}`);

  const mount = (svc.volumes ?? []).map(String).find(v => v.split(':')[0] === VOLUME);
  if (!mount || mount.split(':')[1] !== LOG_DIR || !(VOLUME in (compose.volumes ?? {}))) {
    bad('mounted', `the service's volumes are ${JSON.stringify(svc.volumes ?? [])}, the declared volumes ${JSON.stringify(Object.keys(compose.volumes ?? {}))}`);
  }

  if (!(compose['x-ythril']?.['disposable-volumes'] ?? []).includes(VOLUME)) {
    bad('disposable', `disposable-volumes is ${JSON.stringify(compose['x-ythril']?.['disposable-volumes'] ?? null)}`);
  }

  if (svc.logging?.driver !== 'none') bad('logging', `logging is ${JSON.stringify(svc.logging ?? null)}`);
  return out;
}

const describeAll = (found) => found.map(v => `${RULES[v.rule] ?? v.rule}: ${v.why}`).join('\n');

describe('the shipped ythril-mongo sizes mongot and keeps its logs on a volume', () => {
  const shipped = loadCompose('docker-compose.yml');

  it('finds the database service the rules are about', () => {
    assert.ok(shipped.services[SERVICE], `docker-compose.yml has no ${SERVICE}`);
    assert.match(String(shipped.services[SERVICE].image), /mongodb-atlas-local/, `${SERVICE} is not the atlas-local image any more: these rules are about mongot inside it`);
  });

  it(RULES.heap, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'heap'), [],
      'mongot\'s heap is the JVM default (a quarter of the container limit) and nothing an operator can read or set');
  });

  it(RULES.logFiles, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'logFiles'), [],
      'a mongot death is invisible: its log goes to /dev/null, and `docker logs` holds only the runner\'s SIGTERM to mongod');
  });

  it(RULES.noRunnerLog, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'noRunnerLog'), [],
      'the runner writes mongodb://<user>:<password>@localhost into its log file, which this volume keeps world-readable past the container');
  });

  it(RULES.mounted, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'mounted'), [],
      `the logs are written inside the container's own layer, which a recreate throws away - with the cause of the stop`);
  });

  it(RULES.disposable, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'disposable'), [],
      'a Docker wipe refuses a named volume that is not listed as disposable');
  });

  it(RULES.logging, () => {
    assert.deepEqual(violations(shipped).filter(v => v.rule === 'logging'), [],
      'json-file would put mongod\'s slow-operation command bodies into host files outside Ythril\'s retention');
  });

  describe('a planted copy of the shipped file is refused, one rule at a time', () => {
    let tmp;
    let text;
    before(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-compose-plant-'));
      // LF and no byte-order mark, whatever the checkout's line-ending setting: the edits below match on lines.
      text = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    });
    after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

    /**
     * The shipped text with `edit` applied, written to its own folder and read back through the same reader as the real one. Only the
     * conforming base may equal the shipped text (`mayEqual`): once the shipped file holds every rule, the base IS the shipped file.
     */
    const plant = (name, edit, { mayEqual = false } = {}) => {
      const planted = edit(text);
      if (!mayEqual) assert.notEqual(planted, text, `fixture check: the edit for ${name} changed nothing, so it would plant no failure`);
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'docker-compose.yml'), planted);
      return loadCompose('docker-compose.yml', dir);
    };

    /**
     * A fully conforming copy: the rules held, so a planted failure below is the plant and not a broken reader. Each line is added only
     * where the text lacks it, so the copy is the same whether the shipped file already holds the rules or not (a second declaration of
     * the volume would be a duplicate key, which the reader refuses).
     */
    const conforming = () => [
      [`JAVA_TOOL_OPTIONS: -XX:MaxRAMPercentage=\${YTHRIL_MONGOT_HEAP_PERCENT:-25}\n      MONGOT_LOG_FILE: ${LOG_DIR}/mongot.log\n`,
        t => t.replace(/(\n    environment:\n)(      # SECURITY: authenticate the bundled database)/,
          `$1      JAVA_TOOL_OPTIONS: -XX:MaxRAMPercentage=\${YTHRIL_MONGOT_HEAP_PERCENT:-25}\n`
          + `      MONGOT_LOG_FILE: ${LOG_DIR}/mongot.log\n$2`)],
      [`      - ${VOLUME}:${LOG_DIR}\n`,
        t => t.replace('      - ythril-mongo-configdb:/data/configdb\n', `      - ythril-mongo-configdb:/data/configdb\n      - ${VOLUME}:${LOG_DIR}\n`)],
      [`  ythril-mongo-configdb:\n  ${VOLUME}:\n`, t => t.replace('  ythril-mongo-configdb:\n', `  ythril-mongo-configdb:\n  ${VOLUME}:\n`)],
      [`    - ythril-whisper-cache\n    - ${VOLUME}\n`, t => t.replace('    - ythril-whisper-cache\n', `    - ythril-whisper-cache\n    - ${VOLUME}\n`)],
    ].reduce((t, [holds, add]) => (t.includes(holds) ? t : add(t)), text)
      // A runner log file is the one thing the rules forbid, so the conforming base never carries it, whatever the shipped file says.
      .replace(/ *RUNNER_LOG_FILE: [^\n]*\n/g, '');

    it('the conforming copy used as the base of the plants passes every rule', () => {
      const found = violations(plant('conforming', () => conforming(), { mayEqual: true }));
      assert.deepEqual(found, [], `the planted-failure fixture is itself wrong, so no plant below proves anything:\n${describeAll(found)}`);
    });

    const plants = {
      heap: ['heap', 'a fixed -Xmx instead of the percentage', t => conforming().replace(/-XX:MaxRAMPercentage=\$\{YTHRIL_MONGOT_HEAP_PERCENT:-25\}/, '-Xmx1g')],
      'heap-default': ['heap', 'a default other than 25', t => conforming().replace('YTHRIL_MONGOT_HEAP_PERCENT:-25', 'YTHRIL_MONGOT_HEAP_PERCENT:-50')],
      logFiles: ['logFiles', 'a log file outside /var/log/mongodb', t => conforming().replace(`MONGOT_LOG_FILE: ${LOG_DIR}/mongot.log`, 'MONGOT_LOG_FILE: /tmp/mongot.log')],
      'runner-log': ['noRunnerLog', 'a runner log file, which would hold the database password', t => conforming().replace(`      MONGOT_LOG_FILE: ${LOG_DIR}/mongot.log\n`, `      MONGOT_LOG_FILE: ${LOG_DIR}/mongot.log\n      RUNNER_LOG_FILE: ${LOG_DIR}/runner.log\n`)],
      mounted: ['mounted', 'the volume mounted at a path the image does not own', t => conforming().replace(`- ${VOLUME}:${LOG_DIR}`, `- ${VOLUME}:/var/log/ythril-mongo`)],
      undeclared: ['mounted', 'the volume not declared under volumes', t => conforming().replace(`  ythril-mongo-configdb:\n  ${VOLUME}:\n`, '  ythril-mongo-configdb:\n')],
      disposable: ['disposable', 'the volume missing from disposable-volumes', t => conforming().replace(`    - ythril-whisper-cache\n    - ${VOLUME}\n`, '    - ythril-whisper-cache\n')],
      logging: ['logging', 'a json-file logging driver', t => conforming().replace('driver: "none"', 'driver: "json-file"')],
    };
    for (const [name, [want, what, edit]] of Object.entries(plants)) {
      it(`refuses ${what}`, () => {
        const found = violations(plant(name, edit));
        assert.ok(found.some(v => v.rule === want), `the rule "${RULES[want]}" did not name this planted copy; it named: ${describeAll(found) || 'nothing'}`);
      });
    }
  });
});
