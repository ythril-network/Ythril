/**
 * A standing act of EVERY kind refuses a local write to its space, with that kind's own code (bundle-157, R3.1 and R5.1).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * `refusalFor` (`spaces/space-write-gate.ts`) answered from three `if`s, one per kind it knew (wipe, delete, rename). A fourth kind
 * stood for its space and refused nothing: `spaceActStands` returned the entry, `refusalFor` matched none of the three, and the write
 * landed in a space whose database a restore was about to replace. The rule is that the gate decides by an exhaustive map over the
 * kinds, and the kinds are ONE list the runtime can read: `SPACE_ACT_KINDS` in `config/types-space-acts.ts`, each entry carrying the
 * `writeRefusalCode` its refusal answers with.
 *
 * ## What is asserted
 *
 * - `SPACE_ACT_KINDS` exists, is a non-empty record, has at least four kinds, and names `restore` and `migrate` among them (the self-check:
 *   the bundle's two new kinds are in the list, so the rows below judge them);
 * - every kind's code is a string no other kind shares, so a row that compares a code compares something;
 * - for EVERY kind, derived from that list and never from a name written here: an entry of that kind standing for a space makes the gate
 *   refuse a write to it (`assertSpaceTakesWrites`, and the text `spaceWriteRefusal` gives) with `SpaceNotWritableError` carrying that
 *   kind's `writeRefusalCode`;
 * - a space with no entry takes the same write (control), so a refusal is the entry's.
 *
 * The gate is the unit: it reads the live config and nothing else, so no database is needed. Each row stands the entry up exactly as the
 * runner's registration leaves it (`_space-act-harness.mjs`).
 *
 * ## Seen red
 *
 * On the base the const does not exist (the first row fails and no per-kind row is derived). With the const present and the gate left as
 * it was, the rows for `restore` and `migrate` fail: the gate answers null for a kind it has no `if` for and the write is allowed.
 *
 * Run: `node --test testing/standalone/every-space-act-kind-refuses-a-local-write.test.js` (a prior `npm run build` in server/).
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-act-kinds-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'everykindspace';
const OTHER = 'untouchedspace';
const FLOOR = 4;

// A namespace import, so a module that does not export the const yet is a failed assertion below and not a link error that hides which
// rule is red.
const kindsModule = await import('../../server/dist/config/types-space-acts.js');
const KINDS = kindsModule.SPACE_ACT_KINDS;
const kindNames = KINDS && typeof KINDS === 'object' ? Object.keys(KINDS) : [];

describe('a standing act of every kind refuses a local write', () => {
  let loader, gate;
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'act-kinds-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [] }, { id: OTHER, label: OTHER, folders: [] }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    gate = await import('../../server/dist/spaces/space-write-gate.js');
    loader.loadConfig();
  });
  afterEach(() => clearActEntries(loader));

  function refusalOf(spaceId) {
    try { gate.assertSpaceTakesWrites(spaceId); } catch (err) { return err; }
    return null;
  }

  it('SPACE_ACT_KINDS is a non-empty record of at least four kinds, restore and migrate among them', () => {
    assert.ok(KINDS && typeof KINDS === 'object' && !Array.isArray(KINDS), 'config/types-space-acts.js exports no SPACE_ACT_KINDS record: the kinds are not a list the runtime can read');
    assert.ok(kindNames.length >= FLOOR, `SPACE_ACT_KINDS names ${kindNames.length} kind(s), fewer than the ${FLOOR} the floor expects: ${kindNames.join(', ')}`);
    for (const k of ['wipe', 'delete', 'rename', 'restore', 'migrate']) assert.ok(kindNames.includes(k), `SPACE_ACT_KINDS has no '${k}': ${kindNames.join(', ')}`);
  });

  it('every kind answers its writes with a code of its own', () => {
    assert.ok(kindNames.length > 0, 'there are no kinds to read a code from');
    const codes = kindNames.map(k => KINDS[k].writeRefusalCode);
    for (const [i, c] of codes.entries()) assert.ok(typeof c === 'string' && c.length > 0, `kind '${kindNames[i]}' has no writeRefusalCode`);
    assert.equal(new Set(codes).size, codes.length, `two kinds share a refusal code, so a row comparing codes proves nothing: ${codes.join(', ')}`);
  });

  it('control: a space with no standing act takes the write, so a refusal below is the entry\'s', () => {
    assert.equal(refusalOf(SPACE), null, 'the fixture space refused a write with no act standing');
    assert.equal(gate.spaceWriteRefusal(SPACE), null);
  });

  for (const kind of kindNames) {
    it(`a standing '${kind}' refuses a local write with that kind's writeRefusalCode, and leaves another space alone`, async () => {
      await seedActEntry(loader, { kind, localId: SPACE, state: 'registered', ...(kind === 'rename' ? { newId: 'renamedeverykind' } : {}) });
      const want = KINDS[kind].writeRefusalCode;

      const err = refusalOf(SPACE);
      assert.ok(err && gate.isSpaceNotWritable(err), `the gate let a write through for a standing '${kind}': ${err?.message ?? 'no refusal'}`);
      assert.equal(err.code, want, `the gate refused a '${kind}' with code '${err.code}', not that kind's '${want}'`);
      assert.equal(typeof gate.spaceWriteRefusal(SPACE), 'string', `spaceWriteRefusal gave no reason for a standing '${kind}'`);
      assert.equal(refusalOf(OTHER), null, `a standing '${kind}' of ${SPACE} refused a write to ${OTHER}`);
    });
  }
});
