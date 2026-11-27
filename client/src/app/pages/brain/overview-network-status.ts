import { computed, type Signal } from '@angular/core';
import type { Space } from '../../core/api.types';
import type { StatusVariant } from '../../shared/status-pill.component';

/**
 * The Networks panel's sync status of a space, as the Overview shows it: moved out of `overview-tab.component.ts` (over its size ceiling,
 * Q-942) as `overview-retention.ts` was, pure over the space signal.
 */

/** Aggregate sync/governance status; defaults to 'idle' when connected but unreported. */
export function networkStatusOf(space: Signal<Space>): Signal<'idle' | 'syncing' | 'degraded' | 'vote'> {
  return computed(() => space().networkStatus ?? 'idle');
}

/** The pill colour of that status: a vote awaiting this instance needs attention; idle is connected and healthy. */
export function networkVariantOf(space: Signal<Space>): Signal<StatusVariant> {
  return computed(() => {
    switch (space().networkStatus) {
      case 'degraded': return 'error';
      case 'syncing': return 'pending';
      case 'vote': return 'warn';
      default: return 'ok';
    }
  });
}
