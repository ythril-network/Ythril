import type { Space, SpaceStats } from '../../core/api.types';

/** Every record and file a space holds: the number a chip shows beside its name. */
export function spaceChipTotal(stats: SpaceStats): number {
  return stats.facts + stats.entities + stats.edges + stats.chrono + stats.files;
}

/**
 * Tooltip for the space-chip network indicator (F8): the network name(s) plus the human-readable status. Colour alone must not carry the
 * meaning (a11y), so the status is said in words.
 *
 * Moved out of `brain.component.ts` (frozen by the size ratchet) when personal views needed its lines: it is a pure function of the space and a
 * translator. `translate` is the page's own, so the words follow its language.
 */
export function networkChipTitle(space: Space, translate: (key: string) => string): string {
  const status = space.networkStatus ?? 'idle';
  const names = (space.networks ?? []).map(n => n.label).join(', ');
  const statusText = translate(`brain.spaceChip.network.${status}`);
  const prefix = translate('brain.spaceChip.network.prefix');
  return names ? `${prefix}: ${names} — ${statusText}` : statusText;
}
