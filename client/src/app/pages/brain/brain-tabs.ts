/**
 * The Brain's tab identifiers, in one place.
 *
 * `BrainTab` lived in `brain.component.ts` and a subset of it, `StatKey`, was declared independently in
 * `overview-tab.component.ts` for the Overview's clickable stat tiles. The two agreed by hand, which meant
 * the drift was one-directional and silent: adding a key to the child's copy that the parent lacked failed
 * the build, but adding a TAB to the parent and a matching tile still typed against the stale child copy
 * did not — the tile simply could not open its tab, and nothing said so.
 *
 * Deriving the whole union from the collection tabs removes the possibility rather than documenting it.
 * `CollectionTab` is a subset of `BrainTab` **by construction**, so no assertion is needed and no
 * `Extract<>` can quietly evaluate to `never` on a typo.
 *
 * It lives in its own file rather than being exported from `brain.component.ts` so the Overview tab does
 * not import from its own parent — that edge would make the two mutually dependent for a string union.
 */

import type { SpaceStats } from '../../core/api.types';

/**
 * Tabs backed by a per-space collection. These are exactly the tabs an Overview stat tile can open,
 * because a tile shows a count and only a collection has one.
 *
 * A runtime array as well as a type: the Overview builds its tiles from data, and a second hand-written
 * list of the same five strings is the thing this file exists to prevent.
 */
/*
 * NOT ALL BRAIN COLLECTIONS — these are the TABS, which answer a different question.
 *
 * A tab exists because a person browses that kind of record, not because documents live there. The two lists
 * are equal today and the questions are not related: adding a collection does not earn it a tab, and the
 * owner's ruling on link records says how they surface — *"on graph shown as info on click, and toggleable
 * if facts and chronos appear"* — which is a graph affordance and a recall toggle, not a tab.
 *
 * Written out rather than derived so that decision stays a decision.
 */
export const COLLECTION_TABS = ['facts', 'entities', 'edges', 'chrono', 'files'] as const;

/** A tab that shows a collection — the only kind a stat tile links to. */
export type CollectionTab = typeof COLLECTION_TABS[number];

/** The views that are not backed by one collection. */
const NON_COLLECTION_TABS = ['overview', 'query', 'graph', 'review'] as const;

/**
 * Every Brain tab, at runtime.
 *
 * Needed because the tab is now readable from the URL, and a value arriving from outside the app has to be
 * checked against something that exists at runtime — a type cannot reject `?tab=nonsense`. Derived from the
 * same two lists the type is, for the reason this whole file exists: a second hand-written copy would agree
 * by hand until it did not.
 */
export const BRAIN_TABS = [...COLLECTION_TABS, ...NON_COLLECTION_TABS] as const;

/** Every Brain tab. The collection tabs plus the views that are not backed by one collection. */
export type BrainTab = CollectionTab | typeof NON_COLLECTION_TABS[number];

/**
 * The tabs that browse one kind of record, in the order the Brain's tab strip shows them.
 *
 * ONE order, read by everything that lists the four kinds of record: the strip (`brain.component`'s `collectionTabs`) and Review's Forks kind
 * switch (`core/forks.types`'s `FORK_KINDS`). A second hand-written order agrees until someone reorders the strip, and then the same four kinds
 * read in two orders a few clicks apart. `COLLECTION_TABS` above is not this list: it has `files`, and its order is the type's, not the strip's.
 */
export const RECORD_TABS = ['entities', 'edges', 'facts', 'chrono'] as const satisfies readonly CollectionTab[];

/** A tab that browses one kind of record: a collection tab, by construction (`satisfies` fails the build on a name that is not one). */
export type RecordTab = typeof RECORD_TABS[number];

/**
 * What the strip shows for each record tab, read by `brain.component`'s `collectionTabs`. The ORDER is not here: it is `RECORD_TABS`.
 *
 * `label` is an i18n KEY now, not a literal. These four were the only tabs in the strip rendering a
 * hard-coded English string — the translations existed the whole time and were simply never used, so
 * the strip read half-German in a German UI and nothing flagged it.
 *
 * `icon` likewise: Overview, Query, Graph, Review and Files each carried one and these four did not,
 * leaving a strip where some tabs have an icon and some do not. The icons match the Overview tiles
 * that link here, because the tiles and the tabs are the same five things.
 */
export const RECORD_TAB_FACES: Readonly<Record<RecordTab, { label: string; icon: string; statsKey: keyof SpaceStats }>> = {
  entities: { label: 'brain.tab.entities', icon: 'stack', statsKey: 'entities' },
  // `link` and not `graph`: the Graph tab already owns that glyph, and two different tabs wearing the
  // same icon in one strip is worse than a slightly less literal one.
  edges: { label: 'brain.tab.edges', icon: 'link', statsKey: 'edges' },
  facts: { label: 'brain.tab.facts', icon: 'brain', statsKey: 'facts' },
  chrono: { label: 'brain.tab.chrono', icon: 'timer', statsKey: 'chrono' },
};
