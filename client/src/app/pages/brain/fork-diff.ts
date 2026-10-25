/**
 * What differs between a fork and its parent, as marked segments (bundle-81, decision 43, mockup layout 3).
 *
 * The one question: "which words are only in this version, and which only in the other". `ins` is only in the fork (this version),
 * `del` only in the parent (the other), `same` in both. The Forks section writes a kind's main text (the fact, an entity's name, a timeline
 * entry's title, a relationship's description) once with the marks in place, and each other field that differs as a line of marks; a mark is a
 * word for a screen reader as well as a colour (the component prefixes it). Every kind goes through the same functions, with the fields the
 * list answer names for it.
 *
 * The word diff is a longest common subsequence over words, quadratic in their number. The forgettable part is inside: texts beyond
 * `MAX_DIFF_CELLS` cells are not diffed, they are shown as one removed run and one added run, because a long record must not freeze the page
 * for a mark the "show both versions in full" disclosure already makes redundant.
 */
import type { ForkVersion } from '../../core/forks.types';

export type SegmentKind = 'same' | 'ins' | 'del';
export interface Segment { kind: SegmentKind; text: string }

/** Cells of the comparison table beyond which two texts are not compared word by word (500 x 500 words). */
export const MAX_DIFF_CELLS = 250_000;

/** The segments of two texts: `a` is this version (the fork), `b` the other (the parent). Removed words come before added ones where they meet. */
export function wordDiff(a: string, b: string): Segment[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  const out: Segment[] = [];
  const push = (kind: SegmentKind, text: string): void => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ kind, text });
  };
  if (A.length * B.length > MAX_DIFF_CELLS) {
    if (b) push('del', b);
    if (a) push('ins', a);
    return out;
  }
  const m = A.length;
  const n = B.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { push('same', A[i]!); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { push('ins', A[i]!); i++; }
    else { push('del', B[j]!); j++; }
  }
  while (i < m) push('ins', A[i++]!);
  while (j < n) push('del', B[j++]!);
  // Where a removal and an addition meet, the removed words read first, so a swap reads "18:00 17:30".
  for (let x = 0; x < out.length - 1; x++) {
    if (out[x]!.kind === 'ins' && out[x + 1]!.kind === 'del') [out[x], out[x + 1]] = [out[x + 1]!, out[x]!];
  }
  return out;
}

/** One field that differs between the versions: `a` is the fork's value, `b` the parent's. */
export interface FieldDifference { key: string; a: unknown; b: unknown }

export interface ForkComparison {
  /** The main field's two versions, when they differ (a fork always differs somewhere, and usually here). */
  main: FieldDifference | undefined;
  /** Every other field that differs. */
  others: FieldDifference[];
  /** The names of the fields that are the same and say something: empty values are left out, as a field that says nothing. */
  same: string[];
}

const differs = (f: FieldDifference): boolean => JSON.stringify(f.a) !== JSON.stringify(f.b);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The fields of both versions, split into what differs and what is the same. `fields` and `mainField` are the list answer's (`kinds[kind]`): a kind
 * is compared on the fields it states, so a fact, an entity, a timeline entry and a relationship share this one function and it holds no field list.
 * The main field is the one Review marks by word and is never repeated among the others, whether or not `fields` names it. A property of either
 * version is compared key by key, whatever the kind.
 */
export function compareForkVersions(fork: ForkVersion, parent: ForkVersion, fields: readonly string[], mainField: string): ForkComparison {
  const propertyKeys = [...new Set([...Object.keys(parent.properties ?? {}), ...Object.keys(fork.properties ?? {})])].sort();
  const all: FieldDifference[] = [
    ...fields.filter(key => key !== mainField && key !== 'properties').map(key => ({ key, a: fork[key], b: parent[key] })),
    ...propertyKeys.map(p => ({ key: `properties.${p}`, a: fork.properties?.[p], b: parent.properties?.[p] })),
  ];
  const main = { key: mainField, a: fork[mainField], b: parent[mainField] };
  return {
    main: differs(main) ? main : undefined,
    others: all.filter(differs),
    same: all.filter(f => !differs(f) && !isEmpty(f.a)).map(f => f.key),
  };
}

/** The fields an orphan has to say: the ones that hold something, in the answer's order, properties key by key. There is no other version to compare. */
export function forkOwnFields(fork: ForkVersion, fields: readonly string[], mainField: string): FieldDifference[] {
  const own = fields.filter(key => key !== mainField && key !== 'properties').map(key => ({ key, a: fork[key], b: undefined }));
  const props = Object.keys(fork.properties ?? {}).sort().map(p => ({ key: `properties.${p}`, a: fork.properties?.[p], b: undefined }));
  return [...own, ...props].filter(f => !isEmpty(f.a));
}

/** Below this share of the longer text's words in common, interleaved marks read as noise: the two texts are shown whole instead. */
export const WHOLE_TEXT_BELOW = 0.4;

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * The marks of the main text (and of a description): the words only one side has, in place, unless fewer than {@link WHOLE_TEXT_BELOW} of the longer
 * text's words are shared. Then the other text comes whole and struck, and this one whole and underlined, because a sentence cut into shreds of two
 * texts cannot be read as either (the mockup's `diffHtml`, which the owner green-lit).
 */
export function textSegments(a: string, b: string): Segment[] {
  const segments = wordDiff(a, b);
  if (a === b) return segments;
  const common = segments.filter(s => s.kind === 'same').reduce((n, s) => n + wordCount(s.text), 0);
  if (common / Math.max(wordCount(a), wordCount(b), 1) >= WHOLE_TEXT_BELOW) return segments;
  return [
    ...(b ? [{ kind: 'del' as const, text: b }] : []),
    ...(a && b ? [{ kind: 'same' as const, text: ' ' }] : []),
    ...(a ? [{ kind: 'ins' as const, text: a }] : []),
  ];
}

/** The marks of one differing field: tags and entity links by item, the description by word, anything else as the parent's value then the fork's. */
export function fieldSegments(field: FieldDifference, words: { empty: string; none: string }): Segment[] {
  const text = (v: unknown): string => v === undefined || v === '' ? words.empty : Array.isArray(v) ? (v.length ? v.join(', ') : words.none) : String(v);
  if (field.key === 'tags' || field.key === 'linkEntities') {
    const a = (field.a as string[] | undefined) ?? [];
    const b = (field.b as string[] | undefined) ?? [];
    const marks: Segment[] = [
      ...b.filter(x => !a.includes(x)).map(x => ({ kind: 'del' as const, text: x })),
      ...a.filter(x => !b.includes(x)).map(x => ({ kind: 'ins' as const, text: x })),
    ];
    // A space between the marks, outside them, so a mark's underline or strike does not run into the next one.
    return marks.flatMap((mark, index) => (index === 0 ? [mark] : [{ kind: 'same' as const, text: ' ' }, mark]));
  }
  if (field.key === 'description') return textSegments(text(field.a), text(field.b));
  return [{ kind: 'del', text: text(field.b) }, { kind: 'ins', text: text(field.a) }];
}
