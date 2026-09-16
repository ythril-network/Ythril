/**
 * THE PROJECTION EVERY COLLECTION READ APPLIES — one object, because five readers each forgot it.
 *
 * ## What happened, and why this file exists rather than a review note
 *
 * `NEVER_RETURNED_FIELDS` in `recall-shape.ts` already said the right thing: *"a claim that absolute should
 * not rest on one projection being remembered at every fetch site."* It then rested on exactly that, and
 * five fetch sites did not remember it.
 *
 * The fleet integrator, 2026-08-19T0015Z §4: `GET /api/brain/spaces/<space>/entities?limit=500` returned every record's
 * embedding vector. **One read of their orchestrator space was 11.19 MB**, against 0.145 MB for the same 100
 * records through `POST /query`, which strips it by contract. They tried twelve parameter spellings looking
 * for the switch — `projection`, `fields`, `select`, `exclude`, `omit`, `includeEmbedding=false`,
 * `embedding=false`, `embedding=0`, `projection=-embedding`, `lean`, `slim`, `minimal` — and every one
 * returned the same 11.19 MB, which is the correct behaviour of a route that accepts no projection at all.
 *
 * It cost them a night. n8n holds every node's items in memory for a whole execution; their dispatcher made
 * three such reads per run for ~28 MB of items, sixteen ran at once, n8n died with *"possible out-of-memory
 * issue"*, and its database then answered `503 Database is not ready!` to about half of everything while
 * deploys could not land. They spent hours believing it was the unrelated recall fault.
 *
 * ## The part that is worse than the size, and it is the reason this is a hard rule
 *
 * We publish the opposite, absolutely, in three places a caller reads while constructing arguments:
 * `/query`'s own parameter description (*"always excluded and cannot be re-included"*), `recall`'s MCP
 * description (*"never returned by anything here, and no parameter can ask for it"*), and
 * `update_fact`'s. **An integrator who believed those sentences had no reason to look at a payload size.**
 * A stale absolute is invisible in a way a missing feature is not.
 *
 * So the vector is not withheld "by default". It is withheld, full stop, and there is no flag — which is
 * what those three sentences already promise and what this file makes true.
 *
 * ## Why a projection and not a strip after the read
 *
 * A post-read `delete` would move the bytes over the wire from Mongo first, and the wire from Mongo is where
 * 11 MB actually costs something. `withoutDiagnostics` still strips after the fact on the recall path, and
 * that is the belt to this braces — but a read that never asks for the field is the fix.
 */
import { NEVER_RETURNED_FIELDS } from './recall-shape.js';

/**
 * The record diagnostics a LIST route withholds by default — and `seq` is deliberately not among them.
 *
 * The canary operator 2026-08-17T1540Z §4, taking up an offer in the 3.1.0 notes: *"for exactly the reason
 * 3.1.0 withheld them on the retrieval door: matchedText is the passage a second time, and a list route is
 * the call most likely to be made in bulk."*
 *
 * **`seq` stays, on their explicit request**, because it is the `If-Match` value: withholding it would remove
 * the conditional-write path, which is a worse trade than the bytes are worth. That is the whole reason this
 * is a separate list from `RECALL_RECORD_DIAGNOSTICS` rather than a reuse of it — the recall door withholds
 * all three, a list route withholds two, and the difference is a deliberate decision rather than drift.
 */
export const LIST_WITHHELD_FIELDS: readonly string[] = ['matchedText', 'embeddingModel'];

/**
 * Drop the withheld diagnostics from a page of records, unless the caller asked for them.
 *
 * Copies rather than deleting in place: the rows may be shared with a cache or a count, and a strip that
 * mutated its input would thin whatever else held a reference. Measured on the live stack before this
 * existed — `GET /entities` returned `matchedText`, `embeddingModel` AND `embedding`, and `GET /facts`
 * the first two.
 *
 * A strip and not a projection, unlike the vector: this one is conditional on the request, and making it a
 * projection would put an `includeDiagnostics` parameter through five reader signatures to save two small
 * fields. The vector is unconditional and enormous, so it is worth projecting; these are neither.
 */
export function withoutListDiagnostics<T extends Record<string, unknown>>(
  rows: readonly T[],
  includeDiagnostics: boolean,
): T[] {
  if (includeDiagnostics) return rows as T[];
  return rows.map(r => {
    const out = { ...r } as Record<string, unknown>;
    for (const f of LIST_WITHHELD_FIELDS) delete out[f];
    return out as T;
  });
}

/**
 * The Mongo projection that withholds the embedding vector. Spread or pass it directly to `find`/`findOne`.
 *
 * **Built from `NEVER_RETURNED_FIELDS` rather than written as `{ embedding: 0 }`.** The two cannot then
 * disagree, and adding a second never-returned field is one edit rather than a sweep of every reader — which
 * is the sweep that was already missed once.
 *
 * An EXCLUSION projection, so every other field of the document is returned untouched. That matters for a
 * list route: an inclusion projection would have to name every field a caller might read, and the next field
 * anybody adds to a record would be silently absent from the API.
 */
export const NEVER_RETURNED_PROJECTION: Record<string, 0> =
  Object.fromEntries(NEVER_RETURNED_FIELDS.map(f => [f, 0 as const]));

/**
 * The same rule for a WRITE's return value, where a projection cannot reach.
 *
 * ## Why writes needed their own answer
 *
 * A projection fixes reads. A write that embeds INLINE has just computed the vector in memory, so there is
 * no read to project: `saveFact`, `save_entity`, `save_edge` and `save_chrono` assembled it into the
 * document they stored AND into the document they returned, and the route sent that as its 201.
 *
 * Measured against the live stack 2026-08-19, all five leaked: entity, fact, chrono and edge creates with
 * `waitForEmbedding: true`, **and any create with `checkDuplicates` — which DEFAULTS TO TRUE, because the
 * duplicate check needs the vector up front and therefore implies the wait.** So this was reachable with no
 * flag at all, on the commonest write there is.
 *
 * ## The evidence that it was an oversight and not a decision
 *
 * `upsertEntity` already wrote `entry: { ...doc, embedding: undefined }` when emitting its webhook. Somebody
 * knew the vector must not leave on a webhook, and the very same object went out on the response with it
 * intact. One rule, two places, and the weaker one winning — for the third time in this one change.
 *
 * Nothing downstream reads it: every internal use is the local `embeddingFields.embedding` before the write,
 * or `doc.embedding` inside the embed queue, which reads from Mongo itself.
 */
export function withoutVector<T extends object>(doc: T): T {
  const out = { ...doc } as Record<string, unknown>;
  for (const f of NEVER_RETURNED_FIELDS) delete out[f];
  return out as T;
}
