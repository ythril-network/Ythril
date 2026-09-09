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
 * ## Order, and why it is not arbitrary
 *
 * Entities, then chrono, then claims, then edges, then the transcript. Each step names records the step
 * before it created:
 *
 *  - a chrono entry links to entities;
 *  - a claim links to entities and chrono entries;
 *  - an edge needs both of its ends to exist, and the instance refuses one that does not resolve;
 *  - the transcript names the claims it produced, so it goes last of all.
 *
 * Written out because getting it wrong does not fail loudly. A link to a record that does not exist yet is
 * dropped, the record is stored, and the space ends up holding a graph with holes in it that reads as a
 * finding about retrieval.
 *
 * ## The one thing that is written nowhere
 *
 * `sourceTurns`. It says which turns of the transcript a claim came from and it exists so a benchmark can
 * join a result back to an answer key. It is returned to the caller in a side map and stored in no record:
 * every property is folded into the text that gets embedded, so a turn id inside a claim is thirty tokens of
 * unique noise in every vector in the space, and no user of the product has one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeYthril } from './ythril-client.mjs';
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
 *   `sourceTurns` maps a written claim's id to the turn ids it came from. Held by the caller, stored nowhere.
 */
export async function writeSpace({ extraction, ythril, space }) {
  const { entries, typeSchemas, purpose, usageNotes } = loadSpaceDefinition();
  assertWritable(extraction, entries);

  await ythril.createSpace(space, { typeSchemas, purpose, usageNotes });

  const entityId = new Map();
  const chronoId = new Map();
  const claimIdsBySession = new Map();
  const entityKeysBySession = new Map();
  const sourceTurns = new Map();
  let records = 0;

  /* ── 1. entities ───────────────────────────────────────────────────────────────────────────────────── */
  for (const e of extraction.entities ?? []) {
    const created = await ythril.writeEntity(space, {
      name: e.name,
      type: e.type,
      ...(e.properties && Object.keys(e.properties).length > 0 ? { properties: e.properties } : {}),
    });
    entityId.set(e.key, created.id ?? created._id);
    records++;
  }

  /* ── 2. chrono ─────────────────────────────────────────────────────────────────────────────────────── */
  for (const c of extraction.chrono ?? []) {
    const linked = (c.entities ?? []).map(k => entityId.get(k));
    const created = await ythril.writeChrono(space, {
      title: c.title,
      type: c.type,
      // The extraction format says `date` because that is what it is to whoever writes one; the store calls
      // it `startsAt`. Mapping here rather than making the model-facing contract speak the store's field
      // names is the whole reason this layer exists.
      startsAt: c.date,
      ...(c.description ? { description: c.description } : {}),
      ...(linked.length > 0 ? { entityIds: linked } : {}),
    });
    chronoId.set(c.key, created.id ?? created._id);
    records++;
  }

  /* ── 3. claims ─────────────────────────────────────────────────────────────────────────────────────── */
  for (const c of extraction.claims ?? []) {
    const linked = (c.entities ?? []).map(k => entityId.get(k));
    const created = await ythril.writeMemory(space, {
      fact: c.text,
      type: claimTypeName(entries),
      properties: { speaker: c.speaker, statedOn: c.statedOn },
      ...(linked.length > 0 ? { entityIds: linked } : {}),
    });
    const id = created.id ?? created._id;
    records++;

    // The side map, and the only place these ever live.
    sourceTurns.set(id, c.sourceTurns ?? []);

    // A claim is filed under the session it was said in, so the transcript can name it later.
    const bucket = claimIdsBySession.get(c.statedOn) ?? [];
    bucket.push(id);
    claimIdsBySession.set(c.statedOn, bucket);
    const seen = entityKeysBySession.get(c.statedOn) ?? new Set();
    for (const k of c.entities ?? []) seen.add(k);
    entityKeysBySession.set(c.statedOn, seen);
  }

  /* ── 4. edges ──────────────────────────────────────────────────────────────────────────────────────── */
  for (const e of extraction.edges ?? []) {
    await ythril.writeEdge(space, {
      from: entityId.get(e.from),
      to: entityId.get(e.to),
      label: e.label,
      ...(e.properties && Object.keys(e.properties).length > 0 ? { properties: e.properties } : {}),
    });
    records++;
  }

  /* ── 5. the transcripts ────────────────────────────────────────────────────────────────────────────── */
  for (const s of extraction.sessions ?? []) {
    if (!s.text) continue;   // a session whose verbatim text was not carried through; nothing to quote from
    const claims = claimIdsBySession.get(s.date) ?? [];
    const keys = [...(entityKeysBySession.get(s.date) ?? [])];
    const links = {
      ...(claims.length > 0 ? { memoryIds: claims } : {}),
      ...(keys.length > 0 ? { entityIds: keys.map(k => entityId.get(k)) } : {}),
    };
    await ythril.writeFile(space, {
      path: `transcripts/${s.date}.md`,
      content: s.text,
      tags: ['transcript'],
      ...(Object.keys(links).length > 0 ? { links } : {}),
    });
    records++;
  }

  return { records, sourceTurns };
}

/**
 * The claim type's name, read from the schema rather than spelled here.
 *
 * A literal would be a second copy of a name the schema already holds, and it would be wrong the day the
 * schema renamed it — the writer would then send an undeclared type and every claim would 400.
 */
function claimTypeName(entries) {
  const claim = entries.find(e => e.knowledgeType === 'memory');
  if (!claim) throw new Error('space/schema.json declares no memory type, so there is nowhere to put a claim');
  return claim.typeName;
}
