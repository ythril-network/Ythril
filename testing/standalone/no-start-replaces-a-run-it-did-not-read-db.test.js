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
 * Run: node --test testing/standalone/no-start-replaces-a-run-it-did-not-read-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const SPACES = Array.from({ length: 8 }, (_, i) => `race${i}`);
const ADMIN = { instanceAdmin: true, perSpace: {} };
/** The two acts' types: two different types the conversion schema declares, so the stored run says which act it is. */
const TWO = [{ kind: 'entity', type: 'person' }, { kind: 'fact', type: 'claim' }];

describe('no start replaces a run it did not read (real MongoDB)', { skip }, () => {
  let door, run, acts;
  before(async () => {
    door = await openConvertDoor({ name: 'b284race', spaces: SPACES });
    run = await door.runModule();
    acts = await import('../../server/dist/spaces/schema-convert-acts.js');
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('an act and a round start made together: the round\'s source survives, and an act answered 202 has its source in the run', async () => {
    const results = await Promise.all(SPACES.map(async (space, i) => {
      const [act, round] = await Promise.all([
        acts.schemaConvertStartAct(space, { types: [{ kind: 'entity', type: 'person' }] }, { rights: ADMIN, rateKey: `race-act-${i}` }),
        run.startSchemaConvertRun({ spaceId: space, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'round', roundId: `round-${i}` } }),
      ]);
      return { space, act, round, doc: await door.runDoc(space) };
    }));
    for (const { space, act, round, doc } of results) {
      assert.equal(round.ok, true, `${space}: the round start was refused: ${JSON.stringify(round)}`);
      const kinds = (doc?.sources ?? []).map(s => s.kind);
      assert.ok(kinds.includes('round'), `${space}: the round's run was lost (sources ${JSON.stringify(doc?.sources)}, the act answered ${act.status})`);
      if (act.status === 202) assert.ok(kinds.includes('act'), `${space}: the act answered 202 for a run that is not there (sources ${JSON.stringify(doc?.sources)})`);
      else assert.equal(act.status, 409, `${space}: the act answered ${act.status} ${JSON.stringify(act.body ?? act)}`);
    }
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
