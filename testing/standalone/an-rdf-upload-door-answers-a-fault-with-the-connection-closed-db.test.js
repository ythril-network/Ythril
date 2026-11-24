/**
 * A server fault met while an RDF upload is still arriving is answered 500 with `Connection: close`, and the rest of the body is read, at the RDF
 * import door and at the schema-from-RDF door (bundle-270, Q-953, review finding F2).
 *
 * ## What it holds
 *
 * The upload reader never destroys the request (a refused sender must read its answer). A refusal closes the connection and drains the rest of
 * the body (`api/rdf-upload-refusal.ts`), but a fault that is not a refusal (a disk error in the spool, a store failure) went to
 * `sendCaughtFailure` with neither: a 500 on a keep-alive connection whose body was half read and paused, the socket held until Node's request
 * timeout. Both doors now answer such a fault as they answer a refusal of an unread body:
 *
 * - the sender still sending reads `500` with `Connection: close` and is not reset (`reset === false`).
 *
 * The fault is a read of the config that throws, armed for one request (`schemaLibraryNamespaces`, which the act reads when it judges the
 * space's state, after the door's guards and before a byte of the body is read). The pace is set through the knob and reset after every case.
 *
 * Run: node --test testing/standalone/an-rdf-upload-door-answers-a-fault-with-the-connection-closed-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, MEDIA } from './_schema-rdf-import-doors.mjs';
import { pacedSender, setPace, resetPace, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const IMPORT = 'rdffaultimport';
const TARGET = 'rdffaulttarget';
const SOURCE_TYPES = { entity: { person: { propertySchemas: { name: { type: 'string' } } } } };
/** A pace no case here meets: the sender is answered for the fault, never for its pace. */
const UNHURRIED = { idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 };

describe('a fault met while an RDF upload arrives is answered with the connection closed (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, admin;
  before(async () => {
    d = await openSchemaRdfImportDoors({ suite: 'rdf_fault', spaces: [spaceWith(IMPORT, SOURCE_TYPES), spaceWith(TARGET, undefined)] });
    admin = await d.mint('rdf-fault-admin', {}, { admin: true });
  });
  after(async () => { resetPace(); await d?.close(); });
  afterEach(() => resetPace());

  /** Make the act's read of the config's library namespaces throw while `run` runs, and put the config back. */
  async function withFault(run) {
    const cfg = d.loader.getConfig();
    Object.defineProperty(cfg, 'schemaLibraryNamespaces', { configurable: true, enumerable: true, get() { throw new Error('injected fault while the upload arrives'); } });
    try { return await run(); } finally { delete cfg.schemaLibraryNamespaces; }
  }

  /** An upload to `url` that keeps sending a comment line every 40 ms. */
  const sending = (url) => pacedSender(url, {
    headers: { Authorization: `Bearer ${admin.key}`, 'Content-Type': MEDIA.turtle }, first: '# a file sent while the server fails\n', piece: '#xxxxxx\n', everyMs: 40,
  });

  const DOORS = {
    'the RDF import door': () => `${d.server.url}/api/brain/spaces/${IMPORT}/import/rdf`,
    'the schema-from-RDF door': () => `${d.server.url}/api/spaces/${TARGET}/schema-rdf?${new URLSearchParams({ mode: 'generate', sourceBase: baseOf(IMPORT), dryRun: 'true', format: 'turtle' })}`,
  };

  for (const [name, urlOf] of Object.entries(DOORS)) {
    it(`${name}: a fault before the body is read is 500 with Connection: close, read whole by a sender still sending (F2)`, async () => {
      setPace(UNHURRIED);
      const answer = await withFault(async () => {
        const up = sending(urlOf());
        try { return await answeredWithin(up, 15_000, 'the upload met by a fault to be answered'); } finally { up.stop(); }
      });
      assert.equal(answer.reset, false, `the sender still sending never read the answer: ${answer.error}`);
      assert.equal(answer.status, 500, `${answer.status} ${answer.text.slice(0, 300)}`);
      assert.match(String(answer.headers.connection ?? ''), /close/i, 'the sender of an unread body keeps its connection after a fault');
    });
  }
});
