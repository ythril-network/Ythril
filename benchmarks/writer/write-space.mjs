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
 *   `sourceTurns` maps a written record's id to the turn ids it came from — claims, and also the entities
 *   and chrono entries whose content was synthesised from the transcript. Held by the caller, stored nowhere.
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
    const eid = created.id ?? created._id;
    entityId.set(e.key, eid);
    /*
     * An entity's description is SYNTHESISED — it says what the conversation established about a subject,
     * drawn from every session that mentioned it. A synthesised record with no provenance is unusable twice
     * over: nobody can check it, and nothing can credit the turns it was built from. So it carries the same
     * side map a claim does.
     */
    if ((e.sourceTurns ?? []).length > 0) sourceTurns.set(eid, e.sourceTurns);
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
    const cid = created.id ?? created._id;
    chronoId.set(c.key, cid);
    // Same reason as the entity above: a dated event was established by particular turns.
    if ((c.sourceTurns ?? []).length > 0) sourceTurns.set(cid, c.sourceTurns);
    records++;
  }

  /* ── 3. claims ─────────────────────────────────────────────────────────────────────────────────────── */
  for (const c of extraction.claims ?? []) {
    const linked = (c.entities ?? []).map(k => entityId.get(k));
    const created = await ythril.writeMemory(space, {
      fact: c.text,
      type: claimTypeName(entries),
      /*
       * `attributed` rides in `properties` because that is already where `speaker` lives, and because a
       * declared property is filterable on BOTH doors with no new parameter — `recall`'s filter takes a
       * real predicate over properties, and so does `filter`.
       *
       * Written only when true. A property present-and-false and a property absent are different rows to
       * every predicate anybody writes, and the overwhelming majority of claims are a person's: absence
       * is the default, so the default costs nothing to store and nothing to query around.
       */
      properties: {
        speaker: c.speaker,
        statedOn: c.statedOn,
        ...(c.attributed === true ? { attributed: true } : {}),
      },
      /*
       * AN ATTRIBUTED CLAIM IS STORED WITHOUT A VECTOR, so it can never win a ranked slot.
       *
       * Owner's decision, 2026-09-19: a model's contribution must not compete for space in an answer
       * somebody asked a question to get — *"(2) fills context very often with stuff thats not
       * interesting"* — and must not be hidden either. Suppression is the one mechanism that is both:
       * `recall` cannot rank a record with no vector even deliberately, while `filter`, `graph_traverse`
       * and recall's own expansion still reach it in full, because the walk follows links and never
       * consults a vector. Verified against a live instance in
       * `a-suppressed-record-is-unranked-but-still-reached.test.js`, which is the gate that was missing.
       *
       * DERIVED from the mark rather than set beside it. Two fields meaning one thing drift, and the one
       * that drifts here is the one nobody can see: a claim marked attributed but still carrying a vector
       * is back to competing for slots, silently.
       */
      ...(c.attributed === true ? { suppressEmbeddings: true } : {}),
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
  const claim = entries.find(e => e.knowledgeType === 'fact');
  if (!claim) throw new Error('space/schema.json declares no fact type, so there is nowhere to put a claim');
  return claim.typeName;
}
