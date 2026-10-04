/**
 * The ONE validation step every arriving page passes before it is planned (`Q-225`): each document against its
 * family's `Incoming*` schema, then the writer's shape rule (`arrivalRefusal`). Push and pull alike, and the
 * stray-filemeta drain.
 *
 * ## What it prevents
 *
 * The schemas were applied on PUSH only — `batch-upsert` through a family table, each single route through its own
 * `safeParse` — and the pull validated nothing. So one document delivered the other way round was stored with a
 * field of the wrong type, kept a key the schema strips, and a file whose `parentFileId` was a number (or `0`,
 * `false`, `{}`) became a TOP-LEVEL file, because only a string is read as a chunk. Six places spelled "is this
 * document acceptable" and the pull was the one that did not. Here it is one function, and a door that skips it has
 * no other spelling to fall back on.
 *
 * ## What a refusal is
 *
 * Per document, never the page's: a poison document must not hold back everything sent with it. A schema refusal
 * is marked `invalid` — the single routes answer it with their own `400` wording — and the shape rule's refusal
 * (an `_id` that is no string, a seq the counter cannot carry) keeps the writer's words.
 *
 * ## File metadata
 *
 * `IncomingFileMetaDoc` is `.strict()`: an undeclared key refuses the document rather than being stripped. A pulled
 * page is the sender's STORED row (a 5.6 peer serves it whole, less the local-only fields), so the sender's own
 * machinery — sizes, hashes, excerpts, the media pipeline's fields — is removed first (`fileMetaFromSender`, a list
 * the compiler holds complete); a key that is neither a wire key nor part of a file row is still refused, on both
 * doors alike — push and pull.
 *
 * **The stray-filemeta drain is not a door, and hands this its records' WIRE keys only** (`fileMetaForWire`, before
 * the call). Its records are rows an OLD pull stored whole, from senders of any version since 4.0, so a key that is
 * neither is a field a version since retired. Refused, the record would be deleted as answered and the publisher's
 * description lost for good — the loss the fill below exists to prevent — while a live sender refused for the same key
 * can still be fixed and send again. Decided in bundle-30 I6 (D4); `a-stray-filemeta-collection-is-merged-db` holds
 * both halves.
 *
 * ## A fill (`{ fill: true }`, file metadata only)
 *
 * The stray-filemeta drain does not store a record: it FILLS the keys a record carries onto a row that already exists
 * (`sync/fill-file-meta.ts`), and writes nothing it lacks. So it validates the keys PRESENT — their types, an
 * undeclared key, a `parentFileId` of any type, a seq the counter cannot carry — and requires none but `_id`. Required
 * as on the other doors, a record an older version stored without `tags`, `author` or `seq` was refused and then
 * deleted as answered, losing the description it carried for good (bundle-30 I2b). The fill's schema is the family's
 * own made partial, never a second copy of it, so a key added to the wire schema is checked here too.
 */
import {
  IncomingFactDoc, IncomingEntityDoc, IncomingEdgeDoc, IncomingChronoDoc, IncomingLinkDoc, IncomingFileMetaDoc,
  fileMetaFromSender,
} from '../api/sync/_shared.js';
import { arrivalRefusal, arrivalId } from './arrivals.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';
import { peerText } from '../util/log.js';

type SafeParser = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };

/**
 * The `Incoming*` schema each family is validated against — the one hand-written family table, because a schema is
 * a fact about the wire that no registry can derive. Keyed by the DERIVED family list, and checked at load against
 * it, so a family added to `REPLICATED_FAMILIES` without a schema stops the server rather than being stored
 * unchecked.
 */
export const INCOMING_SCHEMA_OF: Readonly<Partial<Record<PayloadKey, { schema: SafeParser; name: string; fill?: SafeParser }>>> = {
  facts: { schema: IncomingFactDoc, name: 'IncomingFactDoc' },
  entities: { schema: IncomingEntityDoc, name: 'IncomingEntityDoc' },
  edges: { schema: IncomingEdgeDoc, name: 'IncomingEdgeDoc' },
  chrono: { schema: IncomingChronoDoc, name: 'IncomingChronoDoc' },
  links: { schema: IncomingLinkDoc, name: 'IncomingLinkDoc' },
  // `.partial()` keeps `.strict()` and the `never` on `parentFileId`: only the requirement goes.
  filemeta: { schema: IncomingFileMetaDoc, name: 'IncomingFileMetaDoc', fill: IncomingFileMetaDoc.partial() },
};
{
  const keys: readonly string[] = REPLICATED_FAMILIES.map(f => f.payloadKey);
  const missing = keys.filter(k => !(k in INCOMING_SCHEMA_OF));
  const extra = Object.keys(INCOMING_SCHEMA_OF).filter(k => !keys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`the Incoming schemas do not match the replicated families: missing [${missing}], extra [${extra}]`);
  }
}

/** A whole wire record, as every door but a fill admits it. */
export type WireArrival = Record<string, unknown> & { _id: string; seq: number };
/** What a fill admits: the keys a record carries, of which only `_id` is required. */
export type FillArrival = Record<string, unknown> & { _id: string; seq?: number };

/** A document admitted, as its schema parsed it, at its index in what was handed in. */
export interface AdmittedArrival<D extends FillArrival = WireArrival> {
  index: number;
  doc: D;
}

/** A document refused, at its index; `invalid` when its family's wire schema refused it. */
export interface RefusedArrival {
  index: number;
  _id: string;
  reason: string;
  invalid: boolean;
}

/**
 * How much of a schema's issue list a refusal quotes. Through `peerText`: an issue quotes peer text (a key the
 * schema does not declare, a record key in its path), so it is escaped, cut on a code point, and says it was cut.
 */
const ISSUES_QUOTED = 200;

/** Validate a family's arriving documents — see the module docblock, and its section on a fill. */
export function admitArrivals(key: PayloadKey, docs: readonly unknown[]): { admitted: AdmittedArrival[]; refused: RefusedArrival[] };
export function admitArrivals(key: 'filemeta', docs: readonly unknown[], opts: { fill: true }): { admitted: AdmittedArrival<FillArrival>[]; refused: RefusedArrival[] };
export function admitArrivals(key: PayloadKey, docs: readonly unknown[], { fill = false }: { fill?: boolean } = {}): { admitted: AdmittedArrival<FillArrival>[]; refused: RefusedArrival[] } {
  const entry = INCOMING_SCHEMA_OF[key];
  if (!entry) throw new Error(`admitArrivals: '${key}' is not a replicated family's wire key`);
  // Loud, never a silent whole-record check: a caller asking for a fill on a family that has none has a defect.
  if (fill && !entry.fill) throw new Error(`admitArrivals: '${key}' has no fill`);
  const schema = fill ? entry.fill! : entry.schema;
  const name = fill ? `${entry.name} (fill)` : entry.name;
  const admitted: AdmittedArrival<FillArrival>[] = [];
  const refused: RefusedArrival[] = [];
  docs.forEach((raw, index) => {
    const offered = key === 'filemeta' && raw && typeof raw === 'object' && !Array.isArray(raw) ? fileMetaFromSender(raw) : raw;
    const parsed = schema.safeParse(offered);
    if (!parsed.success) {
      refused.push({ index, _id: arrivalId(raw), invalid: true,
        reason: `not ${name}: ${peerText(parsed.error?.issues ?? [], { max: ISSUES_QUOTED })}` });
      return;
    }
    const why = arrivalRefusal(parsed.data, { seqOptional: fill });
    if (why) { refused.push({ index, _id: arrivalId(raw), invalid: false, reason: why }); return; }
    admitted.push({ index, doc: parsed.data as FillArrival });
  });
  return { admitted, refused };
}
