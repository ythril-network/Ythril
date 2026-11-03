import { Signal, computed, inject } from '@angular/core';
import { Space, TTL_BUCKETS, recordTtlWindows } from '../../core/api.types';
import { pageTranslator } from '../../core/page-translator';
import { PluralText } from '../../core/plural-text.service';

/**
 * What the Overview's Indexing card says about retention — pure functions beside the component, and the two
 * factories the component calls to get them as signals.
 *
 * ## Why they moved out
 *
 * `overview-tab.component.ts` is one of the files the god-file ratchet has frozen, and the honest response to
 * a frozen file is to put new behaviour beside it rather than inside it. This is the part of that component
 * that was never about rendering: two computeds that read a space and produce strings, with no template.
 *
 * The pure functions are directly testable — the component's own tests have to render a card to assert a
 * sentence, and these can be called. `translate` and the counted sentence are passed in rather than injected
 * for the same reason: a pure function of (space, translate) has no Angular in it at all.
 *
 * ## Why the factories inject the language themselves (Q-185)
 *
 * A `computed()` that translates must also depend on the page's words arriving, or it keeps the raw key it got
 * on the first render, before the language file resolved. `pageTranslator` and `PluralText` read the active
 * language's revision, so the signals the factories return recompute when the words do — and the component, a
 * frozen file, gains no line to say so. Call each factory once, as a field initializer.
 */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The space-wide sentence for a window of `days`, in the plural form the language needs ("1 day", "1 dzień"). */
export type SpaceWideSentence = (days: number) => string;

/** The space-wide window in words, as a signal that follows the language. */
export function retentionSummaryOf(space: () => Space | null | undefined): Signal<string> {
  const say = pageTranslator();
  const plural = inject(PluralText);
  return computed(() => retentionSummary(space(), say, days => plural.text('brain.overview.retentionSpaceWide', days)));
}

/** The types whose schema overrides the space-wide window, as a signal that follows the language. */
export function retentionTypesOf(space: () => Space | null | undefined): Signal<Array<{ key: string; label: string }>> {
  const say = pageTranslator();
  return computed(() => retentionTypeOverrides(space(), say));
}

/**
 * One sentence for the space-wide expiry.
 *
 * Reads the BUCKETS rather than the raw field, because the tier is five numbers. When they all agree it says
 * the one sentence it always did — a space with a single window must not be made to look complicated by an
 * implementation detail — and it lists per bucket only when they actually differ.
 */
export function retentionSummary(space: Space | null | undefined, t: Translate, spaceWide: SpaceWideSentence): string {
  const w = recordTtlWindows(space?.recordTtlDays);
  const set = TTL_BUCKETS.filter(b => w[b] !== null);
  if (set.length === 0) return t('brain.overview.retentionNone');
  if (set.length === TTL_BUCKETS.length && new Set(set.map(b => w[b])).size === 1) {
    return spaceWide(w[set[0]!]!);
  }
  return t('brain.overview.retentionBuckets', {
    list: set.map(b => t('brain.overview.retentionBucketOne', {
      bucket: t(`spaces.dangerZone.retentionBucket.${b}`), days: w[b],
    })).join(', '),
  });
}

/**
 * Types whose schema overrides the space-wide window.
 *
 * Listed because the sentence above is a half-truth without them: an operator who set 30 days and sees one
 * type keeping records for ten years needs the reason on the same card, not in another tab.
 */
export function retentionTypeOverrides(
  space: Space | null | undefined,
  t: Translate,
): Array<{ key: string; label: string }> {
  const schemas = space?.meta?.typeSchemas ?? {};
  const out: Array<{ key: string; label: string }> = [];
  for (const [collection, types] of Object.entries(schemas)) {
    for (const [type, schema] of Object.entries(types ?? {})) {
      const r = schema?.retention;
      if (!r || (!r.days && !r.contentDays)) continue;
      const name = `${collection}.${type}`;
      const label = r.days && r.contentDays
        ? t('brain.overview.retentionTypeContent', { type: name, days: r.days, contentDays: r.contentDays })
        : r.days
          ? t('brain.overview.retentionType', { type: name, days: r.days })
          : t('brain.overview.retentionTypeContentOnly', { type: name, contentDays: r.contentDays });
      out.push({ key: name, label });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
