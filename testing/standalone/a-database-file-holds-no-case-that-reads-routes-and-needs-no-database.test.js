/**
 * No `-db` test file holds a case that reads the mounted routes and needs no database (Q-969).
 *
 * ## The defect this holds
 *
 * Bundle-272's Full run 45779013515 failed on one case, `the subjects are derived from the mounts, have a floor, and every one has a
 * request`, in `a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route-db.test.js`. It reads `mountedRoutes()` and the
 * file's own REQUESTS table and opens no database, but it sat in a `-db` file, so the local preflight (the pure tier) never ran it and
 * the new SPARQL Update door was found by CI, a bundle cycle later. A case like it belongs in a pure file, beside its `-db` file.
 *
 * ## The rule, per case
 *
 * Every `-db` file under `testing/standalone` is read case by case (`_cases-needing-no-database.mjs` says how a case is judged). A case
 * that derives its subjects from the routes the server mounts and touches no database is NAMED here. A file that keeps its database
 * cases and loses only the pure ones passes; so does a case that reads the routes and sends a request.
 *
 * ## Proof that it can fail
 *
 * Planted files: a `-db` file with a pure route case is named; one whose route case sends a request, one whose route case reads a
 * binding a hook opened, and a file with no route case are not; a file beside its pure half passes.
 *
 * Run: node --test testing/standalone/a-database-file-holds-no-case-that-reads-routes-and-needs-no-database.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { databaseTestFiles, routeCasesWithoutDatabase } from './_cases-needing-no-database.mjs';

const named = (text) => routeCasesWithoutDatabase('testing/standalone/planted-db.test.js', text).map(c => c.name);

const HEAD = `import { describe, it, before, after } from 'node:test';
import { mountedRoutes } from './_routes.mjs';
import { openPushDoor } from './_push-door.mjs';
let door; let base;
const TABLE = { 'GET /a': 1 };
const subjects = mountedRoutes().map(r => r.path);
`;
const HOOKS = `before(async () => { door = await openPushDoor({ suite: 'x' }); base = door.url; });
after(async () => { await door?.close(); });
`;

describe('a -db file holds no case that reads the routes and needs no database', () => {
  it('the planted pure route case is named, however the routes reach it', () => {
    assert.deepEqual(named(`${HEAD}describe('d', () => { ${HOOKS}
      it('pure', () => { assert.deepEqual(subjects.filter(s => !TABLE[s]), []); });
    });`), ['pure']);
    assert.deepEqual(named(`${HEAD}describe('d', () => { ${HOOKS}
      it('direct', () => { assert.ok(mountedRoutes().length > 3); });
    });`), ['direct']);
    assert.deepEqual(named(`${HEAD}function listed() { return subjects; }
      describe('d', () => { ${HOOKS} it('through a function', () => { assert.ok(listed().length); }); });`), ['through a function']);
  });

  it('a case that opens or uses the database is not named, and only the pure case of a mixed file is', () => {
    assert.deepEqual(named(`${HEAD}describe('d', () => { ${HOOKS}
      it('asks the door', async () => { for (const s of subjects) await door.coll('x', 'facts').find({ s }).toArray(); });
      it('asks the server', async () => { for (const s of subjects) await fetch(base + s); });
      it('opens its own', async () => { const d = await openPushDoor({ suite: 'y' }); assert.ok(subjects.length && d); });
      it('pure', () => { assert.ok(subjects.length); });
    });`), ['pure']);
  });

  it('a case that reads a value a database built is not named, but a hook-held value built with no call is', () => {
    assert.deepEqual(named(`${HEAD}const ROWS = skip ? [] : await rowsOf(door);
      let code;
      describe('d', () => { before(() => { code = KINDS.restore.code; }); ${HOOKS}
        it('reads rows', () => { assert.ok(ROWS.length && subjects.length); });
        it('reads a hook-held plain value', () => { assert.equal(typeof code, 'string'); assert.ok(subjects.length); });
      });`), ['reads a hook-held plain value']);
  });

  it('a case that never reads the routes is not named, and a skipped case does not run', () => {
    assert.deepEqual(named(`${HEAD}describe('d', () => { ${HOOKS}
      it('plain', () => { assert.equal(1, 1); });
      it.skip('skipped', () => { assert.ok(subjects.length); });
    });`), []);
  });

  it('the sweep reads the database files, so an empty listing cannot pass', () => {
    assert.ok(databaseTestFiles().length >= 400);
  });

  it('no -db file under testing/standalone holds a case that reads the routes and needs no database', () => {
    const found = [];
    for (const file of databaseTestFiles()) {
      for (const c of routeCasesWithoutDatabase(file, readFileSync(join(REPO_ROOT, file), 'utf8'))) found.push(`${file}:${c.line} '${c.name}'`);
    }
    assert.deepEqual(found, [], 'a case reads the mounted routes and opens no database, but sits in a -db file that the local preflight never runs: '
      + 'move it into a pure file beside its -db file (shared tables in a helper both import)');
  });
});
