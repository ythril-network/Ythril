/**
 * Grouping chunk hits under their parent document (4c-ii).
 *
 * The arithmetic is small; the judgement is not. What is pinned here is that grouping does not quietly
 * change what the reader is told: it must not re-rank results the server already ranked, must not lose
 * hits, and must not present six documents as though six passages matched.
 */
import { describe, it, expect } from 'vitest';
import { groupRecallResults, fileGroupKey, chunkLabel, passageText } from './recall-grouping';
import type { RecallResult } from '../../core/api.types';

const chunk = (parent: string, id: string, score: number, heading?: string, path = 'papers/study.pdf'): RecallResult =>
  ({ type: 'file', _id: id, score, parentFileId: parent, parentFile: { path }, ...(heading ? { headingText: heading } : {}) }) as unknown as RecallResult;
const memory = (id: string, score: number): RecallResult =>
  ({ type: 'fact', _id: id, score, fact: 'a fact' }) as unknown as RecallResult;
const wholeFile = (id: string, score: number, path: string): RecallResult =>
  ({ type: 'file', _id: id, score, path }) as unknown as RecallResult;

describe('recall grouping — chunk hits collapse to their document', () => {
  it('turns five passages of one paper into one row that says five', () => {
    const results = [
      chunk('paper-1', 'c1', 0.94, 'Method'),
      chunk('paper-1', 'c2', 0.91, 'Results'),
      chunk('paper-1', 'c3', 0.88),
      chunk('paper-1', 'c4', 0.86),
      chunk('paper-1', 'c5', 0.85),
    ];
    const groups = groupRecallResults(results);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hitCount).toBe(5);
    expect(groups[0]!.file?.path).toBe('papers/study.pdf');
    expect(groups[0]!.hits).toHaveLength(5);
  });

  it('keeps unrelated documents apart', () => {
    const groups = groupRecallResults([chunk('a', 'c1', 0.9), chunk('b', 'c2', 0.8), chunk('a', 'c3', 0.7)]);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.hitCount)).toEqual([2, 1]);
  });

  it('leaves non-file results exactly as they were, one group each', () => {
    // Grouping is a file concern. A memory must not acquire a document header or a passage count.
    const groups = groupRecallResults([memory('m1', 0.9), memory('m2', 0.8)]);
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.file === undefined && g.hitCount === 1)).toBe(true);
  });

  it('merges a whole-file hit with that same file\'s chunk hits', () => {
    // Otherwise the document appears once as itself and again as a set of fragments that look unrelated.
    const groups = groupRecallResults([
      wholeFile('paper-1', 0.95, 'papers/study.pdf'),
      chunk('paper-1', 'c1', 0.9, 'Method'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hitCount).toBe(2);
    expect(groups[0]!.file?.path).toBe('papers/study.pdf');
  });
});

describe('recall grouping — it must not change the answer', () => {
  it('preserves the server ordering rather than re-ranking', () => {
    // The server has already ranked these. Re-sorting here would make the UI disagree with every other
    // consumer of the same endpoint, for no reason the reader could see.
    const groups = groupRecallResults([memory('m1', 0.99), chunk('p', 'c1', 0.5), memory('m2', 0.98)]);
    expect(groups.map(g => g.hits[0]!['_id'])).toEqual(['m1', 'c1', 'm2']);
  });

  it('orders a group by its first (best) hit, not its last', () => {
    const groups = groupRecallResults([memory('m1', 0.9), chunk('p', 'c1', 0.8), chunk('p', 'c2', 0.1)]);
    expect(groups[1]!.score).toBe(0.8);
  });

  it('loses nothing — every input hit is still present', () => {
    const input = [memory('m1', 0.9), chunk('p', 'c1', 0.8), chunk('p', 'c2', 0.7), memory('m2', 0.6)];
    const flat = groupRecallResults(input).flatMap(g => g.hits);
    expect(flat).toHaveLength(input.length);
    expect(flat.map(h => h['_id']).sort()).toEqual(['c1', 'c2', 'm1', 'm2']);
  });

  it('names the document even when the first hit of a group did not carry the parent', () => {
    const a = { type: 'file', _id: 'c1', score: 0.9, parentFileId: 'p' } as unknown as RecallResult;
    const b = chunk('p', 'c2', 0.8, 'Results', 'papers/late.pdf');
    expect(groupRecallResults([a, b])[0]!.file?.path).toBe('papers/late.pdf');
  });

  it('falls back to the key rather than rendering an empty document name', () => {
    const orphan = { type: 'file', _id: 'c1', score: 0.9, parentFileId: 'ghost' } as unknown as RecallResult;
    expect(groupRecallResults([orphan])[0]!.file?.path).toBe('ghost');
  });
});

describe('recall grouping — helpers', () => {
  it('groups a chunk under its parent and a whole file under itself', () => {
    expect(fileGroupKey(chunk('paper-1', 'c1', 0.9))).toBe('paper-1');
    expect(fileGroupKey(wholeFile('f1', 0.9, 'a.pdf'))).toBe('f1');
  });

  it('does not group anything that is not a file', () => {
    expect(fileGroupKey(memory('m1', 0.9))).toBeNull();
  });

  it('surfaces the heading a passage sits under, and nothing when there is none', () => {
    expect(chunkLabel(chunk('p', 'c1', 0.9, 'Method'))).toBe('Method');
    expect(chunkLabel(chunk('p', 'c2', 0.9))).toBeUndefined();
  });
});

describe('recall grouping — passage text', () => {
  const hit = (fields: Record<string, unknown>) => ({ type: 'file', _id: 'c1', ...fields }) as unknown as RecallResult;

  it('prefers the chunk content', () => {
    expect(passageText(hit({ content: 'Mean shoreline retreat was 1.4 metres per year.' })))
      .toBe('Mean shoreline retreat was 1.4 metres per year.');
  });

  it('falls back to the embedded text, which is what actually matched', () => {
    expect(passageText(hit({ matchedText: 'Results Mean shoreline retreat…' }))).toBe('Results Mean shoreline retreat…');
  });

  it('returns undefined when there is no text, so the caller can fall back instead of rendering nothing', () => {
    expect(passageText(hit({}))).toBeUndefined();
    expect(passageText(hit({ content: '   ' }))).toBeUndefined();
  });

  it('collapses whitespace so a passage does not render as a ragged column', () => {
    expect(passageText(hit({ content: 'one\n\n  two\t\tthree' }))).toBe('one two three');
  });

  it('truncates a long passage with an ellipsis rather than flooding the card', () => {
    const out = passageText(hit({ content: 'x'.repeat(900) }))!;
    expect(out.length).toBe(400);
    expect(out.endsWith('…')).toBe(true);
  });
});
