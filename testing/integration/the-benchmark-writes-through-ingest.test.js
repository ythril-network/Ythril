/**
 * The benchmark writes its committed extractions through the product's `ingest` door (`F-31`), and a whole LoCoMo
 * conversation arrives complete: every claim written, none refused, and every claim's source turns reported back
 * so an answer key can be joined to what was ranked.
 *
 * This is what makes the benchmark measure the product: the space it scores is written exactly as a user's
 * conversation is, by one writer. A committed extraction is the input because it asks no model — so this runs on
 * any stack, and a failure is the door or the writer, never a model's mood.
 *
 * Run: node --test testing/integration/the-benchmark-writes-through-ingest.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, delWithBody, readCollection } from '../sync/helpers.js';
import { makeYthril } from '../../benchmarks/writer/ythril-client.mjs';
import { writeSpace } from '../../benchmarks/writer/write-space.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const SPACE = `bench-ingest-${Date.now()}`;
const EXTRACTION = path.join(__dirname, '..', '..', 'benchmarks', 'locomo', 'extractions', 'conv-26.json');

let token;
before(() => { token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });
after(async () => { await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {}); });

describe('a committed extraction, through ingest', () => {
  it('every claim is written and none refused, and each comes back with its turns', async () => {
    const extraction = JSON.parse(fs.readFileSync(EXTRACTION, 'utf8'));
    const ythril = makeYthril({ baseUrl: INSTANCES.a, token });
    // `waitForIngest` throws on a failed or partial run, so returning at all means nothing was refused.
    const { records, sourceTurns } = await writeSpace({ extraction, ythril, space: SPACE });
    assert.ok(records >= extraction.claims.length, `wrote ${records} records for ${extraction.claims.length} claims`);

    const facts = await readCollection(INSTANCES.a, token, SPACE, 'facts', { limit: 1 });
    assert.equal(facts.status, 200, JSON.stringify(facts.body));
    assert.equal(facts.body?.total, extraction.claims.length, 'every claim is in the space, once');
    // The join the benchmark scores by: every claim's record id maps back to the turns it was written from.
    const withTurns = [...sourceTurns.values()].filter(t => t.length > 0).length;
    assert.ok(withTurns >= extraction.claims.length, `${withTurns} records carry source turns, for ${extraction.claims.length} claims`);
  });
});
