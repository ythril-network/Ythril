/**
 * What an instance is called, where this instance knows it.
 *
 * ## The question it answers
 *
 * "Which name does this instance go by here?" A record's author line carries the label its author stamped on it (`authorRef`); a row that only
 * holds an instance ID (a fork another instance resolved, `sync/resolved-elsewhere.ts`) has no stamp, and showed the first eight characters of
 * the id beside an author line that said "Peer B". This answers from what the instance itself knows: its own label, then the members of its
 * networks, then the labels stamped on the records the caller hands it.
 *
 * ## What is inside, so a caller cannot drop it
 *
 * An empty label never wins: a member recorded with a blank label, or a stamp that says `''`, is not a name. The answer is `undefined` for an
 * instance nobody here knows, and the caller shows the short id then, never an empty string.
 */
import type { Config } from '../config/types.js';

/** A label stamped on a record by the instance that wrote it. */
export interface StampedAuthor { instanceId?: unknown; instanceLabel?: unknown }

export function instanceLabelOf(
  cfg: Pick<Config, 'instanceId' | 'instanceLabel' | 'networks'>, instanceId: string, stamped: readonly (StampedAuthor | undefined)[] = [],
): string | undefined {
  if (!instanceId) return undefined;
  if (instanceId === cfg.instanceId) return cfg.instanceLabel || undefined;
  for (const n of cfg.networks) {
    const m = n.members.find(x => x.instanceId === instanceId && x.label);
    if (m) return m.label;
  }
  for (const a of stamped) {
    if (a && a.instanceId === instanceId && typeof a.instanceLabel === 'string' && a.instanceLabel) return a.instanceLabel;
  }
  return undefined;
}
