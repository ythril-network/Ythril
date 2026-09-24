/**
 * Replay an extraction file into a Ythril space. The deterministic half of ingestion.
 *
 * ## What makes this the half without a model
 *
 * Extraction reads a conversation and decides what is in it — that needs a model, it happens once, and its
 * output is committed. This takes that output and writes it. Same file in, same graph out, no judgement
 * anywhere. So anybody can rebuild the graph from the repository and check every record against the
 * transcript it came from, which is what makes an extraction produced inside an interactive session
 * reproducible at all.
 *
 * ## Written by the PRODUCT, not by this file (`F-31`)
 *
 * This used to write every record itself, one request each, in an order it chose. It now hands the extraction
 * to `ingest` — `POST /api/brain/spaces/:spaceId/ingest` with `{ kind: 'conversation', extraction }` — which
 * validates it with the same rules this file refused with (`validate-extraction.mjs` re-exports the server's)
 * and writes it through the batch door. So the space a benchmark measures is written exactly as a user's
 * conversation is, and the write order, the edge-end kinds, the attributed claim written unranked and the
 * retirement mark live in ONE writer (`server/src/extractor/conversation/write-extraction.ts`) rather than two.
 *
 * The file is still validated HERE first, so a malformed extraction fails before a space is created.
 *
 * ## The one thing that is written nowhere
 *
 * `sourceTurns`. It says which turns of the transcript a claim came from and it exists so a benchmark can
 * join a result back to an answer key. The run REPORTS it and no record stores it: every property is folded
 * into the text that gets embedded, so a turn id inside a claim is thirty tokens of unique noise in every
 * vector in the space, and no user of the product has one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertWritable } from './validate-extraction.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SPACE_DIR = join(here, '..', 'space');

/** The schema, the purpose and the usage notes — everything a space is created with. */
export function loadSpaceDefinition() {
  const entries = JSON.parse(readFileSync(join(SPACE_DIR, 'schema.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('space/schema.json is empty. A space created with no declared types validates NOTHING '
      + 'under strict mode, so every malformed record would be accepted and the corpus would look clean.');
  }
  const typeSchemas = {};
  for (const e of entries) {
    (typeSchemas[e.knowledgeType] ??= {})[e.typeName] = e.schema;
  }
  return {
    entries,
    typeSchemas,
    purpose: readFileSync(join(SPACE_DIR, 'purpose.md'), 'utf8').trim(),
    usageNotes: readFileSync(join(SPACE_DIR, 'usage-notes.md'), 'utf8').trim(),
  };
}

/**
 * Write one extraction into one space.
 *
 * @param {object} args
 * @param {object} args.extraction  a parsed extraction file
 * @param {object} args.ythril      a client from `ythril-client.mjs`
 * @param {string} args.space       the space id to create and fill
 * @returns {Promise<{records: number, sourceTurns: Map<string, string[]>}>}
 *   `sourceTurns` maps a written record's id to the turn ids it came from — claims, and also the entities
 *   and chrono entries whose content was synthesised from the transcript. Held by the caller, stored nowhere.
 */
export async function writeSpace({ extraction, ythril, space }) {
  const { entries, typeSchemas, purpose, usageNotes } = loadSpaceDefinition();
  assertWritable(extraction, entries);

  await ythril.createSpace(space, { typeSchemas, purpose, usageNotes });

  const { runId } = await ythril.ingest(space, { kind: 'conversation', extraction });
  // Throws on a failed run or a partial one: a score over a partial corpus is a wrong number, not a low one.
  const run = await ythril.waitForIngest(space, runId);
  const records = Object.values(run.written ?? {}).reduce((n, v) => n + v, 0);
  return { records, sourceTurns: new Map(Object.entries(run.sourceTurns ?? {})) };
}
