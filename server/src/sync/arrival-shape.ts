/**
 * Does an arriving document match the schema its family ships under — the ONE table and the ONE per-document parse,
 * asked by every door that holds an `Incoming*` schema (`Q-225`, the part of the pull's validation a 5.6.x patch carries).
 *
 * ## Why it is a module
 *
 * The push parsed each document against its family's `Incoming*` schema, written out at nine sites (the four single
 * routes and the batch loop's six, each naming its own schema), and the pull parsed nothing: a document a push door
 * refuses was stored by a pull as received. A table keyed by the replicated family — total over
 * `REPLICATED_FAMILIES` — is what the next door reads instead of spelling a schema, and a family without a row is
 * refused at load rather than found by the first document of it.
 *
 * ## What the pull does with it, and why it is not what the push does
 *
 * A push refuses a document that fails its schema: the receiver knows who sent it and answers the sender. A pull cannot
 * tell its sender from what the sender's own copy was, and 5.6.3 stored what it was served — so on this line (owner
 * decision D-10, fixes only) a pull that began refusing documents it used to store would be a behaviour change. The
 * pull therefore refuses only a shape that CORRUPTS the receiver (a non-string `parentFileId`, a wrong-typed `_id` or
 * `seq`: the arrival writer's own shape rule, `arrivalRefusal`), stores everything else AS RECEIVED, and REPORTS each
 * document it stored that failed its schema, once per page (`sync/pull-report.ts`). The pull's full refusal stays on
 * main, where a pull can be held to the same schema as a push.
 *
 * ## The half a hand copy drops
 *
 * **A file row is parsed AFTER the wire strip** (`fileMetaForWire`): a stored file row carries the sender's own
 * machinery (size, hash, excerpt, vector…), which the receiver never takes from a peer and which `IncomingFileMetaDoc`,
 * being `.strict()`, would refuse — so a real peer's every file row would read as failing. The strip is the arrival
 * writer's own, kept as it is; the parse sees what the writer will store.
 */
import type { z } from 'zod';
import {
  IncomingFactDoc, IncomingEntityDoc, IncomingEdgeDoc, IncomingChronoDoc, IncomingLinkDoc, IncomingFileMetaDoc, fileMetaForWire,
} from '../api/sync/_shared.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';
import type { ArrivalRefusal } from './arrivals.js';
import { peerList } from '../util/log.js';

/**
 * The schema each replicated family ships under, by the name it goes by on the wire. Total over `REPLICATED_FAMILIES`,
 * or it throws at load: a family added without a schema would be one no door ever validates.
 */
export const INCOMING_SCHEMA_OF: ReadonlyMap<PayloadKey, z.ZodTypeAny> = (() => {
  const table = new Map<PayloadKey, z.ZodTypeAny>([
    ['facts', IncomingFactDoc],
    ['entities', IncomingEntityDoc],
    ['edges', IncomingEdgeDoc],
    ['chrono', IncomingChronoDoc],
    ['links', IncomingLinkDoc],
    ['filemeta', IncomingFileMetaDoc],
  ]);
  for (const f of REPLICATED_FAMILIES) {
    if (!table.has(f.payloadKey)) throw new Error(`replicated family '${f.payloadKey}' has no Incoming schema in INCOMING_SCHEMA_OF`);
  }
  return table;
})();

/** Parse one document against its family's schema — the push's `safeParse`, by family instead of by a hand-named schema. */
export function parseIncoming(key: PayloadKey, doc: unknown): ReturnType<z.ZodTypeAny['safeParse']> {
  const schema = INCOMING_SCHEMA_OF.get(key);
  if (!schema) throw new Error(`'${key}' is not a replicated family`);
  return schema.safeParse(doc);
}

/** Why a document failed, in words that carry no peer text beyond a bounded path: `author: invalid_type`, up to three. */
function reasonOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>): string {
  return peerList(issues.map(i => `${i.path.length > 0 ? i.path.map(String).join('.') : '(document)'}: ${i.code}`), '; ', { count: 3, each: 120 });
}

/**
 * The documents of a pulled page that do not match their family's schema, each with the reason — for the pull's report,
 * and only for documents the writer does not itself refuse. The file family is parsed as the writer will store it
 * (`fileMetaForWire`). Never throws, and refuses nothing: what to do with a miss is the pull's.
 */
export function schemaMisses(key: PayloadKey, docs: readonly unknown[]): ArrivalRefusal[] {
  const out: ArrivalRefusal[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const id = (doc as { _id?: unknown })._id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const parsed = parseIncoming(key, key === 'filemeta' ? fileMetaForWire(doc) : doc);
    if (!parsed.success) out.push({ _id: id, reason: reasonOf(parsed.error.issues) });
  }
  return out;
}
