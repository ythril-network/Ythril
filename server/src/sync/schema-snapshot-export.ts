/**
 * The `schemaSnapshots` value of an admin export: every schema snapshot the exported records use (Q-740, bundle-266, design r3 E-1 and E-2).
 *
 * ## What it holds
 *
 * Every row whose fingerprint a record the export WROTE carries (the export route notes each streamed document's stamp with {@link noteCarried},
 * so there is no second read of the records and no window between them), plus every row those rows link (`links.own`, `links.layers[].fp`,
 * `links.served[].fp`), transitively. Each element is `{ fp, text, links }` and nothing else: `origin`, `networkId` and `from` name peers and
 * networks, in a file that leaves the instance, and the import lands every element as `fetched` whatever they said.
 *
 * ## What it prevents
 *
 * - **A body no importer can read.** Every importer, released ones included, caps each array element at `MAX_DOCUMENT_BYTES` and refuses the
 *   whole body over it, and a JSON-escaped text grows. An element over {@link SNAPSHOT_ELEMENT_MAX_BYTES} is left out, counted, and named in one
 *   warn line (the space, the fingerprint prefix, the bytes); its records still restore, and the gap scan owes the version afterwards.
 * - **A space's texts on the heap at once.** The link closure reads the rows without their text; the texts are then read one row at a time and
 *   each element written through the route's backpressured write before the next is read.
 */
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { snapshots } from '../spaces/schema-snapshot-store.js';
import { isSchemaFingerprint, SCHEMA_FINGERPRINT_FIELD, type SnapshotLinks } from '../spaces/schema-stamp.js';
import { log, peerText } from '../util/log.js';
import { MAX_DOCUMENT_BYTES } from './export-stream.js';

/** The top-level key of the export that holds the snapshots: an array beside the families, never one of `REPLICATED_FAMILIES`. */
export const SNAPSHOTS_EXPORT_KEY = 'schemaSnapshots';

/** Room left under `MAX_DOCUMENT_BYTES` for what an importer counts beside the element's own JSON. */
export const SNAPSHOT_ELEMENT_HEADROOM = 64 * 1024;

/** The largest element the export writes, in bytes of its JSON: what every importer, released or not, reads. */
export const SNAPSHOT_ELEMENT_MAX_BYTES = MAX_DOCUMENT_BYTES - SNAPSHOT_ELEMENT_HEADROOM;

/** Note the schema fingerprint `doc` carries, if it carries one, in `carried`. */
export function noteCarried(carried: Set<string>, doc: unknown): void {
  const fp = (doc as Record<string, unknown> | null)?.[SCHEMA_FINGERPRINT_FIELD];
  if (isSchemaFingerprint(fp)) carried.add(fp);
}

/** Every fingerprint a row's links name. */
function linkedBy(links: SnapshotLinks | null | undefined): string[] {
  if (!links || typeof links !== 'object') return [];
  return [links.own, ...(links.layers ?? []).map(l => l.fp), ...(links.served ?? []).map(l => l.fp)].filter(isSchemaFingerprint);
}

/** The rows of `spaceId` the export holds: every held row `carried` names, and every held row those link, transitively, in fingerprint order. */
export async function exportedSnapshotIds(spaceId: string, carried: ReadonlySet<string>): Promise<string[]> {
  const linksOf = new Map<string, SnapshotLinks | null>();
  for await (const row of snapshots(spaceId).find({}, { projection: { _id: 1, links: 1 } })) linksOf.set(String(row._id), row.links ?? null);
  const out = new Set<string>();
  const todo = [...carried].filter(fp => linksOf.has(fp));
  while (todo.length > 0) {
    const fp = todo.pop()!;
    if (out.has(fp)) continue;
    out.add(fp);
    for (const next of linkedBy(linksOf.get(fp))) if (linksOf.has(next) && !out.has(next)) todo.push(next);
  }
  return [...out].sort();
}

/** What the export wrote of the snapshots, for its audit row. */
export interface SnapshotsWritten {
  written: { to: number };
  omitted: { to: number };
}

/**
 * Write the `schemaSnapshots` array value of `spaceId`'s export through `write` (backpressured): each row of `ids` read alone, its element written
 * before the next is read; one over {@link SNAPSHOT_ELEMENT_MAX_BYTES} is left out, counted in `counts.omitted` and warned once.
 */
export async function writeSnapshotElements(
  spaceId: string, ids: readonly string[], write: (chunk: string) => Promise<void>, counts: SnapshotsWritten,
): Promise<void> {
  await write('[');
  let first = true;
  for (const fp of ids) {
    const row = (await readStoredById<{ text?: unknown; links?: unknown }>(spaceCollection(spaceId, 'schemaSnapshots'), [fp], { text: 1, links: 1 })).get(fp);
    if (!row || typeof row.text !== 'string') continue;
    const element = JSON.stringify({ fp, text: row.text, links: row.links ?? null });
    const bytes = Buffer.byteLength(element, 'utf8');
    if (bytes > SNAPSHOT_ELEMENT_MAX_BYTES) {
      counts.omitted.to++;
      log.warn(`Space export for '${peerText(spaceId)}' left out schema snapshot ${peerText(fp.slice(0, 12))}: its element is ${bytes} bytes, over the `
        + `${SNAPSHOT_ELEMENT_MAX_BYTES} an importer reads. Its records are exported; an import fetches the version from a member or holds none.`);
      continue;
    }
    await write((first ? '' : ',') + element);
    first = false;
    counts.written.to++;
  }
  await write(']');
}
