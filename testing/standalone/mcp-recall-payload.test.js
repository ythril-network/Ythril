/**
 * MCP recall response size — what the caller pays for.
 *
 * An MCP result is read by a language model, so **every field is multiplied by `topK` and billed as
 * tokens to whoever called the tool**. The REST caller is a program and can afford detail; the MCP caller
 * cannot. That asymmetry is the whole reason `toRecallRecord` exists rather than returning the result.
 *
 * These assert the SIZE, not the absence of particular fields. The claim being made is about cost, so a
 * test that only checked "field X is gone" would pass while something else grew back into its place.
 *
 * Run: node --test testing/standalone/mcp-recall-payload.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

let toRecallRecord;
before(async () => { ({ toRecallRecord } = await import('../../server/dist/mcp/tools/shared.js')); });

const CHUNK = 'Form NMK-SI-11 must be filed within 6 hours of discovering a data breach. '.repeat(12).trim();
const HEADING = 'Incident reporting';

/** A file-chunk result as recall produces it — the expensive and most common shape. */
const fileHit = i => ({
  _id: `f${i}#chunk3`, spaceId: 'dev-apps', type: 'file', score: 0.7 - i * 0.01,
  createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-02T11:00:00.000Z',
  seq: 100 + i, embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
  tags: ['auth', 'postmortem'], description: 'Runbook section', properties: { severity: 'high' },
  path: 'runbooks/NMK-SI-11.md', parentFileId: `f${i}`, chunkIndex: 3,
  headingText: HEADING, content: CHUNK, matchedText: `${HEADING} ${CHUNK}`,
});

const wrap = (r, includeContent) => ({
  score: r.score, spaceId: r.spaceId, type: r.type, record: toRecallRecord(r, { includeContent }),
});
const respond = includeContent =>
  JSON.stringify({ results: Array.from({ length: 10 }, (_, i) => wrap(fileHit(i), includeContent)), count: 10 });

/** The payload as it stood before this change: pretty-printed, with the passage returned twice. */
const BASELINE = JSON.stringify({
  results: Array.from({ length: 10 }, (_, i) => {
    const r = fileHit(i);
    return {
      score: r.score, spaceId: r.spaceId, type: r.type, matchedText: r.matchedText,
      record: {
        _id: r._id, createdAt: r.createdAt, updatedAt: r.updatedAt, seq: r.seq,
        embeddingModel: r.embeddingModel, tags: r.tags, description: r.description,
        properties: r.properties, path: r.path, parentFileId: r.parentFileId,
        chunkIndex: r.chunkIndex, headingText: r.headingText, content: r.content,
      },
    };
  }),
  count: 10,
}, null, 2);

describe('the default response is much smaller, and loses nothing', () => {
  it('is at least 40% smaller than the old shape', () => {
    const saved = 1 - respond(true).length / BASELINE.length;
    assert.ok(saved >= 0.4, `expected ≥40% smaller, got ${(saved * 100).toFixed(0)}%`);
  });

  it('still carries the passage — `content` is the field a caller asked for', () => {
    // The owner's call, 2026-07-29: "I want the content if not flagged false. matched text does not
    // interest me really." `content` is a named field with a defined meaning; `matchedText` was the
    // concatenated blob fed to the embedder, and for a file chunk it CONTAINED content — so the passage
    // was going back twice and the copy being kept was the worse one.
    const rec = toRecallRecord(fileHit(0), {});
    assert.equal(rec.content, CHUNK);
  });

  it('drops the blob, not the field', () => {
    const body = respond(true);
    assert.ok(!body.includes('"matchedText"'), 'matchedText must not appear in an MCP recall response');
    assert.ok(body.includes('"content"'), 'the passage must still be there');
    // The whole passage appears exactly once per result rather than twice. Counted on the full chunk,
    // not a phrase inside it — the fixture repeats its sentence, so a phrase count measures the fixture.
    const occurrences = body.split(JSON.stringify(CHUNK).slice(1, -1)).length - 1;
    assert.equal(occurrences, 10, 'the passage must be returned once per result, not twice');
  });

  it('drops `seq` and `embeddingModel`, which tell a model nothing', () => {
    // seq is the per-space counter sync orders replication by — never an input to any tool, read only by
    // sync/*. embeddingModel is identical for every record in a space: instance config, not a signal.
    const rec = toRecallRecord(fileHit(0), {});
    assert.equal(rec.seq, undefined);
    assert.equal(rec.embeddingModel, undefined);
  });

  it('keeps createdAt/updatedAt — they cost the same as seq and answer a real question', () => {
    const rec = toRecallRecord(fileHit(0), {});
    assert.equal(rec.createdAt, '2026-07-01T10:00:00.000Z');
    assert.equal(rec.updatedAt, '2026-07-02T11:00:00.000Z');
  });
});

describe('includeContent: false returns locations, not passages', () => {
  it('is at least 80% smaller than the old shape', () => {
    const saved = 1 - respond(false).length / BASELINE.length;
    assert.ok(saved >= 0.8, `expected ≥80% smaller, got ${(saved * 100).toFixed(0)}%`);
  });

  it('actually removes the passage — the parameter must not be decorative', () => {
    // It nearly shipped as a no-op: the first version dropped `record.content` while the passage was
    // still going back inside `matchedText` on the wrapper. Measuring the payload is what caught it;
    // asserting "content is undefined" would have passed.
    const body = respond(false);
    assert.ok(!body.includes('Form NMK-SI-11 must be filed'), 'no passage text may survive');
  });

  it('still identifies every hit, so the caller can fetch what it wants', () => {
    const rec = toRecallRecord(fileHit(0), { includeContent: false });
    assert.equal(rec._id, 'f0#chunk3');
    assert.equal(rec.path, 'runbooks/NMK-SI-11.md');
    assert.equal(rec.headingText, HEADING);
    assert.equal(rec.chunkIndex, 3);
    assert.deepEqual(rec.tags, ['auth', 'postmortem']);
  });

  it('does not strip a record whose text IS the record', () => {
    // A memory's `fact` is not a passage — removing it would leave a result that says nothing. The
    // parameter governs file chunk bodies, which is what the tool description promises.
    const mem = { _id: 'm1', spaceId: 's', type: 'fact', score: 0.9, fact: 'PKCE is required for all public clients.' };
    assert.equal(toRecallRecord(mem, { includeContent: false }).fact, 'PKCE is required for all public clients.');
  });
});

describe('no MCP tool pretty-prints its response', () => {
  it('indentation is billed to the caller and read by nothing', () => {
    /*
     * DERIVED from the tool directory, because the list was hand-written and had gone stale: `link.ts` and
     * `entity-cascade.ts` both pretty-printed a response and neither was on it. A subset that names the
     * files somebody remembered is a check on the files least likely to be wrong.
     */
    const files = readdirSync('server/src/mcp/tools')
      .filter(f => f.endsWith('.ts') && !['types.ts', 'index.ts', 'shared.ts'].includes(f))
      .map(f => f.replace(/\.ts$/, ''));
    assert.ok(files.length >= 8, `only ${files.length} tool file(s) found — the enumeration is broken`);
    for (const f of files) {
      const src = readFileSync(new URL(`../../server/src/mcp/tools/${f}.ts`, import.meta.url), 'utf8');
      assert.ok(!/JSON\.stringify\([^)]*,\s*null,\s*2\)/.test(src),
        `${f}.ts still pretty-prints an MCP response`);
    }
  });
});
