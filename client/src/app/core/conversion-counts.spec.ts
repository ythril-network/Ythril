/**
 * What the conversion dialog may say about a type's records BEFORE the run (bundle-285, plan section 3.1 item 3): how many the type holds,
 * how many the steps would rewrite, how many would only be stamped, and what is not known until the run.
 *
 * The rule each test holds: the counts say what the STEPS change (the server's own rule for a rewrite, `convertedRecord`), asked of the
 * `filter` tool's exact `total`; forks are left alone by a run, so no count includes them; a number the server cannot give before the run
 * (how many records a split sends to each type) is never made up; and a count that was not obtained is never turned into a zero.
 *
 * ## Seen red
 *
 * Red on main 2ac9a2b1: `core/conversion-counts.ts` does not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  blockRecordsFilter, rewriteScopeOf, rewrittenFilter, blockCounts, type ConvertBlock,
} from './conversion-counts';
import type { ConversionStep } from './conversion.types';

const renameCompany: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };
const mapStatus: ConversionStep = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { active: 'on', gone: 'off' } };
const block = (steps: ConversionStep[], extra: Partial<ConvertBlock> = {}): ConvertBlock => ({ kind: 'entity', type: 'person', steps, ...extra });

describe('the records a block counts', () => {
  it('are the records of the type, never an array that merely holds the name, and never a fork row', () => {
    expect(blockRecordsFilter(block([]))).toEqual({ type: { $eq: 'person', $not: { $type: 'array' } }, forkOf: null });
  });

  it('are counted under the OLD name when the type was renamed: its records still carry it', () => {
    const renamed = block([{ op: 'renameType', kind: 'entity', from: 'client', to: 'customer' }], { type: 'customer', was: 'client' });
    expect(blockRecordsFilter(renamed)).toEqual({ type: { $eq: 'client', $not: { $type: 'array' } }, forkOf: null });
  });

  it('an edge is counted by its label, the field its type is kept in', () => {
    expect(blockRecordsFilter({ kind: 'edge', type: 'works_at', steps: [] }))
      .toEqual({ label: { $eq: 'works_at', $not: { $type: 'array' } }, forkOf: null });
  });

  // Each kind's collection is driven through `countsFor` (conversion-api.service.spec.ts), where it decides the request: a table here would only restate the constant.
});

describe('which records the steps rewrite', () => {
  it('none, for a block with no step: every record is only stamped', () => {
    expect(rewriteScopeOf(block([]))).toEqual({ scope: 'none' });
    expect(rewrittenFilter(block([]))).toBeNull();
  });

  it('a property rename rewrites the records that HAVE the old property', () => {
    expect(rewriteScopeOf(block([renameCompany]))).toEqual({ scope: 'some', clause: { $or: [{ 'properties.company': { $exists: true } }] } });
  });

  it('a value map rewrites the records whose property holds one of the mapped values', () => {
    expect(rewriteScopeOf(block([mapStatus])))
      .toEqual({ scope: 'some', clause: { $or: [{ 'properties.status': { $in: ['active', 'gone'] } }] } });
  });

  it('a map after a rename is asked of the STORED name: the old one, since the records still carry it', () => {
    const renameStatus: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'status', to: 'state' };
    const mapState: ConversionStep = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'state', values: { active: 'on' } };
    const scope = rewriteScopeOf(block([renameStatus, mapState]));
    expect(scope).toEqual({
      scope: 'some',
      clause: { $or: [{ 'properties.status': { $exists: true } }, { 'properties.status': { $in: ['active'] } }] },
    });
    expect(JSON.stringify(scope), 'a clause names the NEW property name').not.toContain('properties.state');
  });

  it('a type step moves every record of the type: all of them, whatever else the block holds', () => {
    const rename: ConversionStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
    expect(rewriteScopeOf(block([rename, renameCompany], { type: 'customer', was: 'client' }))).toEqual({ scope: 'all', split: false });
    const split: ConversionStep = { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'kind == "org"', to: 'organization' }], otherwise: 'person' };
    expect(rewriteScopeOf({ kind: 'entity', type: 'contact', steps: [split] })).toEqual({ scope: 'all', split: true });
    expect(rewrittenFilter(block([rename], { type: 'customer', was: 'client' }))).toBeNull();
  });

  it('a step that names another type or kind is not this block\'s', () => {
    const other: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'organization', from: 'a', to: 'b' };
    const otherKind: ConversionStep = { op: 'renameProperty', kind: 'fact', type: 'person', from: 'a', to: 'b' };
    expect(rewriteScopeOf(block([other, otherKind]))).toEqual({ scope: 'none' });
  });

  it('the filter of the rewritten records is the block\'s records, forks left out, narrowed by the clause', () => {
    expect(rewrittenFilter(block([renameCompany]))).toEqual({
      type: { $eq: 'person', $not: { $type: 'array' } }, forkOf: null, $or: [{ 'properties.company': { $exists: true } }],
    });
  });
});

describe('the counts a block shows', () => {
  it('stamped is what the steps do not change: 640 records, 599 rewritten, 41 only stamped', () => {
    expect(blockCounts(block([renameCompany]), { total: 640, rewritten: 599 })).toEqual({
      total: 640, rewritten: 599, stamped: 41, casesCountedAsItRuns: false, wholeType: false,
    });
  });

  it('two steps are counted for the type as a whole, not for each step', () => {
    expect(blockCounts(block([renameCompany, mapStatus]), { total: 10, rewritten: 4 }).wholeType).toBe(true);
    expect(blockCounts(block([renameCompany]), { total: 10, rewritten: 4 }).wholeType).toBe(false);
  });

  it('no step: nothing is rewritten, and no count of rewritten records is needed', () => {
    expect(blockCounts(block([]), { total: 212, rewritten: null })).toMatchObject({ total: 212, rewritten: 0, stamped: 212 });
  });

  it('a type step rewrites all of them, and needs no count of rewritten records', () => {
    const rename: ConversionStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
    expect(blockCounts(block([rename], { type: 'customer', was: 'client' }), { total: 212, rewritten: null }))
      .toEqual({ total: 212, rewritten: 212, stamped: 0, casesCountedAsItRuns: false, wholeType: false });
  });

  it('a split says how many go to each type is counted as the run goes, and gives no per-case number', () => {
    const split: ConversionStep = { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'kind == "org"', to: 'organization' }], otherwise: 'person' };
    const counts = blockCounts({ kind: 'entity', type: 'contact', steps: [split] }, { total: 318, rewritten: null });
    expect(counts).toEqual({ total: 318, rewritten: 318, stamped: 0, casesCountedAsItRuns: true, wholeType: false });
    expect(Object.keys(counts).filter(k => /case|match/i.test(k)), 'a per-case number the server cannot give').toEqual(['casesCountedAsItRuns']);
  });

  it('refuses to guess: a block whose steps need a count of rewritten records and has none throws, never answers zero', () => {
    expect(() => blockCounts(block([renameCompany]), { total: 640, rewritten: null })).toThrow(/rewritten/);
  });

  it('never answers more rewritten than there are records (two reads, taken a moment apart)', () => {
    expect(blockCounts(block([renameCompany]), { total: 10, rewritten: 12 })).toMatchObject({ total: 10, rewritten: 10, stamped: 0 });
  });
});
