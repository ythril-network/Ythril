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
 * doors alike.
 */
import {
  IncomingFactDoc, IncomingEntityDoc, IncomingEdgeDoc, IncomingChronoDoc, IncomingLinkDoc, IncomingFileMetaDoc,
  fileMetaFromSender,
} from '../api/sync/_shared.js';
import { arrivalRefusal, arrivalId } from './arrivals.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';

type SafeParser = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };

/**
 * The `Incoming*` schema each family is validated against — the one hand-written family table, because a schema is
 * a fact about the wire that no registry can derive. Keyed by the DERIVED family list, and checked at load against
 * it, so a family added to `REPLICATED_FAMILIES` without a schema stops the server rather than being stored
 * unchecked.
 */
export const INCOMING_SCHEMA_OF: Readonly<Partial<Record<PayloadKey, { schema: SafeParser; name: string }>>> = {
  facts: { schema: IncomingFactDoc, name: 'IncomingFactDoc' },
  entities: { schema: IncomingEntityDoc, name: 'IncomingEntityDoc' },
  edges: { schema: IncomingEdgeDoc, name: 'IncomingEdgeDoc' },
  chrono: { schema: IncomingChronoDoc, name: 'IncomingChronoDoc' },
  links: { schema: IncomingLinkDoc, name: 'IncomingLinkDoc' },
  filemeta: { schema: IncomingFileMetaDoc, name: 'IncomingFileMetaDoc' },
};
{
  const keys: readonly string[] = REPLICATED_FAMILIES.map(f => f.payloadKey);
  const missing = keys.filter(k => !(k in INCOMING_SCHEMA_OF));
  const extra = Object.keys(INCOMING_SCHEMA_OF).filter(k => !keys.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`the Incoming schemas do not match the replicated families: missing [${missing}], extra [${extra}]`);
  }
}

/** A document admitted, as its schema parsed it, at its index in what was handed in. */
export interface AdmittedArrival {
  index: number;
  doc: Record<string, unknown> & { _id: string; seq: number };
}

/** A document refused, at its index; `invalid` when its family's wire schema refused it. */
export interface RefusedArrival {
  index: number;
  _id: string;
  reason: string;
  invalid: boolean;
}

/** How much of a schema's issue list a refusal quotes. */
const ISSUES_QUOTED = 200;

/** Validate a family's arriving documents — see the module docblock. */
export function admitArrivals(key: PayloadKey, docs: readonly unknown[]): { admitted: AdmittedArrival[]; refused: RefusedArrival[] } {
  const entry = INCOMING_SCHEMA_OF[key];
  if (!entry) throw new Error(`admitArrivals: '${key}' is not a replicated family's wire key`);
  const { schema, name } = entry;
  const admitted: AdmittedArrival[] = [];
  const refused: RefusedArrival[] = [];
  docs.forEach((raw, index) => {
    const offered = key === 'filemeta' && raw && typeof raw === 'object' && !Array.isArray(raw) ? fileMetaFromSender(raw) : raw;
    const parsed = schema.safeParse(offered);
    if (!parsed.success) {
      refused.push({ index, _id: arrivalId(raw), invalid: true,
        reason: `not ${name}: ${JSON.stringify(parsed.error?.issues ?? []).slice(0, ISSUES_QUOTED)}` });
      return;
    }
    const why = arrivalRefusal(parsed.data, { seqOptional: false });
    if (why) { refused.push({ index, _id: arrivalId(raw), invalid: false, reason: why }); return; }
    admitted.push({ index, doc: parsed.data as AdmittedArrival['doc'] });
  });
  return { admitted, refused };
}
