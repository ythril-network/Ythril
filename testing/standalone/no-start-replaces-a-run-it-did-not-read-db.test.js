/**
 * No start of a conversion run replaces a run document it did not read, so a round's owed run is never lost to an act that started beside it
 * (`Q-746`, bundle-284 fix round after the lens sweep: S1).
 *
 * ## What it prevents
 *
 * The Convert act started outside the space's turn, and every start read the run document and then wrote it unconditionally. An act and a passed
 * round's start on one space could both read "no run" and both write: the later write erased the earlier run, with its sources. When the erased run
 * was the round's, the round was then marked done (its run document had been written) and its types were never converted here, with nothing said.
 * Two acts at once both answered 202 and one run was lost.
 *
 * ## What holds
 *
 * Every start takes the space's one turn, and writes only over the document it read (a new run only where none exists, a restart only over the
 * generation it read). So for an act and a round start made together on a space with no run, whichever comes second either joins the first (the
 * run names both sources) or, for an act behind an unfinished run, is refused 409 and the round's source survives. Never a 202 for a run that is
 * not there. Several spaces at once, so an interleaving that loses a run is very likely to be met by at least one of them on the code before.
 *
 * One order is neither: the act's run finishes (its type holds no record here, so one empty page ends it) before the round's start reads the
 * document. A start joins only an unfinished run; over a finished one it starts its own, so the stored run names the round alone while the act's
 * 202 was true: its run ran and ended. CI run 44390215367 met that order on `race0` and the case failed on a run that was not lost. The judge
 * tells the two apart by the act's run's audit entry (written when a run ends) and the round's run being a new generation; a forced case pins it.
 *
 * Run: node --test testing/standalone/no-start-replaces-a-run-it-did-not-read-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';
import { auditRowsOf } from './_audit-rows.mjs';

const skip = await mongoSkipReason();
const SPACES = Array.from({ length: 8 }, (_, i) => `race${i}`);
/** The space of the forced order: the act's run finishes before the round's start reads the run. */
const AFTER = 'race-after';
const ROUND_TYPES = [{ kind: 'entity', type: 'person' }];
/** A space administrator everywhere: the knowledge admin rung and the space's admin right the start asks. */
const ADMIN = { perSpace: {}, floor: {}, spaceAdmin: { floor: true, spaces: [] } };
/** The two acts' types: two different types the conversion schema declares, so the stored run says which act it is. */
const TWO = [{ kind: 'entity', type: 'person' }, { kind: 'fact', type: 'claim' }];

describe('no start replaces a run it did not read (real MongoDB)', { skip }, () => {
  let door, run, acts;
  before(async () => {
    door = await openConvertDoor({ name: 'b284race', spaces: [...SPACES, AFTER] });
    run = await door.runModule();
    acts = await import('../../server/dist/spaces/schema-convert-acts.js');
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  const actStart = (space, key) => acts.schemaConvertStartAct(space, { types: ROUND_TYPES.map(t => ({ ...t })) }, { rights: ADMIN, rateKey: key });
  const roundStart = (space, roundId) => run.startSchemaConvertRun({ spaceId: space, types: ROUND_TYPES.map(t => ({ ...t })), steps: [], source: { kind: 'round', roundId } });

  /**
   * What is wrong with one act start and one round start made on `space` (each space is started once in this file), by what the run document
   * and the audit log hold: [] when nothing is. An act answered 202 has its source in the stored run, unless its run FINISHED before the round's
   * start read the document: a start joins only an unfinished run, and over a finished one it starts a run of its own (design r5 5.1; the
   * door test "a start after a complete run is a new run"). That order is told apart from a lost run by the act's run's own entry in the
   * audit log (`schema.convert.run`: written once, when a run ends, with how it was started and how it ended) and by the round's run being a
   * new run one generation above the one it read; a run another start erased never ends, so it has no entry.
   */
  async function wrongWith({ space, act, round, doc }) {
    const out = [];
    if (round.ok !== true) out.push(`${space}: the round start was refused: ${JSON.stringify(round)}`);
    const kinds = (doc?.sources ?? []).map(s => s.kind);
    if (!kinds.includes('round')) out.push(`${space}: the round's run was lost (sources ${JSON.stringify(doc?.sources)}, the act answered ${act.status})`);
    if (act.status === 202) {
      if (!kinds.includes('act') && !(await actRunFinishedFirst(space, round, doc))) {
        out.push(`${space}: the act answered 202 for a run that is not there and did not finish (sources ${JSON.stringify(doc?.sources)}, generation ${doc?.generation})`);
      }
    } else if (act.status !== 409) out.push(`${space}: the act answered ${act.status} ${JSON.stringify(act.body ?? act)}`);
    return out;
  }

  /** Did the act's run of `space` end complete before the round's start, which then started a new run over it (not a restart of it)? */
  async function actRunFinishedFirst(space, round, doc) {
    const changeOf = (row, field) => (row.changes ?? []).find(c => c.field === field)?.to;
    const ended = (await auditRowsOf(door.mongo, { operation: 'schema.convert.run', spaceId: space }))
      .filter(r => String(changeOf(r, 'sources')).split(',').includes('act') && changeOf(r, 'state') === 'complete');
    return ended.length === 1 && round.state === 'started' && round.run?.generation === doc?.generation && doc.generation >= 2;
  }

  it('an act and a round start made together: the round\'s source survives, and an act answered 202 has its source in the run', async () => {
    const results = await Promise.all(SPACES.map(async (space, i) => {
      const [act, round] = await Promise.all([actStart(space, `race-act-${i}`), roundStart(space, `round-${i}`)]);
      return { space, act, round, doc: await door.runDoc(space) };
    }));
    const wrong = [];
    for (const r of results) wrong.push(...await wrongWith(r));
    assert.deepEqual(wrong, []);
  });

  // The order CI run 44390215367 met in the case above (race0): the act's run (no records of its type, one empty page) finished before the
  // round's start read the run document, so the round started a run of its own over the finished one.
  it('an act whose run finished before a round start read it: judged as the case above judges it', async () => {
    const act = await actStart(AFTER, 'race-after-act');
    assert.equal(act.status, 202, JSON.stringify(act.body ?? act));
    await waitForValue(async () => ((await door.runDoc(AFTER))?.state === 'complete' ? true : null), 20_000, 50, undefined, { what: 'the act\'s run to finish' });
    const round = await roundStart(AFTER, 'round-after');
    const doc = await door.runDoc(AFTER);
    assert.deepEqual(await wrongWith({ space: AFTER, act, round, doc }), []);
    assert.deepEqual([round.state, doc.sources.map(s => s.kind)], ['started', ['round']],
      'the round did not start a run of its own over the finished one');
  });

  it('two acts made together: at most one answers 202, and its run is the one stored', async () => {
    for (const space of SPACES) await door.mongo.col(door.spaceCollection(space, 'schemaConvertRun')).deleteMany({});
    const results = await Promise.all(SPACES.map(async (space, i) => {
      const both = await Promise.all([0, 1].map(j =>
        acts.schemaConvertStartAct(space, { types: [TWO[j]] }, { rights: ADMIN, rateKey: `race-two-${i}-${j}` })));
      return { space, both, doc: await door.runDoc(space) };
    }));
    for (const { space, both, doc } of results) {
      const started = both.filter(a => a.status === 202);
      assert.equal(started.length, 1, `${space}: ${started.length} acts answered 202 (${both.map(a => a.status).join(', ')})`);
      const wanted = `${started[0].body.types[0].kind}:${started[0].body.types[0].type}`;
      assert.deepEqual(doc.types.map(t => `${t.kind}:${t.type}`), [wanted], `${space}: the run stored is not the one the 202 named`);
    }
  });
});
