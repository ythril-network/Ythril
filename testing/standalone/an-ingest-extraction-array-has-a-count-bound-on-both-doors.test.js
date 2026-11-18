/**
 * An ingest `extraction` is refused when one of its arrays is past its count bound — on both doors, by the same parser (`Q-167`).
 *
 * ## The rule
 *
 * A caller-supplied extraction is written as it stands: every entity, claim, dated event and edge becomes a record, and the
 * validator walks every one first. Before `Q-167` the parser checked only that `extraction` was an object, so one request
 * could name a million claims and the instance would write a million records. Each array the `Extraction` type carries now has
 * a bound in `util/request-bounds.ts`; one entry past it is a 400 that names the array and the bound, answered before the
 * space is looked at, a model is asked or a record is written. REST (`beginIngest`) and MCP `ingest` both reach
 * `parseIngestRequest`, so one refusal covers both, and the tool schema states the same numbers as `maxItems`.
 *
 * ## What this reads, and from where
 *
 * The arrays come from the `Extraction` interface (`_extraction-arrays.mjs`), not from the bounds table: an array added to the
 * type and left out of the table is exactly what this must catch. The expected outcome of each row is hand-written here
 * (refused one past the bound, accepted at it), never the table compared with itself.
 *
 * Run: node --test testing/standalone/an-ingest-extraction-array-has-a-count-bound-on-both-doors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { extractionArrays } from './_extraction-arrays.mjs';
import { toolValidators } from './_validator-schemas.mjs';

let parseIngestRequest, BOUNDS;
before(async () => {
  ({ parseIngestRequest } = await import('../../server/dist/extractor/ingest.js'));
  BOUNDS = await import('../../server/dist/util/request-bounds.js');
});

const ARRAYS = extractionArrays();
const bodyWith = (name, n) => ({ kind: 'conversation', extraction: { conversationId: 'c', [name]: Array.from({ length: n }, () => ({})) } });
/** The bound the table names for an array — read through the one export both doors read. */
const boundOf = (name) => BOUNDS.INGEST_EXTRACTION_BOUNDS?.[name];

describe('an extraction array past its bound', () => {
  for (const name of ARRAYS) {
    it(`\`${name}\` has a bound, one past it is refused naming the array and the bound, at it is accepted`, () => {
      const max = boundOf(name);
      assert.ok(Number.isInteger(max) && max > 0, `\`extraction.${name}\` has no bound in INGEST_EXTRACTION_BOUNDS`);
      const over = parseIngestRequest(bodyWith(name, max + 1));
      assert.equal(over.ok, false, `\`extraction.${name}\` at ${max + 1} entries was accepted`);
      assert.match(over.error, new RegExp(`extraction\\.${name}\``), 'the refusal does not name the array');
      assert.ok(over.error.includes(String(max)), `the refusal does not state the bound ${max}: ${over.error}`);
      assert.ok(over.error.includes(String(max + 1)), `the refusal does not state the count it got: ${over.error}`);
      assert.equal(parseIngestRequest(bodyWith(name, max)).ok, true, `\`extraction.${name}\` at its bound ${max} was refused`);
    });
  }

  it('an array that is not an array is refused, not read as empty', () => {
    for (const name of ARRAYS) {
      const r = parseIngestRequest({ kind: 'conversation', extraction: { conversationId: 'c', [name]: 'many' } });
      assert.equal(r.ok, false, `\`extraction.${name}\` as a string was accepted`);
      assert.match(r.error, new RegExp(`extraction\\.${name}\``));
    }
  });

  it('the turns across the extraction\'s sessions are bounded as a raw conversation\'s are', () => {
    const turns = Array.from({ length: BOUNDS.MAX_INGEST_TURNS + 1 }, () => 'x');
    const r = parseIngestRequest({ kind: 'conversation', extraction: { conversationId: 'c', sessions: [{ date: '2023-05-10', turns }] } });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(String(BOUNDS.MAX_INGEST_TURNS)) && /turns/.test(r.error), r.error);
    const at = parseIngestRequest({ kind: 'conversation', extraction: { conversationId: 'c', sessions: [{ date: '2023-05-10', turns: turns.slice(1) }] } });
    assert.equal(at.ok, true);
  });
});

describe('the tool schema states the same bounds', () => {
  it('every array of the extraction type is declared under `extraction` with `maxItems` equal to the bound the parser enforces', () => {
    const tool = toolValidators().find(v => v.door === 'MCP ingest');
    assert.ok(tool, 'no MCP ingest tool in the registry');
    const props = tool.schema.properties?.extraction?.properties ?? {};
    const wrong = ARRAYS.flatMap(name => {
      const node = props[name];
      if (!node || node.type !== 'array') return [`\`extraction.${name}\` is not declared as an array in the tool schema`];
      return node.maxItems === boundOf(name) ? [] : [`\`extraction.${name}\`: maxItems ${node.maxItems ?? 'absent'}, the parser enforces ${boundOf(name)}`];
    });
    assert.deepEqual(wrong, []);
  });
});
