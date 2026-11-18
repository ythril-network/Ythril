/**
 * `update_space` refused because the space already holds face descriptors answers the refusal's own 409 and its sentence behind ONE
 * `Error: `, on the MCP door and on `POST /api/update_space` (found while moving every tool error text onto one module, Q-339).
 *
 * ## The finding
 *
 * The tool built the whole text itself (`Error (409): Space ... already holds ...`) and threw it as a plain `Error`. The dispatcher
 * answers a thrown `Error` as an unknown failure and writes the prefix itself, so the caller read `Error: Error (409): Space ...` with
 * the status of a failure nobody classified: the 409 was in the words and not in the answer. `PATCH /api/spaces/:id` answers the same
 * refusal as a 409, so the two doors of one rule disagreed about its status.
 *
 * ## What is held, on both transports
 *
 *  - the call is refused with status 409;
 *  - the text starts `Error: Space '<id>' already holds`, and the word `Error` stands in it once;
 *  - the width was not changed.
 *
 * ## Seen red
 *
 * On 631c10f8 the text is `Error: Error (409): Space 'facewidthspace' already holds 1 face descriptor(s) ...` and the status is not 409.
 *
 * Run: a Mongo the harness accepts (`_mongo-harness.mjs`), then node --test <this file> (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'facewidthspace';
/** A width other than the default one, so the request is a change and the state check runs. */
const OTHER_WIDTH = 512;

let door;

describe('a face-width change refused by the space\'s state, on the tool door', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'facewidthtool', spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    const { col } = await import('../../server/dist/db/mongo.js');
    const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
    const { FACE_DESCRIPTOR_DIMS } = await import('../../server/dist/files/media/face-descriptor.js');
    assert.notEqual(OTHER_WIDTH, FACE_DESCRIPTOR_DIMS, 'the requested width is the default one: the request would change nothing and never reach the check');
    // One stored face descriptor is the state the rule refuses on; the rule counts rows that carry the field.
    await col(spaceCollection(SPACE, 'files')).insertOne({ _id: 'face-row-1', spaceId: SPACE, path: 'a.jpg', faceEmbedding: [0.1, 0.2] });
  });
  after(async () => { await door?.close(); });

  for (const transport of ['mcp', 'rest']) {
    describe(`transport ${transport}`, () => {
      let out;
      before(async () => { out = await door.call('update_space', { space: SPACE, faceDescriptorDims: OTHER_WIDTH }, { transport }); });

      it('is refused with the refusal\'s own status, 409', () => {
        assert.equal(out.result.isError, true, `the change was not refused: ${out.text.slice(0, 200)}`);
        assert.equal(out.status, 409, `the refusal answered status ${out.status}: ${out.text.slice(0, 200)}`);
      });

      it('says its sentence behind one prefix', () => {
        assert.ok(out.text.startsWith(`Error: Space '${SPACE}' already holds 1 face descriptor(s)`), `the text is: ${out.text.slice(0, 200)}`);
        assert.equal(out.text.match(/\bError\b/g)?.length, 1, `the word Error stands in the text more than once: ${out.text.slice(0, 200)}`);
      });
    });
  }

  it('the width was not changed', async () => {
    const { getConfig } = await import('../../server/dist/config/loader.js');
    assert.equal(getConfig().spaces.find(s => s.id === SPACE)?.faceDescriptorDims, undefined);
  });
});
