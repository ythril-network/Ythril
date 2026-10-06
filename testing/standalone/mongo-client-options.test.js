/**
 * The MongoClient's liveness options live in ONE module, and a connection string that names one of them wins
 * (bundle-53, Q-329).
 *
 * ## Why
 *
 * The client was built as `new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })`: a store that accepts the
 * connection and then stops answering ended an in-flight operation only after the driver's own defaults (30 s connect, 10 s
 * heartbeat, plus the selection wait), and the figure was written in one place that nobody reading `MONGO_URI` would look
 * at. And the driver gives an options OBJECT precedence over the same option in the URI (`connection_string.js`), so a
 * spread of defaults silently overrides an operator who named `connectTimeoutMS` in the string. `db/client-options.ts` is
 * the one place the three figures live, and it leaves out a default for every key the URI names.
 *
 * ## The rules this file holds
 *
 * - the three defaults are the numbers stated HERE (a changed default is a decision, so it fails until the test says so),
 *   and the exported constants equal them;
 * - a key the URI names, in any case, in any form of connection string, is absent from the options; a key it does not name
 *   carries the default; a caller's own defaults replace the module's, and the URI still wins over those;
 * - `inFlightBoundMs` is computed from the EFFECTIVE values: 25 000 ms with the defaults, `connect + heartbeat + selection`;
 *   0 means unbounded; a `loadBalanced=true` URI has no monitor, so only selection counts;
 * - no credential in the connection string appears in anything the module returns as text, throws or logs, whatever the
 *   option values are (SEC-2); the option names are read into a lower-cased set and never assigned onto an object from the
 *   string.
 *
 * Run: node --test testing/standalone/mongo-client-options.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logLinesDuring } from './_log-lines.mjs';
import {
  CLIENT_LIVENESS_DEFAULTS,
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_FREQUENCY_MS,
  SERVER_SELECTION_TIMEOUT_MS,
  describeClientOptions,
  effectiveClientOptions,
  inFlightBoundMs,
  mongoClientOptions,
  uriQueryOptions,
} from '../../server/dist/db/client-options.js';

const KEYS = ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'heartbeatFrequencyMS'];
const PLAIN = 'mongodb://ythril-mongo:27017/ythril?directConnection=true';

describe('the defaults', () => {
  it('are the numbers the docs state, and the exported constants equal them', () => {
    assert.equal(CONNECT_TIMEOUT_MS, 10_000);
    assert.equal(HEARTBEAT_FREQUENCY_MS, 5_000);
    assert.equal(SERVER_SELECTION_TIMEOUT_MS, 10_000);
    assert.deepEqual(CLIENT_LIVENESS_DEFAULTS, {
      serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, heartbeatFrequencyMS: 5_000,
    });
  });

  it('a URI that names none of them gets all three', () => {
    assert.deepEqual(mongoClientOptions(PLAIN), CLIENT_LIVENESS_DEFAULTS);
    assert.deepEqual(mongoClientOptions('mongodb://h:27017/db'), CLIENT_LIVENESS_DEFAULTS);
  });

  it('the options are a fresh object each call, so one caller cannot move the figures for the next', () => {
    const a = mongoClientOptions(PLAIN);
    a.connectTimeoutMS = 1;
    assert.equal(mongoClientOptions(PLAIN).connectTimeoutMS, 10_000);
    assert.equal(CLIENT_LIVENESS_DEFAULTS.connectTimeoutMS, 10_000);
  });
});

describe('a URI that names an option wins', () => {
  for (const key of KEYS) {
    it(`${key} named in the URI is absent from the options, the other two keep their defaults`, () => {
      const opts = mongoClientOptions(`mongodb://h:27017/db?${key}=1234`);
      assert.equal(key in opts, false, `${key} was handed to the driver beside the URI that names it`);
      for (const other of KEYS.filter(k => k !== key)) assert.equal(opts[other], CLIENT_LIVENESS_DEFAULTS[other]);
    });
  }

  it('names are matched in any case, as the driver matches them', () => {
    for (const spelled of ['connecttimeoutms', 'CONNECTTIMEOUTMS', 'ConnectTimeoutMS', 'cOnNeCtTiMeOuTmS']) {
      const opts = mongoClientOptions(`mongodb://h:27017/db?${spelled}=500`);
      assert.equal('connectTimeoutMS' in opts, false, `${spelled} was not read as connectTimeoutMS`);
    }
  });

  it('all three named at once leaves nothing to hand the driver', () => {
    const opts = mongoClientOptions('mongodb://h/db?serverSelectionTimeoutMS=1&connectTimeoutMS=2&heartbeatFrequencyMS=3');
    assert.deepEqual(opts, {});
  });

  it('a name that only CONTAINS a liveness name is not that name', () => {
    const opts = mongoClientOptions('mongodb://h/db?xconnectTimeoutMS=1&connectTimeoutMSx=2&socketTimeoutMS=3&timeoutMS=4');
    assert.deepEqual(opts, CLIENT_LIVENESS_DEFAULTS);
  });

  it('a value in the string, however odd, still means the option is named (the driver rules on the value)', () => {
    for (const value of ['', 'abc', '-1', '1e3']) {
      const opts = mongoClientOptions(`mongodb://h/db?connectTimeoutMS=${value}`);
      assert.equal('connectTimeoutMS' in opts, false, `connectTimeoutMS=${JSON.stringify(value)} did not count as named`);
    }
  });

  it('a multi-host replica-set string is read the same way', () => {
    const uri = 'mongodb://u:p@a.example:27017,b.example:27018,c.example:27019/db?replicaSet=rs0&heartbeatFrequencyMS=900&w=majority';
    const opts = mongoClientOptions(uri);
    assert.equal('heartbeatFrequencyMS' in opts, false);
    assert.equal(opts.connectTimeoutMS, 10_000);
    assert.equal(opts.serverSelectionTimeoutMS, 10_000);
  });

  it('a mongodb+srv string is read the same way (no URL parser: it does not parse the multi-host or srv forms)', () => {
    const opts = mongoClientOptions('mongodb+srv://u:p@cluster0.example.net/db?retryWrites=true&serverSelectionTimeoutMS=2500');
    assert.equal('serverSelectionTimeoutMS' in opts, false);
    assert.equal(opts.connectTimeoutMS, 10_000);
  });

  it('percent-encoded option names are decoded, as the driver decodes them', () => {
    const opts = mongoClientOptions('mongodb://h/db?connect%54imeoutMS=700');
    assert.equal('connectTimeoutMS' in opts, false);
  });

  it('an option that appears twice is read at its last value', () => {
    const q = uriQueryOptions('mongodb://h/db?connectTimeoutMS=1&connectTimeoutMS=2');
    assert.equal(q.get('connecttimeoutms'), '2');
  });

  it('a string with no options, an empty query and stray separators name nothing', () => {
    for (const uri of ['mongodb://h/db', 'mongodb://h/db?', 'mongodb://h/db?&&', 'mongodb://h/db?=&connectTimeoutMS', '']) {
      assert.deepEqual(mongoClientOptions(uri), CLIENT_LIVENESS_DEFAULTS, `${JSON.stringify(uri)} named something`);
    }
  });
});

describe('uriQueryOptions', () => {
  it('maps lower-cased name to the raw value, over every option of the string', () => {
    const q = uriQueryOptions('mongodb://u:p@h1:1,h2:2/db?replicaSet=rs0&SocketTimeoutMS=5000&tls=true');
    assert.deepEqual([...q.entries()], [['replicaset', 'rs0'], ['sockettimeoutms', '5000'], ['tls', 'true']]);
  });

  it('is empty for a string with no query', () => {
    assert.equal(uriQueryOptions('mongodb://h:27017/db').size, 0);
    assert.equal(uriQueryOptions('').size, 0);
  });

  it('keeps an `=` that belongs to the value', () => {
    assert.equal(uriQueryOptions('mongodb://h/db?authMechanismProperties=SERVICE_NAME:a=b').get('authmechanismproperties'), 'SERVICE_NAME:a=b');
  });

  it('a name that would be a prototype key is just a name', () => {
    const q = uriQueryOptions('mongodb://h/db?__proto__=1&constructor=2');
    assert.equal(q.get('__proto__'), '1');
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });
});

describe('a caller\'s own defaults', () => {
  it('replace the module\'s for the keys they carry, and the URI still wins over them', () => {
    const callerDefaults = { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 };
    assert.deepEqual(mongoClientOptions(PLAIN, callerDefaults), {
      serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, heartbeatFrequencyMS: 5_000,
    });
    assert.deepEqual(mongoClientOptions('mongodb://h/db?connectTimeoutMS=9', callerDefaults), {
      serverSelectionTimeoutMS: 5_000, heartbeatFrequencyMS: 5_000,
    });
  });

  it('are refused when they are not a non-negative finite number, in words that name the key and carry no URI', () => {
    const secret = 'sUp3rS3cretPw';
    for (const bad of [-1, NaN, Infinity, '5000', null, {}]) {
      assert.throws(
        () => mongoClientOptions(`mongodb://u:${secret}@h/db`, { connectTimeoutMS: bad }),
        err => /connectTimeoutMS/.test(err.message) && !err.message.includes(secret),
        `${String(bad)} was accepted`,
      );
    }
  });

  it('an unknown key is refused rather than ignored', () => {
    assert.throws(() => mongoClientOptions(PLAIN, { socketTimeoutMS: 1 }), /socketTimeoutMS/);
  });
});

describe('effectiveClientOptions', () => {
  it('with a silent URI: the defaults, none from the URI', () => {
    const eff = effectiveClientOptions(PLAIN);
    assert.deepEqual({ ...eff }, { ...CLIENT_LIVENESS_DEFAULTS, loadBalanced: false, fromUri: [] });
  });

  it('a URI value is parsed, and the option is listed as coming from the URI', () => {
    const eff = effectiveClientOptions('mongodb://h/db?connectTimeoutMS=3000&heartbeatFrequencyMS=700');
    assert.equal(eff.connectTimeoutMS, 3_000);
    assert.equal(eff.heartbeatFrequencyMS, 700);
    assert.equal(eff.serverSelectionTimeoutMS, 10_000);
    assert.deepEqual([...eff.fromUri].sort(), ['connectTimeoutMS', 'heartbeatFrequencyMS']);
  });

  it('a value the driver would refuse is reported as the default, not as a number the string does not hold', () => {
    const eff = effectiveClientOptions('mongodb://h/db?connectTimeoutMS=abc&heartbeatFrequencyMS=-4');
    assert.equal(eff.connectTimeoutMS, 10_000);
    assert.equal(eff.heartbeatFrequencyMS, 5_000);
    assert.deepEqual([...eff.fromUri], []);
  });

  it('a caller default is the value the URI does not override', () => {
    const eff = effectiveClientOptions('mongodb://h/db?connectTimeoutMS=3000', { connectTimeoutMS: 5_000, serverSelectionTimeoutMS: 5_000 });
    assert.equal(eff.connectTimeoutMS, 3_000);
    assert.equal(eff.serverSelectionTimeoutMS, 5_000);
  });

  it('loadBalanced is read in any case', () => {
    assert.equal(effectiveClientOptions('mongodb://h/db?loadBalanced=true').loadBalanced, true);
    assert.equal(effectiveClientOptions('mongodb://h/db?LOADBALANCED=TRUE').loadBalanced, true);
    assert.equal(effectiveClientOptions('mongodb://h/db?loadBalanced=false').loadBalanced, false);
  });

  it('what mongoClientOptions hands the driver and what is reported agree, key for key', () => {
    for (const uri of [PLAIN, 'mongodb://h/db?connectTimeoutMS=1', 'mongodb://h/db?serverSelectionTimeoutMS=2&heartbeatFrequencyMS=3']) {
      const given = mongoClientOptions(uri);
      const eff = effectiveClientOptions(uri);
      for (const key of KEYS) {
        assert.equal(key in given, eff.fromUri.includes(key) === false, `${key}: handed to the driver and from the URI at once, or neither`);
      }
    }
  });
});

describe('inFlightBoundMs', () => {
  it('is connect + heartbeat + selection: 25 000 ms with the defaults', () => {
    assert.equal(inFlightBoundMs(effectiveClientOptions(PLAIN)), 25_000);
  });

  it('is computed from the URI\'s values, not the defaults', () => {
    assert.equal(inFlightBoundMs(effectiveClientOptions('mongodb://h/db?connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=1500')), 3_000);
    assert.equal(inFlightBoundMs(effectiveClientOptions('mongodb://h/db?connectTimeoutMS=2000')), 2_000 + 5_000 + 10_000);
  });

  it('0 means unbounded, for each of the three', () => {
    for (const key of KEYS) {
      assert.equal(inFlightBoundMs(effectiveClientOptions(`mongodb://h/db?${key}=0`)), Infinity, `${key}=0 is a bound`);
    }
  });

  it('a loadBalanced=true URI has no monitor: only the selection wait counts', () => {
    assert.equal(inFlightBoundMs(effectiveClientOptions('mongodb://h/db?loadBalanced=true')), 10_000);
    assert.equal(inFlightBoundMs(effectiveClientOptions('mongodb://h/db?loadBalanced=true&serverSelectionTimeoutMS=4000&connectTimeoutMS=0')), 4_000);
    assert.equal(inFlightBoundMs(effectiveClientOptions('mongodb://h/db?loadBalanced=true&serverSelectionTimeoutMS=0')), Infinity);
  });

  it('takes any object that carries the figures, so a test can ask about a client it built itself', () => {
    assert.equal(inFlightBoundMs({ serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_000, heartbeatFrequencyMS: 500 }), 3_000);
    assert.equal(inFlightBoundMs({ serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_000, heartbeatFrequencyMS: 500, loadBalanced: true }), 1_500);
  });
});

describe('a credential never appears in anything the module produces (SEC-2)', () => {
  const SECRET = 'Zx9-hunter2-sEcReT';
  const URIS = [
    `mongodb://admin:${SECRET}@h1:27017,h2:27018/db?replicaSet=rs0`,
    `mongodb+srv://admin:${SECRET}@cluster0.example.net/db?connectTimeoutMS=2000`,
    `mongodb://admin:${SECRET}@h/db?connectTimeoutMS=${SECRET}&heartbeatFrequencyMS=${SECRET}`,
    `mongodb://admin:${SECRET}@h/db?${SECRET}=1&loadBalanced=${SECRET}`,
    `mongodb://admin:${SECRET}%40x%3Fy@h/db?serverSelectionTimeoutMS=%zz`,
    `mongodb://admin:${SECRET}@h/db?%E0%A4%A=1`,
    `mongodb://admin:${SECRET}@h/db?authMechanismProperties=${SECRET}`,
  ];

  it('not in the options, the effective report, the line that describes it, a thrown error or a log line', async () => {
    const { lines, result } = await logLinesDuring(() => {
      const out = [];
      for (const uri of URIS) {
        out.push(JSON.stringify(mongoClientOptions(uri)));
        const eff = effectiveClientOptions(uri);
        out.push(JSON.stringify(eff));
        out.push(describeClientOptions(eff));
        out.push(String(inFlightBoundMs(eff)));
        try { mongoClientOptions(uri, { connectTimeoutMS: -1 }); } catch (err) { out.push(String(err && err.stack)); }
        try { mongoClientOptions(uri, { notAKey: 1 }); } catch (err) { out.push(String(err && err.stack)); }
      }
      return out;
    });
    assert.equal(lines.length, 0, `the module logged: ${JSON.stringify(lines)}`);
    assert.ok(result.length >= URIS.length * 4, 'the loop produced almost nothing, so the assertion below holds over nothing');
    for (const text of result) assert.equal(text.includes(SECRET), false, `a credential reached: ${text.slice(0, 200)}`);
  });

  it('a string the module cannot make sense of does not throw: the driver is the one that refuses it', () => {
    for (const uri of URIS) assert.doesNotThrow(() => { mongoClientOptions(uri); effectiveClientOptions(uri); });
  });
});

describe('describeClientOptions', () => {
  it('names the three figures and which of them the URI supplied', () => {
    const line = describeClientOptions(effectiveClientOptions('mongodb://h/db?connectTimeoutMS=3000'));
    assert.match(line, /connectTimeoutMS=3000 \(MONGO_URI\)/);
    assert.match(line, /heartbeatFrequencyMS=5000 \(default\)/);
    assert.match(line, /serverSelectionTimeoutMS=10000 \(default\)/);
  });

  it('says so when the URI is a load-balanced one', () => {
    assert.match(describeClientOptions(effectiveClientOptions('mongodb://h/db?loadBalanced=true')), /loadBalanced/);
  });
});
