/**
 * Phase 10 of the conversation extractor — write an extraction into a space (`F-31`, DECOMPOSITION.md 10). The
 * server port of `benchmarks/writer/write-space.mjs`: same file in, same graph out, no judgement anywhere.
 *
 * ## Through the batch door, never the bare writers
 *
 * `saveFact`, `upsertEntity` and the rest do not validate. Schema validation, strict linkage, the shape and
 * value rules and the record flags are applied by the DOOR that calls them — so an `ingest` that called them
 * directly would store exactly what every other door refuses, and nothing would say so. Every record here goes
 * through `bulkWrite`, the door `POST /bulk` and `save_bulk` already share, and the ids come back in its
 * `refs`. The door is injected so a test can see what it was asked.
 *
 * ## Order, and why it is not arbitrary
 *
 * Entities, claims, chrono, edges, transcripts — each names ids the step before minted. One batch per step,
 * never one call for everything, because a batch runs facts before entities and a `$ref` cannot point forwards:
 * a claim naming an entity from the same call would resolve to nothing. A step larger than the door's cap is
 * SPLIT — the door drops item 501 onwards without an error, so a truncated step would read as a smaller graph.
 *
 * ## What differs from the benchmark writer, and why each is the product's call
 *
 * - **Into an existing space.** The benchmark creates one per run; `ingest` writes into the caller's, so an
 *   entity the space already held (`existingEntities`) is linked by id and never written again, and a
 *   transcript's path carries the conversation so two conversations cannot overwrite each other's.
 * - **An entity's description is written.** The format requires one and the benchmark writer never sent it —
 *   a bare name embeds as a word or two and answers nothing.
 * - **A chrono entry links the claims that dated it** (`claim.chrono`), which the format carries and the
 *   benchmark writer ignored.
 *
 * ## The one thing written nowhere
 *
 * `sourceTurns`: returned keyed by record id, stored in no record — every property is folded into the embedded
 * text, and a turn id is noise in every vector of the space.
 */
import { bulkWrite, BULK_MAX_PER_TYPE, type BulkInput, type BulkResult } from '../../brain/bulk.js';
import { storeFile } from '../../files/store-file.js';
import { updateFileMeta } from '../../files/file-meta.js';
import { assertWritable, type SchemaEntry } from '../validate-extraction.js';
import type { Extraction } from './assemble.js';

export interface ExtractionWriters {
  bulk: (spaceId: string, input: BulkInput) => Promise<Pick<BulkResult, 'errors' | 'refs'>>;
  storeFile: (spaceId: string, path: string, bytes: Buffer, opts: { meta: { tags: string[] } }) => Promise<unknown>;
  linkFile: (spaceId: string, path: string, links: { linkEntities?: string[]; linkFacts?: string[] }) => Promise<unknown>;
}

const DOOR: ExtractionWriters = {
  bulk: bulkWrite,
  storeFile: (spaceId, path, bytes, opts) => storeFile(spaceId, path, bytes, opts),
  linkFile: (spaceId, path, links) => updateFileMeta(spaceId, path, links),
};

export interface WriteError { phase: 'entities' | 'claims' | 'chrono' | 'edges' | 'transcripts'; key?: string; reason: string }

export interface WriteOutcome {
  written: { entities: number; claims: number; chrono: number; edges: number; transcripts: number };
  /** Every key the extraction named, and the id it now has — written here, or already in the space. */
  ids: Record<string, string>;
  /** Record id → the turns it came from. Held by the caller, stored nowhere. */
  sourceTurns: Record<string, string[]>;
  errors: WriteError[];
}

type Item = Record<string, unknown>;

/** A claim's `$ref`: its own key when an edge names it, otherwise its position — unique either way. */
const claimRef = (c: { key?: string }, i: number) => c.key ?? `claim#${i}`;

export async function writeExtraction(
  spaceId: string,
  extraction: Extraction,
  opts: { schemaEntries: SchemaEntry[]; claimType: string },
  writers: ExtractionWriters = DOOR,
): Promise<WriteOutcome> {
  // Refused before a single record is written — a half-written conversation is worse than none.
  assertWritable(extraction, opts.schemaEntries);

  const ids: Record<string, string> = Object.fromEntries((extraction.existingEntities ?? []).map(e => [e.key, e.id]));
  const sourceTurns: Record<string, string[]> = {};
  const errors: WriteError[] = [];
  const written = { entities: 0, claims: 0, chrono: 0, edges: 0, transcripts: 0 };
  const idsOf = (keys: string[] | undefined) => (keys ?? []).flatMap(k => (ids[k] ? [ids[k]!] : []));

  /** One step through the door, split at its cap; `keyOf` names an item in an error. */
  const step = async (phase: WriteError['phase'], collection: keyof BulkInput, items: Item[], keyOf: (i: number) => string | undefined) => {
    for (let at = 0; at < items.length; at += BULK_MAX_PER_TYPE) {
      const r = await writers.bulk(spaceId, { [collection]: items.slice(at, at + BULK_MAX_PER_TYPE) });
      for (const [key, ref] of Object.entries(r.refs ?? {})) ids[key] = ref.id;
      for (const e of r.errors) {
        const key = keyOf(at + e.index);
        errors.push({ phase, ...(key !== undefined ? { key } : {}), reason: e.reason });
      }
    }
    return items.length - errors.filter(e => e.phase === phase).length;
  };

  /* ── entities ── */
  const entities = extraction.entities ?? [];
  written.entities = await step('entities', 'entities', entities.map(e => ({
    $ref: e.key, name: e.name, type: e.type, description: e.description,
    ...(e.properties && Object.keys(e.properties).length ? { properties: e.properties } : {}),
  })), i => entities[i]?.key);
  for (const e of entities) if (ids[e.key] && e.sourceTurns?.length) sourceTurns[ids[e.key]!] = e.sourceTurns;

  /* ── claims ── */
  const claims = extraction.claims ?? [];
  written.claims = await step('claims', 'facts', claims.map((c, i) => {
    const linked = idsOf(c.entities);
    return {
      $ref: claimRef(c, i), fact: c.text, type: opts.claimType,
      // Written only when true: absent is the default, and present-and-false is a different row to a predicate.
      properties: { speaker: c.speaker, statedOn: c.statedOn, ...(c.attributed === true ? { attributed: true } : {}) },
      // An attributed claim is unranked, derived from the mark rather than set beside it — see write-space.mjs.
      ...(c.attributed === true ? { suppressEmbeddings: true } : {}),
      ...(c.superseded === true ? { superseded: true } : {}),
      ...(linked.length ? { linkEntities: linked } : {}),
    };
  }), i => claims[i]?.key);
  claims.forEach((c, i) => { const id = ids[claimRef(c, i)]; if (id) sourceTurns[id] = c.sourceTurns ?? []; });

  /* ── chrono ── */
  const chrono = extraction.chrono ?? [];
  written.chrono = await step('chrono', 'chrono', chrono.map(c => {
    const linkEntities = idsOf(c.entities);
    const linkFacts = claims.flatMap((cl, i) => (cl.chrono?.includes(c.key) && ids[claimRef(cl, i)] ? [ids[claimRef(cl, i)]!] : []));
    return {
      $ref: c.key, title: c.title, type: c.type, startsAt: c.date, status: c.status,
      ...(c.endsAt ? { endsAt: c.endsAt } : {}),
      ...(linkEntities.length ? { linkEntities } : {}),
      ...(linkFacts.length ? { linkFacts } : {}),
    };
  }), i => chrono[i]?.key);
  for (const c of chrono) if (ids[c.key] && c.sourceTurns?.length) sourceTurns[ids[c.key]!] = c.sourceTurns;

  /* ── edges ── an end is a bare key, so the key says which collection it is in, and the door is told. */
  const kindOf = new Map<string, 'fact' | 'chrono'>([
    ...claims.flatMap((c, i) => [[claimRef(c, i), 'fact'] as const]),
    ...chrono.map(c => [c.key, 'chrono'] as const),
  ]);
  const edges = (extraction.edges ?? []).filter(e => {
    if (ids[e.from] && ids[e.to]) return true;
    // An end that was refused above: sending it would store an edge pointing at nothing, or be refused again.
    errors.push({ phase: 'edges', key: `${e.from} ${e.label} ${e.to}`, reason: `an end was not written (${ids[e.from] ? e.to : e.from})` });
    return false;
  });
  written.edges = await step('edges', 'edges', edges.map(e => ({
    from: ids[e.from], to: ids[e.to], label: e.label,
    ...(kindOf.has(e.from) ? { fromKind: kindOf.get(e.from) } : {}),
    ...(kindOf.has(e.to) ? { toKind: kindOf.get(e.to) } : {}),
    ...(e.properties && Object.keys(e.properties).length ? { properties: e.properties } : {}),
  })), i => edges[i] && `${edges[i]!.from} ${edges[i]!.label} ${edges[i]!.to}`);

  /* ── transcripts ── by SESSION, not by day: several sessions can share a date (`validateExtraction` refuses a collision). */
  for (const s of extraction.sessions ?? []) {
    if (!s.text) continue;
    const sessionKey = s.key ?? s.date;
    const said = claims.flatMap((c, i) => ((c.session ?? c.statedOn) === sessionKey ? [[c, i] as const] : []));
    const linkFacts = said.flatMap(([c, i]) => (ids[claimRef(c, i)] ? [ids[claimRef(c, i)]!] : []));
    const linkEntities = [...new Set(said.flatMap(([c]) => idsOf(c.entities)))];
    const path = `transcripts/${extraction.conversationId}/${sessionKey}.md`;
    try {
      await writers.storeFile(spaceId, path, Buffer.from(s.text, 'utf8'), { meta: { tags: ['transcript'] } });
      if (linkFacts.length || linkEntities.length) {
        await writers.linkFile(spaceId, path, { ...(linkFacts.length ? { linkFacts } : {}), ...(linkEntities.length ? { linkEntities } : {}) });
      }
      written.transcripts++;
    } catch (err) {
      errors.push({ phase: 'transcripts', key: sessionKey, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { written, ids, sourceTurns, errors };
}
