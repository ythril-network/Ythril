/**
 * What a schema rule's `self` holds, per kind of record — the vocabulary a rule is checked against when it is saved.
 * `server/src/brain/record-view.ts` re-exports it beside the view it builds from a stored record.
 */
import type { KnowledgeType } from './vocabulary.js';

/** The four kinds that have properties, and so a validator, and a view: the knowledge types, by their one declaration. */
export type ViewKind = KnowledgeType;

/** Every field a view can carry, across the kinds — what a rule may name after `self.`. */
export type ViewField = 'title' | 'type' | 'label' | 'description' | 'tags' | 'properties';

/**
 * The fields of a view per kind — the ONE spelling of what `self` holds (R6-3). An edge has its label and no title or type, and never its
 * ends. The engine's `self`, the save-time reference check, the "did the write change what the rule reads" comparison and the stored-data
 * check's projection all read it here, so a field added to the view reaches every one of them.
 */
export const VIEW_FIELDS: Readonly<Record<ViewKind, readonly ViewField[]>> = {
  entity: ['title', 'type', 'description', 'tags', 'properties'],
  fact: ['title', 'type', 'description', 'tags', 'properties'],
  edge: ['label', 'description', 'tags', 'properties'],
  chrono: ['title', 'type', 'description', 'tags', 'properties'],
};

/** Every field any kind's view carries, once each, in the order the kinds name them. */
export const ALL_VIEW_FIELDS: readonly ViewField[] = [...new Set(Object.values(VIEW_FIELDS).flat())];
