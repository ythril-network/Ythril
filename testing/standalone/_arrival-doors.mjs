/**
 * The four doors a record ARRIVES by, each as "these documents arrive in this space", and what each door answers about what the
 * arrival recorded against the receiver's schema (Q-93, Q-443).
 *
 * ## What it prevents
 *
 * The arrival recorder is one function behind four doors: the single push routes (`POST /api/sync/<family>`, a page of one), `POST
 * /api/sync/batch-upsert`, the engine's PULL (a real sync cycle against a fake peer) and the admin import. A rule held on one door only is
 * the weaker door winning (CLAUDE.md, "the defect class this repo produces most"), so a test of what an arrival records is written ONCE
 * and run over all four. The table of the four was written inside the undeclared-key test and was about to be copied into the test of the
 * edge rules; each copy would answer what a door says in its own words, and a door whose answer changed would be fixed in one of them.
 *
 * ## What each door can say, which is why the table has the fields it has
 *
 *  - push (single): the response's `schemaViolations` rows (`{ field, value, reason }`, per document), and the log lines.
 *  - push (batch): the response's per-family COUNT of documents recorded (`<family>.schemaViolations`), and the log lines.
 *  - import: the result's rows (`{ _id, violations }`), their count, and the log lines.
 *  - pull: no structured answer exists. The sinks are the sync history row of the cycle that pulled it and every log line the cycle wrote.
 *
 * ## What it does not do
 *
 * It decides no rule and holds no schema: the caller opens the door with its own spaces and meta, and builds its own documents. A case that
 * needs a document that is NOT stored on one door (`unstored`) says so itself, because what "not stored" means differs per family.
 *
 * ONE DOOR PER PROCESS, as `openPullDoor` is: the harness is one object per test file, and `open` is called once.
 */
import assert from 'node:assert/strict';
import { peerToken, FAMILIES } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

/** The families the table carries, by the key a batch body and an import payload name them by. */
export const ARRIVING_FAMILIES = Object.freeze(['entities', 'edges']);

/**
 * @param {object} o
 * @param {string} o.peerPrefix  the instance id every push names its peer by (a new peer per request, so a once-per-window line never hides a second recording)
 */
export function arrivalHarness({ peerPrefix }) {
  const h = {
    /** @type {any} */ door: undefined,
    /** @type {any} */ engine: undefined,
    /** @type {any} */ importMod: undefined,
    /** @type {any} */ log: undefined,
    pusher: 0,
    nextPeer: () => peerToken(`${peerPrefix}${++h.pusher}`),

    /** Open the pull door (a push door and a fake peer) and import the modules the doors drive. */
    async open(o) {
      h.door = await openPullDoor(o);
      h.engine = await import('../../server/dist/sync/engine.js');
      h.importMod = await import('../../server/dist/api/admin-import.js');
      ({ log: h.log } = await import('../../server/dist/util/log.js'));
      return h.door;
    },
    async close() { await h.door?.close(); },

    /** Every log line the server writes while `fn` runs — the three levels a recorder or the cycle can speak at. */
    async capturing(fn) {
      const lines = [];
      const orig = { warn: h.log.warn, error: h.log.error, info: h.log.info };
      for (const k of Object.keys(orig)) h.log[k] = (...a) => { lines.push(a.join(' ')); };
      try { return { result: await fn(), lines }; } finally { Object.assign(h.log, orig); }
    },

    /** One sync cycle of the real engine, and the history row it wrote (written without the cycle awaiting it). */
    async cycle() {
      const since = new Date().toISOString();
      const { result, lines } = await h.capturing(async () => {
        const out = await h.engine.runSyncForNetwork(h.door.NET);
        await h.door.settled();
        return out;
      });
      let row;
      await waitFor(async () => {
        row = (await h.door.mongo.col('_sync_history').find({ networkId: h.door.NET, triggeredAt: { $gte: since } }).toArray())[0];
        return row !== undefined;
      }, 10_000, 100, undefined, { what: 'the sync history row of the cycle that pulled the page' });
      return { out: result, lines, history: JSON.stringify(row) };
    },

    /**
     * The four doors for the documents of `family` (`'entities'` or `'edges'`). `arrive(space, docs, beside)` carries `docs` and, in the
     * same arrival, the documents of other families named by `beside` (`{ entities: [...] }`): on the batch, pull and import doors they
     * are one page, on the single door they are pushed one by one first.
     *
     * `perDocRows` says the door answers WHICH documents were recorded, `counted` that it answers HOW MANY. The pull answers neither.
     *
     * @typedef {object} Observation
     * @property {Array<{ id: string, field: string, reason: string, value?: unknown }>} rows  per-document rows (push single, import)
     * @property {string[]} lines          every log line during the arrival
     * @property {string|null} history     the pull's sync history row, as text
     * @property {number|null} batchCount  the batch's, or the import's, count of documents recorded
     * @property {string} valueSinks       everything built FOR the record, as text: the lines, the history, and the import rows
     */
    doors(family) {
      assert.ok(ARRIVING_FAMILIES.includes(family), `no door table for family '${family}'`);
      const single = FAMILIES[family].single;
      return {
        'push (single)': {
          perDocRows: true, counted: false,
          async arrive(space, docs, beside = {}) {
            const obs = { rows: [], lines: [], history: null, batchCount: null, valueSinks: '' };
            for (const [other, others] of Object.entries(beside)) {
              for (const d of others) {
                const { result } = await h.capturing(() => h.door.push(FAMILIES[other].single, d, { spaceId: space, token: h.nextPeer() }));
                assert.equal(result.code, 200, `POST ${FAMILIES[other].single} for '${d._id}' answered ${result.code}: ${JSON.stringify(result.body)}`);
              }
            }
            for (const d of docs) {
              const { result, lines } = await h.capturing(() => h.door.push(single, d, { spaceId: space, token: h.nextPeer() }));
              assert.equal(result.code, 200, `POST ${single} for '${d._id}' answered ${result.code}: ${JSON.stringify(result.body)}`);
              for (const v of result.body.schemaViolations ?? []) obs.rows.push({ id: d._id, field: v.field, reason: v.reason, value: v.value });
              obs.lines.push(...lines);
            }
            obs.valueSinks = obs.lines.join('\n');   // the response's own rows echo the value today and stay as they are
            return obs;
          },
        },
        'push (batch)': {
          perDocRows: false, counted: true,
          async arrive(space, docs, beside = {}) {
            const { result, lines } = await h.capturing(() => h.door.push('/batch-upsert', { ...beside, [family]: docs }, { spaceId: space, token: h.nextPeer() }));
            assert.equal(result.code, 200, `POST /batch-upsert answered ${result.code}: ${JSON.stringify(result.body)}`);
            return { rows: [], lines, history: null, batchCount: result.body[family].schemaViolations, valueSinks: lines.join('\n') };
          },
        },
        pull: {
          perDocRows: false, counted: false,
          async arrive(space, docs, beside = {}) {
            h.door.state.records = { [space]: { ...beside, [family]: docs } };
            const { out, lines, history } = await h.cycle();
            assert.equal(out.errors, 0, `the pull cycle failed: ${JSON.stringify(out)} ${lines.join(' | ')}`);
            return { rows: [], lines, history, batchCount: null, valueSinks: `${lines.join('\n')}\n${history}` };
          },
        },
        import: {
          perDocRows: true, counted: true,
          async arrive(space, docs, beside = {}) {
            const { result, lines } = await h.capturing(() => h.importMod.importDocuments(space, { ...beside, [family]: docs }));
            const reported = result.results[family].schemaViolations ?? [];
            const rows = reported.flatMap(r => r.violations.map(v => ({ id: r._id, field: v.field, reason: v.reason, value: v.value })));
            return { rows, lines, history: null, batchCount: reported.length, valueSinks: `${lines.join('\n')}\n${JSON.stringify(reported)}` };
          },
        },
      };
    },
  };
  return h;
}
