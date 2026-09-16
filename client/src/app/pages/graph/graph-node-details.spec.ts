/**
 * Tapping a graph node fetches the record it actually IS.
 *
 * ## The defect
 *
 * A graph carries four kinds of node. Entities are stored records; a chrono entry, a memory or a file reached
 * through its `entityIds` link is a node too, and `TraverseNode.kind` says which. `loadNodeDetails` ignored
 * that and always called `getEntity`, so tapping any non-entity node issued a request that 404s. It is caught
 * — `catchError(() => of(null))` — so nothing breaks visibly: the detail drawer simply opens empty, with no
 * indication that anything was asked for or refused.
 *
 * That was invisible until the synthetic-edge id collision was fixed. Before it, chrono/memory/file links
 * never reached the canvas at all, so nobody could tap one.
 *
 * ## Why `getRecord` rather than a switch here
 *
 * `BrainApi.getRecord(spaceId, type, id)` exists and its docblock states the reason: the dispatch *"lives
 * here, next to the four getters it dispatches to, rather than being re-derived by every view that meets a
 * typed id"*. A `switch (kind)` in this component would be the second copy — the defect this codebase
 * produces most.
 *
 * ## What CANNOT be fetched, and is said rather than hidden
 *
 * A file node's record is addressed by PATH (`getFileMeta(spaceId, path)`), and a graph node carries an id.
 * A synthetic edge has no stored record at all — its id is `<label>:<from>:<to>`, derived at render time.
 * Neither can be loaded, so the panel says so. An empty panel and an unfetchable record look identical to a
 * user, and only one of them is true.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { GraphComponent } from './graph.component';

/** Records every getter the component reaches for, so a test can assert WHICH collection was asked. */
function makeApi(calls: string[]) {
  return {
    getMe: () => of({ readOnly: false }),
    listSpaces: () => of({ spaces: [] }),
    getSpaceMeta: () => of({ typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    queryBrain: () => of({ results: [], collection: 'chrono', count: 0 }),
    getRecord: (_s: string, type: string, id: string) => {
      calls.push(`getRecord:${type}:${id}`);
      return of({ _id: id, name: `record-${id}`, type });
    },
    getEntity: (_s: string, id: string) => {
      calls.push(`getEntity:${id}`);
      return of({ _id: id, name: `entity-${id}`, type: 'person' });
    },
    getEdge: (_s: string, id: string) => {
      calls.push(`getEdge:${id}`);
      return throwError(() => new Error('404'));
    },
  } as any;
}

describe('a graph node opens the record it is', () => {
  let calls: string[];

  function create() {
    calls = [];
    TestBed.configureTestingModule({
      imports: [GraphComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi(calls) },
        { provide: BrainApi, useValue: makeApi(calls) },
        { provide: AuthApi, useValue: makeApi(calls) },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
      ],
    });
    const fixture = TestBed.createComponent(GraphComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('an entity node still fetches an entity — this changes nothing for the common case', () => {
    const c = create().componentInstance as any;
    c.loadNodeDetails('e1', undefined);
    expect(calls.some(x => x.startsWith('getRecord:entity:e1') || x === 'getEntity:e1')).toBe(true);
  });

  for (const kind of ['fact', 'chrono']) {
    it(`a ${kind} node fetches a ${kind}, not an entity`, () => {
      // The defect, stated per kind: every one of these used to issue `getEntity` and 404.
      const c = create().componentInstance as any;
      c.loadNodeDetails('x1', kind);
      expect(calls).toContain(`getRecord:${kind}:x1`);
      expect(calls.some(x => x.startsWith('getEntity:'))).toBe(false);
    });
  }

  it('a file node fetches nothing and says why', () => {
    /*
     * A file's record is addressed by PATH and a graph node carries an id, so there is no request to make.
     * Firing one anyway is what produced the silent 404; saying nothing is what produced the empty panel.
     */
    const c = create().componentInstance as any;
    c.loadNodeDetails('f1', 'file');
    expect(calls.length, `expected no fetch, got: ${calls.join(', ')}`).toBe(0);
    expect(c.recordUnavailable()).toBeTruthy();
  });

  it('a synthetic edge fetches nothing and says why', () => {
    // `<label>:<from>:<to>`, derived at render time — there is no stored edge with that id.
    const c = create().componentInstance as any;
    c.loadEdgeDetails({ _id: 'mentions:a:b', label: 'mentions', from: 'a', to: 'b' });
    expect(calls.some(x => x.startsWith('getEdge:')), `got: ${calls.join(', ')}`).toBe(false);
    expect(c.recordUnavailable()).toBeTruthy();
  });

  it('a real edge is still fetched — a UUID is not synthetic', () => {
    // The other direction. Treating every edge as synthetic would empty the panel for the stored ones too,
    // which is the same bug with the sign flipped.
    const c = create().componentInstance as any;
    c.loadEdgeDetails({ _id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', label: 'knows', from: 'a', to: 'b' });
    expect(calls).toContain('getEdge:3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('the TAP path passes the kind — a branch nothing feeds is inert', async () => {
    /*
     * The half a method-level test cannot see, and the one that was briefly wrong here: `loadNodeDetails`
     * grew a `kind` parameter and its three call sites went on passing an id alone, so every assertion above
     * passed while the real tap still fetched an entity and 404ed.
     *
     * Read from source rather than driven through cytoscape, which is mocked to a no-op proxy in this suite —
     * a tap cannot actually be dispatched here, so the wiring is what there is to check.
     */
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/app/pages/graph/graph.component.ts', 'utf8'));
    const calls = [...src.matchAll(/this\.loadNodeDetails\(([^)]*)\)/g)].map(m => m[1]);
    expect(calls.length, 'no call sites found — re-anchor this check').toBeGreaterThanOrEqual(3);
    /*
     * `root._id` is exempt and only that. The root is the entity the graph is DRAWN AROUND — `selectRoot`
     * takes an `Entity`, which has no `kind` because it is one. Every other call site holds a `TraverseNode`,
     * which does.
     */
    const idOnly = calls.filter(a => !a.includes(',') && a.trim() !== 'root._id');
    expect(idOnly, `these hold a node and pass its id alone, so it opens the wrong collection: ${idOnly}`)
      .toEqual([]);
  });

  it('the dispatch is not re-derived here', async () => {
    // `getRecord` owns the kind → getter switch, next to the getters. A `case 'chrono':` in this component
    // would be the second copy, and the two would drift the day a fifth kind appears.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('src/app/pages/graph/graph.component.ts', 'utf8'));   // vitest runs from client/
    const body = src.slice(src.indexOf('loadNodeDetails('), src.indexOf('\n  }', src.indexOf('loadNodeDetails(')));
    expect(body).not.toMatch(/case\s+'(memory|chrono)'/);
  });
});
