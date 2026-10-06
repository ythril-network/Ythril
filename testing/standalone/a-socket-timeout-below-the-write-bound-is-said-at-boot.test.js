/**
 * A `socketTimeoutMS` in `MONGO_URI` below the write bound is said ONCE, at boot (bundle-56 round S, R12).
 *
 * ## Why
 *
 * The write bound ends a plain write with the SERVER's deadline first (`db/write-bound.ts`): the operation carries
 * `maxTimeMS` = the bound and no driver clock, and the caller is answered only once that deadline has passed. A
 * `timeoutMS` in the connection string is neutralised for such a write. A `socketTimeoutMS` is not: it is a read timeout on
 * the socket, below the driver's operation clock, and one SHORTER than the bound ends the wait on the client while the
 * server still holds the write alive. The caller is answered before the write is known not to land, which is the defect the
 * order exists to close — and the operator who set it has no way to learn that, short of reading the row of the hosting
 * guide that names it (`02-hosting.md`, `YTHRIL_WRITE_TIMEOUT_MS`). So the server says it itself, once, when it connects.
 *
 * ## The rule
 *
 * - a connection string whose `socketTimeoutMS` is a positive number below `writeTimeoutMs()`: ONE warn line, naming the
 *   option, the number it carries, and the bound it is below;
 * - at or above the bound, absent, `0` (the driver's "no socket timeout") or not a number: no line;
 * - the option name is read as MongoDB reads it, in any case, anywhere in the options of any form of connection string
 *   (a replica-set list of hosts, `mongodb+srv`, credentials with an `@` in them);
 * - `connectMongo` makes the call, with the URI it connects with — read from its source, comments stripped, because the
 *   connection itself needs the database. The bound is read at the call, so a changed `YTHRIL_WRITE_TIMEOUT_MS` moves the line.
 *
 * Run: node --test testing/standalone/a-socket-timeout-below-the-write-bound-is-said-at-boot.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { warnIfSocketTimeoutBelowWriteBound, setWriteBoundForTest, writeTimeoutMs } from '../../server/dist/db/write-bound.js';

const BOUND_MS = 30_000;
const said = async (uri) => {
  const { lines, result } = await logLinesDuring(() => warnIfSocketTimeoutBelowWriteBound(uri));
  return { lines: lines.filter(l => /socketTimeoutMS/i.test(l)), result };
};

describe('socketTimeoutMS below the write bound', () => {
  before(() => setWriteBoundForTest({ writeTimeoutMs: BOUND_MS, holdDeadlineMs: BOUND_MS * 2 }));
  after(() => setWriteBoundForTest(null));

  it('the bound the rows are written against is the one in force', () => {
    assert.equal(writeTimeoutMs(), BOUND_MS);
  });

  it('a socketTimeoutMS below the bound is ONE warn line naming the option, its number and the bound', async () => {
    const { lines, result } = await said('mongodb://ythril-mongo:27017/ythril?directConnection=true&socketTimeoutMS=5000');
    assert.equal(result, true, 'the call does not say it warned');
    assert.equal(lines.length, 1, `expected one line, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /WARN/);
    assert.match(lines[0], /5000/, 'the line does not carry the number the URI sets');
    assert.match(lines[0], new RegExp(String(BOUND_MS)), 'the line does not carry the bound it is below');
    assert.match(lines[0], /YTHRIL_WRITE_TIMEOUT_MS/, 'the line does not name the setting that moves the bound');
  });

  const QUIET = [
    ['at the bound', `mongodb://h:27017/db?socketTimeoutMS=${BOUND_MS}`],
    ['above the bound', `mongodb://h:27017/db?socketTimeoutMS=${BOUND_MS * 2}`],
    ['absent', 'mongodb://h:27017/db?directConnection=true'],
    ['no options at all', 'mongodb://h:27017/db'],
    ['0, the driver\'s "no socket timeout"', 'mongodb://h:27017/db?socketTimeoutMS=0'],
    ['not a number', 'mongodb://h:27017/db?socketTimeoutMS=soon'],
    ['empty', 'mongodb://h:27017/db?socketTimeoutMS='],
    ['a different option that ends the same way', 'mongodb://h:27017/db?connectTimeoutMS=5000&serverSelectionTimeoutMS=5000'],
    ['the option name inside another option\'s value', 'mongodb://h:27017/db?appName=socketTimeoutMS%3D5000'],
  ];
  for (const [what, uri] of QUIET) {
    it(`says nothing when it is ${what}`, async () => {
      const { lines, result } = await said(uri);
      assert.equal(result, false);
      assert.deepEqual(lines, []);
    });
  }

  const LOUD = [
    ['any case, as MongoDB reads the name', 'mongodb://h:27017/db?SOCKETTIMEOUTMS=1000'],
    ['among other options, last', 'mongodb://h:27017/db?directConnection=true&authSource=admin&socketTimeoutMS=1000'],
    ['among other options, first', 'mongodb://h:27017/db?socketTimeoutMS=1000&directConnection=true'],
    ['a replica-set list of hosts', 'mongodb://a:27017,b:27017,c:27017/db?replicaSet=rs0&socketTimeoutMS=1000'],
    ['mongodb+srv', 'mongodb+srv://cluster0.example.net/db?socketTimeoutMS=1000'],
    ['credentials with an @ in the password', 'mongodb://user:p%40ss@h:27017/db?socketTimeoutMS=1000'],
    ['no database in the path', 'mongodb://h:27017/?socketTimeoutMS=1000'],
    ['one under the bound', `mongodb://h:27017/db?socketTimeoutMS=${BOUND_MS - 1}`],
  ];
  for (const [what, uri] of LOUD) {
    it(`warns once for ${what}`, async () => {
      const { lines, result } = await said(uri);
      assert.equal(result, true);
      assert.equal(lines.length, 1, JSON.stringify(lines));
    });
  }

  it('the line never carries the connection string (credentials are in it)', async () => {
    const { lines } = await said('mongodb://theuser:thepassword@h:27017/db?socketTimeoutMS=1000');
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /thepassword|theuser/);
  });

  it('the bound is read at the call: raise it and a number that was above it is now below it', async () => {
    const uri = 'mongodb://h:27017/db?socketTimeoutMS=40000';
    assert.deepEqual((await said(uri)).lines, []);
    setWriteBoundForTest({ writeTimeoutMs: 60_000, holdDeadlineMs: 120_000 });
    try { assert.equal((await said(uri)).lines.length, 1); } finally { setWriteBoundForTest({ writeTimeoutMs: BOUND_MS, holdDeadlineMs: BOUND_MS * 2 }); }
  });
});

describe('the boot path makes the call', () => {
  it('connectMongo hands the connection string it connects with to warnIfSocketTimeoutBelowWriteBound', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'server/src/db/mongo.ts'), 'utf8'));
    const at = code.indexOf('export async function connectMongo(');
    assert.ok(at >= 0, 'connectMongo is not where this gate looks');
    const rest = code.slice(at);
    // The end of the function is the first closing brace at the start of a line, on a CRLF checkout as on an LF one.
    const end = rest.search(/\r?\n}\r?\n/);
    assert.ok(end >= 0, 'the end of connectMongo is not where this gate looks');
    const body = rest.slice(0, end + 2);
    assert.match(body, /\bwarnIfSocketTimeoutBelowWriteBound\(\s*uri\s*\)/, 'connectMongo no longer says a socketTimeoutMS below the write bound');
    assert.ok(body.indexOf('warnIfSocketTimeoutBelowWriteBound(') > body.indexOf('.connect()'), 'it is said before the connection works: a string that cannot connect has a worse thing to say, and every retry would say it again');
  });
});
