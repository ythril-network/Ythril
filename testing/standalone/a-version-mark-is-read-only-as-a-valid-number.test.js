/**
 * The version mark in config.json is read only as a valid number, and a valid one is never lowered by a read (Q-556, bundle-163).
 *
 * ## Why this is a rule of its own
 *
 * `versionMarks` in config.json is a file an operator can edit, restore from an older copy or hand a peer's bytes to, and its value
 * decides how far a space's version counter is raised before the next stamp. Two wrong readings do damage and both are silent:
 *
 *  - a value that is not a version taken AS one. `"x"`, `null`, `Infinity` (a JSON `1e999`), `-1`, `1.5`, an array, an object, a value
 *    above `VERSION_FLOOR_CAP - STEP` would raise a counter to nothing, to NaN, or to the ceiling, where every later stamp is refused by
 *    every peer (decision 16: a stamp above the cap). A key like `__proto__`, `constructor` or `toString` is the same mistake one level
 *    up: an inherited property read as a space's mark.
 *  - a read that LOWERS a mark kept in memory. An older config.json put back (a restore of the file, a hand edit) must not shorten what
 *    this process already knows its versions reached. "Never lowered" holds for valid values only, so a garbage value cannot pin a space.
 *
 * ## The rule, stated as the design states it
 *
 * A value counts only when `Number.isSafeInteger(v) && 0 <= v <= VERSION_FLOOR_CAP - STEP`, for an OWN key of a plain object.
 * Anything else is ignored. A reload takes a higher valid value into memory and never takes a lower one. The next save writes the entry
 * from memory, so a garbage entry does not outlive it.
 *
 * ## What is held
 *
 * - the values above, one space each, read by `loadConfig`: `versionMarkOf` answers `undefined` for every one of them
 * - the truth table at `VERSION_FLOOR_CAP - STEP - 1` (accepted), `- STEP` (accepted), `- STEP + 1` (refused), `VERSION_FLOOR_CAP` (refused)
 * - inherited and `__proto__` keys answer `undefined`, and `versionMarks` that is not an object at all reads as no marks
 * - a reload of a file holding a LOWER mark, and one holding an INVALID value over a valid one, leave `versionMarkOf` where it was;
 *   a HIGHER one raises it
 * - a save rewrites no garbage: after `saveConfig`, an invalid entry is gone from the file (or a valid number) and a valid one stays
 *
 * ## Seen red
 *
 * On 7c81b63e `server/dist/util/version-mark.js` does not exist, so each case fails on "does not exist: nothing reads the mark". The module
 * is imported inside each case through `markModule()`, so a missing module fails the case and not the file.
 *
 * Config only, no database. Run: node --test testing/standalone/a-version-mark-is-read-only-as-a-valid-number.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'ythril-q556-valid-'));
const CONFIG_PATH = join(tmpDir, 'config.json');
// Read at module load by the loader: set BEFORE anything of the server is imported.
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const S = '../../server/dist/';
/** `VERSION_MARK_STEP` (util/version-mark.ts), as the design states it. */
const STEP = 100_000;
const { VERSION_FLOOR_CAP: CAP } = await import(`${S}util/seq.js`);
const LIMIT = CAP - STEP;

/** `util/version-mark.js`, or `null` while it does not exist: a missing module is a failed assertion in the case, never a crash of the file. */
async function markModule() {
  try { return await import(`${S}util/version-mark.js`); } catch { return null; }
}
const needModule = async () => {
  const mod = await markModule();
  assert.ok(mod, 'server/dist/util/version-mark.js does not exist: nothing reads the mark');
  return mod;
};

/** A config file whose `versionMarks` is the RAW text given (JSON cannot be built from an object for `__proto__`, `1e999`). */
function writeConfigWithMarks(rawMarks) {
  writeFileSync(CONFIG_PATH,
    `{"instanceId":"q556","instanceLabel":"q556","spaces":[],"tokens":[],"networks":[],"versionMarks":${rawMarks}}`,
    { encoding: 'utf8', mode: 0o600 });
}
const diskMarks = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).versionMarks;

let loader;

describe('the version mark is read only as a valid number', () => {
  before(async () => {
    writeConfigWithMarks('{}');
    loader = await import(`${S}config/loader.js`);
    // Loaded the way boot loads them: the module that owns the mark is in memory BEFORE the config is read.
    await markModule();
    loader.loadConfig();
  });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('the module states the step the cases assume', async () => {
    const mod = await needModule();
    assert.equal(mod.VERSION_MARK_STEP, STEP);
  });

  it('values that are not a version are ignored: "x", null, Infinity, -1, 1.5, true, [5], {}, a string of digits, an unsafe integer', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks(
      '{"str":"x","nul":null,"inf":1e999,"neg":-1,"frac":1.5,"bool":true,"arr":[5],"obj":{},"digits":"1000","unsafe":9007199254740993,"cap":' + CAP + ',"ok":1000}');
    loader.reloadConfig();
    for (const space of ['str', 'nul', 'inf', 'neg', 'frac', 'bool', 'arr', 'obj', 'digits', 'unsafe', 'cap']) {
      assert.equal(versionMarkOf(space), undefined, `versionMarkOf('${space}') read a value that is not a valid version`);
    }
    assert.equal(versionMarkOf('ok'), 1000, 'fixture: the one valid mark beside them was not read');
  });

  it('the truth table at the cap: VERSION_FLOOR_CAP - STEP - 1 and - STEP are read, - STEP + 1 and VERSION_FLOOR_CAP are not', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks(`{"below":${LIMIT - 1},"at":${LIMIT},"above":${LIMIT + 1},"cap":${CAP},"zero":0}`);
    loader.reloadConfig();
    assert.equal(versionMarkOf('below'), LIMIT - 1, 'VERSION_FLOOR_CAP - STEP - 1 is a valid mark');
    assert.equal(versionMarkOf('at'), LIMIT, 'VERSION_FLOOR_CAP - STEP is a valid mark');
    assert.equal(versionMarkOf('above'), undefined, 'VERSION_FLOOR_CAP - STEP + 1 is above the largest mark: it would raise the counter into the ceiling reserve');
    assert.equal(versionMarkOf('cap'), undefined, 'VERSION_FLOOR_CAP is above the largest mark');
    assert.equal(versionMarkOf('zero'), 0, '0 is a valid mark');
  });

  it('only an own key of the marks is read: __proto__, constructor and toString answer undefined', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks('{"__proto__":77,"s":5}');   // an own "__proto__" key, as JSON.parse makes it
    loader.reloadConfig();
    assert.equal(versionMarkOf('__proto__'), undefined, 'an own key named __proto__ was read as a space');
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(versionMarkOf(inherited), undefined, `an inherited property '${inherited}' was read as a space's mark`);
    }
    assert.equal(versionMarkOf('s'), 5, 'fixture: the valid mark beside them was not read');
  });

  it('versionMarks that is not an object reads as no marks and does not throw', async () => {
    const { versionMarkOf } = await needModule();
    for (const raw of ['[5]', '"x"', 'null', '7', 'true']) {
      writeConfigWithMarks(raw);
      assert.doesNotThrow(() => loader.reloadConfig(), `a config whose versionMarks is ${raw} was refused`);
      assert.equal(versionMarkOf('0'), undefined, `versionMarks ${raw} was read as marks`);
    }
  });

  it('a reload of a file holding a LOWER valid mark does not lower it, and a HIGHER one raises it', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks('{"low":1000}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('low'), 1000, 'fixture: the mark was not read');

    writeConfigWithMarks('{"low":500}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('low'), 1000, 'a reload of an older config.json lowered the mark this process holds');

    writeConfigWithMarks('{}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('low'), 1000, 'a reload of a file that holds no mark for the space forgot it');

    writeConfigWithMarks('{"low":2000}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('low'), 2000, 'a reload did not take a higher mark from the file into memory');
  });

  it('an INVALID value read over a valid one leaves the valid one, so a garbage value cannot pin or lower a space', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks('{"pin":3000}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('pin'), 3000, 'fixture: the mark was not read');
    for (const raw of ['"x"', 'null', '-1', '1.5', String(CAP)]) {
      writeConfigWithMarks(`{"pin":${raw}}`);
      loader.reloadConfig();
      assert.equal(versionMarkOf('pin'), 3000, `a reload holding ${raw} changed the mark of a space that had a valid one`);
    }
  });

  it('a save writes no garbage: an invalid entry is gone or a valid number, and a valid one stays', async () => {
    const { versionMarkOf } = await needModule();
    writeConfigWithMarks('{"keep":4000,"junk":"x"}');
    loader.reloadConfig();
    assert.equal(versionMarkOf('keep'), 4000, 'fixture: the mark was not read');
    loader.saveConfig(loader.getConfig());
    const written = diskMarks();
    assert.equal(written?.keep, 4000, 'a save lost a valid mark');
    const junk = written?.junk;
    assert.ok(junk === undefined || (Number.isSafeInteger(junk) && junk >= 0 && junk <= LIMIT),
      `a save wrote the garbage entry back: ${JSON.stringify(junk)}`);
  });
});
