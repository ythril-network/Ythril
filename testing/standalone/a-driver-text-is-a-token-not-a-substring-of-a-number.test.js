/**
 * A scrape is numbers; a port is not "any five digits inside one".
 *
 * `GET /metrics` failed `a-store-failure-answers-alike-on-every-door-db` once, under load, as "answered with the driver's
 * text" — the check was the bare substring `27017`, and a scrape's values (heap bytes, a timestamp, a CPU float) contain
 * it by chance. Pure: the detector is held to both halves, so it cannot be loosened until it misses the real text.
 *
 * Also held here: no metric the registry builds from a failure carries the failure's words (the collector failure path
 * says its text in the log, never in a label or a value).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { driverTextIn } from './_driver-text.mjs';

describe('the driver-text detector', () => {
  const NUMBERS = [
    'nodejs_heap_size_total_bytes 27017216',
    'process_resident_memory_bytes 927017216',
    'process_start_time_seconds 1790.27017',
    'some_ratio 0.270172',
    'process_cpu_user_seconds_total 10.27017',
    'x_total 127017',
  ];
  for (const line of NUMBERS) {
    it(`does not read a number as the port: ${line}`, () => {
      assert.equal(driverTextIn(`# TYPE x gauge\n${line}\n`), null);
    });
  }

  const REAL = [
    'connection 5 to 172.16.0.9:27017 closed',
    'getaddrinfo ENOTFOUND mongo-a.internal',
    'metric{host="mongo-a.internal:27017"} 1',
    'Connection pool for 172.16.0.9:27017 was cleared',
    'MongoPoolClearedError',
    '172.16.0.9',
    'port=27017,',
    'http_x{error="27017"} 1',
  ];
  for (const text of REAL) {
    it(`still finds the driver's text: ${text}`, () => {
      assert.ok(driverTextIn(`# HELP a b\na 1\n${text}\n`), text);
    });
  }

  it('reports where, so a long body can be shown around the match', () => {
    const body = `${'a 1\n'.repeat(500)}host="172.16.0.9:27017"\n`;
    const hit = driverTextIn(body);
    assert.ok(hit && hit.index > 1000);
  });
});

describe('a failing collector says its words in the log, never in the scrape', () => {
  it('collectEachSpace with a read that throws the driver text leaves nothing in register.metrics()', async () => {
    const { register, collectEachSpace } = await import('../../server/dist/metrics/registry.js');
    const saved = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    console.log = console.warn = console.error = console.debug = () => {};
    try {
      await collectEachSpace('a_collector', async () => {
        throw new Error('connection 5 to 172.16.0.9:27017 closed (mongo-a.internal) Connection pool for x');
      }, [{ id: 'one' }, { id: 'two' }]);
    } finally { Object.assign(console, saved); }
    const body = await register.metrics();
    assert.equal(driverTextIn(body), null, 'the scrape carries the failure\'s words');
    assert.ok(body.length > 1000, 'the registry answered something to hold the check to');
  });
});
