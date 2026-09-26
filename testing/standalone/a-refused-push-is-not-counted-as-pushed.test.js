/**
 * A record the receiver refused is not counted as pushed, and the cycle says it did not complete (`Q-59`).
 *
 * Found 2026-09-26 joining ythril-home to the feedback club: home's space had no chrono schema, so every
 * `flow-observation` dev pushed was refused inside the batch, while dev's sync history said `pushed chrono: 50`,
 * `status: success`. The receiver counted the refusal (`unknownType`) and answered 200; the sender read only the
 * status. The watermark still advances, deliberately (`sync/push-refusals.ts` records why); what changes is that the
 * count and the history tell the truth.
 *
 * Run: node --test testing/standalone/a-refused-push-is-not-counted-as-pushed.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let P;
before(async () => { P = await import('../../server/dist/sync/push-refusals.js'); });

const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('the sender reads what the peer refused', () => {
  it('returns the rejected count for the family it pushed', async () => {
    assert.equal(await P.reportPushRefusals(reply({ chrono: { upserted: 0, unknownType: 50, rejected: 50 } }), 'chrono', 'home', 'fb', 50), 50);
  });
  it('an older peer that sends only forkDepthRefused is still read', async () => {
    assert.equal(await P.reportPushRefusals(reply({ facts: { forkDepthRefused: 2 } }), 'facts', 'home', 'fb', 10), 2);
  });
  it('a peer claiming more than the batch cannot make pushed negative, and a bad body counts nothing', async () => {
    assert.equal(await P.reportPushRefusals(reply({ edges: { rejected: 999 } }), 'edges', 'home', 'fb', 5), 5);
    assert.equal(await P.reportPushRefusals(new Response('not json', { status: 200 }), 'edges', 'home', 'fb', 5), 0);
  });
  it('a refusal becomes an incomplete-transfer entry with its count', () => {
    assert.deepEqual(P.refusedTransfers({ facts: { refused: 0 }, chrono: { refused: 50 } }), ['chrono: 50 refused by the peer']);
  });
});

describe('both ends are wired', () => {
  it('the receiver reports `rejected` for every family it answers for', () => {
    const src = stripComments(readFileSync('server/src/api/sync/docs.ts', 'utf8'));
    const at = src.indexOf("status: 'ok',");
    assert.ok(at > -1, 'the batch-upsert reply is gone — re-anchor this gate');
    const body = src.slice(at, src.indexOf('});', at));
    const families = [...body.matchAll(/^\s*(\w+):/gm)].map(m => m[1]).filter(k => k !== 'status');
    assert.ok(families.length >= 6, `parsed ${families.length} families — the gate would pass on too few`);
    for (const f of families) assert.match(body, new RegExp(`${f}: \\{[^}]*rejected:`), `${f} answers without a rejected count`);
  });
  it('the engine subtracts the refused count and makes the cycle partial — without failing the member', () => {
    const src = stripComments(readFileSync('server/src/sync/engine.ts', 'utf8'));
    assert.match(src, /pushed \+= batch\.length - r;/);
    assert.match(src, /const refused = refusedTransfers\(pushed\)/);
    assert.doesNotMatch(src, /stoppedEarly\.push\(\.\.\.refusedTransfers/, 'a refusal in the incomplete list fails the member and raises its failure count');
    assert.match(src, /errors === 0 && refusals === 0 \? 'success'/);
  });
});
