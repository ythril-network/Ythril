/**
 * `graph-linked-fetch` — what the side panel lists for a node or an edge (split out by `Q-162`).
 *
 * Pins the per-half fallback (a failing chrono lookup must not take the memories with it) and the edge's
 * asymmetric narrowing, which is preserved as found and characterized on the component as well.
 */
import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { linkedToNode, linkedToEdge, narrowToEdge } from './graph-linked-fetch';

const api = (facts: unknown[], chrono: unknown[] | Error) => ({
  listFacts: vi.fn(() => of({ facts, limit: 100, skip: 0 } as any)),
  chronoLinkedTo: vi.fn(() => (chrono instanceof Error ? throwError(() => chrono) : of(chrono as any))),
});

describe('linkedToNode', () => {
  it('asks for the records linked to the entity', async () => {
    const a = api([{ _id: 'm1' }], [{ _id: 'c1' }]);
    const got = await firstValueFrom(linkedToNode(a as any, 's1', 'e1'));
    expect(got).toEqual({ facts: [{ _id: 'm1' }], chrono: [{ _id: 'c1' }] });
    expect(a.listFacts).toHaveBeenCalledWith('s1', 100, 0, { entity: 'e1' });
    expect(a.chronoLinkedTo).toHaveBeenCalledWith('s1', 'e1');
  });

  it('a failing half lists nothing and leaves the other half on screen', async () => {
    const got = await firstValueFrom(linkedToNode(api([{ _id: 'm1' }], new Error('down')) as any, 's1', 'e1'));
    expect(got).toEqual({ facts: [{ _id: 'm1' }], chrono: [] });
  });
});

describe('narrowToEdge', () => {
  it('keeps a memory that references `to`, but chrono only when it references both ends', () => {
    const got = narrowToEdge({
      facts: [
        { _id: 'both', linkEntities: ['a', 'b'] },
        { _id: 'to-only', linkEntities: ['b'] },
        { _id: 'from-only', linkEntities: ['a'] },
        { _id: 'none' },
      ] as any,
      chrono: [
        { _id: 'c-both', linkEntities: ['a', 'b'] },
        { _id: 'c-to-only', linkEntities: ['b'] },
      ] as any,
    }, 'a', 'b');
    expect(got.facts.map(f => f._id)).toEqual(['both', 'to-only']);
    expect(got.chrono.map(c => c._id)).toEqual(['c-both']);
  });

  it('linkedToEdge fetches for the `from` end and narrows', async () => {
    const a = api([{ _id: 'm', linkEntities: ['a', 'b'] }], [{ _id: 'c', linkEntities: ['b'] }]);
    const got = await firstValueFrom(linkedToEdge(a as any, 's1', 'a', 'b'));
    expect(a.listFacts).toHaveBeenCalledWith('s1', 100, 0, { entity: 'a' });
    expect(got).toEqual({ facts: [{ _id: 'm', linkEntities: ['a', 'b'] }], chrono: [] });
  });
});
