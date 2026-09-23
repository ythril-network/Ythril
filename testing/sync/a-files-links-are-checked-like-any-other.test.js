/**
 * A FILE's arriving links are checked for strict-linkage violations, like a fact's and a chrono entry's.
 *
 * `Q-39`. `checkLinkViolations` opened with `if (link.fromKind !== 'fact' && link.fromKind !== 'chrono')
 * return;`, so a link arriving FROM a file was not checked at all — and a peer sending a file linked to an
 * entity this instance does not hold was recorded as nothing whatsoever. An operator reads an empty
 * violation list as everything being fine, which is the failure this file exists to prevent: the absence of
 * a record and the absence of a problem look identical.
 *
 * WHY THIS IS A WIRE TEST AND NOT A SOURCE GATE. A gate asserting the narrowing is gone would pass the
 * moment somebody deleted the line, whether or not the violation is then recorded, whether or not the
 * document it writes is accepted by its own type, and whether or not the conflicts route will serve it. All
 * three had to move together for `file` to be a docType, so the assertion has to be made on the far side of
 * all three.
 *
 * `general` carries no `meta`, and `isStrictLinkage` reads `meta?.strictLinkage !== false` — so strict
 * linkage is ON for it by default and this file needs no space setup. Stated here because a reader looking
 * for the missing arrangement will otherwise assume it was forgotten.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { INSTANCES, post, get, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let token;
const RUN = Date.now();

before(() => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

/** One arriving link, shaped as `IncomingLinkDoc` requires. */
function linkDoc({ from, fromKind, to, toKind }) {
  return {
    _id: randomUUID(),
    spaceId: 'general',
    from,
    fromKind,
    to,
    toKind,
    author: { instanceId: 'test', instanceLabel: 'Test' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seq: 1,
  };
}

/**
 * Find the violation this instance recorded for one link's `from` id.
 *
 * The check is deliberately fire-and-forget at the ingest site — a refusal there would hold the sync
 * watermark and stop the channel — so the write lands AFTER the POST has answered. Polling is the
 * honest read; asserting immediately would be asserting on a race.
 */
async function violationFor(docId) {
  let found;
  await waitFor(async () => {
    const r = await get(INSTANCES.a, token, '/api/conflicts/link-violations');
    if (r.status !== 200) return false;
    found = (r.body.violations ?? []).find(v => v.docId === docId);
    return !!found;
  }, 10_000, 250);
  return found;
}

describe('a link arriving FROM a file is checked like any other', () => {
  it('records a violation when the file links to an entity this instance does not hold', async () => {
    const filePath = `q39/${RUN}/absent-target.md`;
    const missingEntity = randomUUID();

    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      links: [linkDoc({ from: filePath, fromKind: 'file', to: missingEntity, toKind: 'entity' })],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const v = await violationFor(filePath);
    assert.ok(v, `no link violation recorded for the file ${filePath} — it was ingested and never checked`);
    assert.equal(v.docType, 'file', 'the violating document is a file, and the record has to say so');
    assert.equal(v.field, 'file.entity');
    assert.match(v.reason, new RegExp(missingEntity), 'the reason names the target that does not exist');
  });

  it('records nothing when the file links to an entity that IS here', async () => {
    const filePath = `q39/${RUN}/present-target.md`;

    const entityId = randomUUID();
    const e = await post(INSTANCES.a, token, '/api/sync/entities?spaceId=general', {
      _id: entityId, spaceId: 'general', name: `q39-present-${RUN}`, type: 'concept',
      embedding: [], tags: [], properties: {},
      author: { instanceId: 'test', instanceLabel: 'Test' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      seq: 1, embeddingModel: 'none',
    });
    assert.equal(e.status, 200, JSON.stringify(e.body));

    const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=general', {
      links: [linkDoc({ from: filePath, fromKind: 'file', to: entityId, toKind: 'entity' })],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    /*
     * A negative assertion on a fire-and-forget write needs a WAIT, or it passes because the check had not
     * run yet rather than because it found nothing. The positive case above establishes that ten seconds is
     * long enough for one to land; this waits the same way and then requires the list to be clean.
     */
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const list = await get(INSTANCES.a, token, '/api/conflicts/link-violations');
    assert.equal(list.status, 200);
    const v = (list.body.violations ?? []).find(x => x.docId === filePath);
    assert.equal(v, undefined, 'a resolvable link must not be reported as a violation');
  });
});
