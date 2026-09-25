/**
 * The record as it was before an edit, and its link sets, for the audit entry's `changes` (`Q-50`).
 *
 * ## Why this exists
 *
 * An editing writer returns only the new document, so the audit's "before" has to be read first — the record from
 * whichever member space holds it, and its link sets, which after the write are already what the body asked for
 * (`linkAuditSnapshots`). The chrono and file-metadata routes each wrote that read out, and the five MCP editing
 * tools did not do it at all, so an edit made through MCP left an audit entry with no change list. One read, used by
 * both doors, so neither can be the one that skips it.
 *
 * `after` is built from what the writer returned, so a caller cannot hand it the values it MEANT to write.
 */
import { findFirstAcrossMembers } from '../spaces/proxy.js';
import { linkAuditSnapshots } from './write-connections.js';

export interface EditAudit<T> {
  /** The record before the write, or null when no member space holds it. */
  prior: T | null;
  /** The entry's before/after, from the prior read and the record the writer returned. */
  snapshots(updated: object): { before: Record<string, unknown>; after: Record<string, unknown> };
}

/**
 * @param target  the space the edit is addressed to — a proxy is walked to the member that holds the record
 * @param read    how this kind reads one record from one member space
 * @param linkId  the id the record's links are keyed by (a file's stored path, everything else its `_id`)
 * @param body    the edit as the caller sent it — the link classes it names are the ones snapshotted
 */
export async function readEditAudit<T extends object>(
  target: string,
  read: (spaceId: string) => Promise<T | null>,
  linkId: string,
  body: unknown,
): Promise<EditAudit<T>> {
  let home: string | undefined;
  const prior = await findFirstAcrossMembers(target, async mid => {
    const found = await read(mid);
    if (found) home = mid;
    return found;
  });
  const links = home ? await linkAuditSnapshots(home, linkId, body) : { before: {}, after: {} };
  return {
    prior: prior ?? null,
    snapshots: (updated) => ({
      before: { ...((prior ?? {}) as Record<string, unknown>), ...links.before },
      after: { ...(updated as Record<string, unknown>), ...links.after },
    }),
  };
}
