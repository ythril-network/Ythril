/**
 * A rename sent while an instance-wide act stands (a restore or a migration) is refused AT ONCE with that act's own write-refusal code, on
 * REST and on MCP alike (bundle-157, Q-559).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * `renameRefusal` (`spaces/rename.ts`) refused a rename only for a deletion or wipe of the space, and let a restore or a migration queue it:
 * the rename registered behind the act and its request waited for that act's whole length, while every other write to the space was
 * refused with `409` and the kind's code (`SPACE_ACT_KINDS`, `space-write-gate.ts`). The client already blocks the rename form while any act
 * stands; the API doors did not. The rule: a rename is a write to the space's identity, so the same standing act that closes the space's
 * writes closes the rename, with the SAME error and answer the gate gives (`SpaceNotWritableError`, `spaceWriteClosedAnswer`) and nothing
 * registered.
 *
 * ## What is asserted
 *
 * For EVERY instance-wide kind, derived from `SPACE_ACT_KINDS` (floor two, so a list that lost a kind fails here and does not pass an empty loop),
 * with an entry of that kind standing for the space, on each door:
 *
 * - the rename answers within a short bound (a held request fails the bound, it is not waited for);
 * - the answer is `409` carrying that kind's `writeRefusalCode`, and the sentence the write gate gives for the same act;
 * - no rename entry was registered and the space kept its id.
 *
 * A standing deletion or wipe still answers `RenameBlockedError`'s answer (no code), so the new refusal did not replace the old one.
 *
 * ## Seen red
 *
 * On afebf11e the rename registers behind the standing restore or migration and waits; the bound fails (or the answer is not the kind's 409).
 *
 * Run: `node --test testing/standalone/a-rename-during-an-instance-wide-act-is-refused-at-once-db.test.js` (test Mongo; a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { seedActEntry, clearActEntries, entriesOf, resetRunnerForTest } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const T = { timeout: 45_000 };
const FLOOR = 2;
/** How long a refusal may take. A rename held behind an act waits for the act, which these rows never complete. */
const BOUND_MS = 4_000;

const { SPACE_ACT_KINDS, isInstanceWide } = await import('../../server/dist/config/types-space-acts.js');
const INSTANCE_WIDE = Object.keys(SPACE_ACT_KINDS).filter(k => isInstanceWide(k));
const DOORS = ['rest', 'mcp'];
const spaceOf = (kind, door) => `rn-${kind}-${door}`;
const spaceIds = [...INSTANCE_WIDE.flatMap(k => DOORS.map(d => spaceOf(k, d))), 'rn-delete', 'rn-wipe'];

describe('a rename during an instance-wide act is refused at once', { skip }, () => {
  let door, loader, runner, spacesRouter, restHandler;

  before(async () => {
    door = await openToolDoor({ suite: 'renameactwide', spaces: spaceIds.map(id => ({ id, label: id, folders: [] })) });
    loader = await import('../../server/dist/config/loader.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    restHandler = door.routeHandler(spacesRouter, 'patch', '/:id/rename');
  });
  after(async () => { try { resetRunnerForTest(runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(runner); clearActEntries(loader); });

  /** The rename as `door` answers it, or `{ held: true }` when it had not answered within the bound. */
  async function renameOn(doorName, space, newId) {
    const asked = doorName === 'rest'
      ? door.request(restHandler, { params: { id: space }, body: { newId } }).then(r => ({ status: r.status, error: r.body?.error, code: r.body?.code }))
      // The tool's status travels in its text (`Error (409): ...`), as on every tool that mirrors a route; its code rides in structuredContent.
      : door.call('space_rename', { space, newId }, { transport: 'mcp' }).then(r => {
        const stated = /^Error \((\d+)\)/.exec(r.text);
        return { status: stated ? Number(stated[1]) : 200, error: r.structured?.error ?? r.text, code: r.structured?.code };
      });
    let timer;
    const bound = new Promise(resolve => { timer = setTimeout(() => resolve({ held: true }), BOUND_MS); });
    try { return await Promise.race([asked, bound]); } finally { clearTimeout(timer); }
  }

  const renameEntries = () => entriesOf(loader).filter(e => e.kind === 'rename');

  it('the instance-wide kinds are a list the rows below are derived from', () => {
    assert.ok(INSTANCE_WIDE.length >= FLOOR, `SPACE_ACT_KINDS names ${INSTANCE_WIDE.length} instance-wide kind(s), fewer than the floor of ${FLOOR}: a loop over none passes`);
  });

  for (const kind of INSTANCE_WIDE) for (const doorName of DOORS) {
    it(`${kind} standing: a rename on ${doorName} answers 409 with the kind's code at once and registers nothing`, T, async () => {
      const space = spaceOf(kind, doorName);
      const spec = SPACE_ACT_KINDS[kind];
      await seedActEntry(loader, { kind, localId: space });
      const answer = await renameOn(doorName, space, `${space}-new`);
      const after = { held: answer.held === true, entries: renameEntries().length, renamed: loader.getConfig().spaces.some(s => s.id === `${space}-new`) };
      // Put the config back before asserting, so a held request left behind by the red run cannot rename the space under the next row.
      clearActEntries(loader);
      assert.equal(after.held, false, `the rename was held behind a standing ${kind} for over ${BOUND_MS} ms instead of refused`);
      assert.equal(answer.status, 409, `the rename answered ${answer.status}: ${answer.error}`);
      assert.equal(answer.code, spec.writeRefusalCode, `the rename's refusal does not carry the ${kind} write-refusal code`);
      assert.ok(String(answer.error).includes(spec.writeRefusalWhy({})), `the refusal does not say what the write gate says for a standing ${kind}: ${answer.error}`);
      assert.equal(after.entries, 0, 'the refused rename registered an entry');
      assert.equal(after.renamed, false, 'the refused rename moved the space');
    });
  }

  for (const kind of ['delete', 'wipe']) for (const doorName of DOORS) {
    it(`${kind} standing: a rename on ${doorName} still answers the deletion-or-wipe refusal`, T, async () => {
      const space = `rn-${kind}`;
      await seedActEntry(loader, { kind, localId: space });
      const answer = await renameOn(doorName, space, `${space}-new-${doorName}`);
      clearActEntries(loader);
      assert.equal(answer.held, undefined, 'the rename was held');
      assert.equal(answer.status, 409, `${answer.status}: ${answer.error}`);
      assert.match(String(answer.error), /cannot be renamed while a deletion or wipe of it is owed or running/);
    });
  }
});
