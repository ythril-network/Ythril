/**
 * The ER diagram's geometry, proven rather than eyeballed.
 *
 * ## The defect this exists for
 *
 * A hand-drawn mockup of this diagram shipped two faults that the owner caught by looking at it: a join that
 * ended 78 px short of the box it pointed at — a line into empty space — and a relationship drawn between two
 * types that have none. Both were possible because the coordinates were typed by hand.
 *
 * The layout computes every endpoint from the source and target rectangles, so the first fault cannot be
 * expressed. **This file is what turns that claim into a fact**: it walks every path the layout produces and
 * asserts each endpoint lies ON the perimeter of the box it belongs to. A future change to the routing that
 * reintroduces a floating endpoint fails here rather than in someone's eyes.
 */
import { describe, it, expect } from 'vitest';
import { layoutErModel, estimateLabelWidth, type ErBox } from './er-layout';
import type { ErEntityType, ErRelationship } from '../../core/api.types';

const type = (t: string, over: Partial<ErEntityType> = {}): ErEntityType => ({
  type: t, count: 1, declared: true, properties: [],
  linkedFrom: { facts: 0, chrono: 0, files: 0 }, ...over,
});
const rel = (from: string, to: string, label = 'rel', count = 1): ErRelationship => ({ from, to, label, count });

/** Every point in an orthogonal path: `M x y` then a run of `H x` / `V y`. */
function points(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let x = 0, y = 0;
  for (const cmd of d.match(/[MHV]\s*-?[\d.]+(\s+-?[\d.]+)?/g) ?? []) {
    const nums = (cmd.match(/-?[\d.]+/g) ?? []).map(Number);
    if (cmd[0] === 'M') { x = nums[0]!; y = nums[1]!; }
    else if (cmd[0] === 'H') { x = nums[0]!; }
    else { y = nums[0]!; }
    out.push({ x, y });
  }
  return out;
}

/** Is the point on the box's perimeter (within a hair, for float noise)? */
function onPerimeter(p: { x: number; y: number }, b: ErBox): boolean {
  const e = 0.01;
  const inX = p.x >= b.x - e && p.x <= b.x + b.w + e;
  const inY = p.y >= b.y - e && p.y <= b.y + b.h + e;
  const onVerticalEdge = (Math.abs(p.x - b.x) < e || Math.abs(p.x - (b.x + b.w)) < e) && inY;
  const onHorizontalEdge = (Math.abs(p.y - b.y) < e || Math.abs(p.y - (b.y + b.h)) < e) && inX;
  return onVerticalEdge || onHorizontalEdge;
}

describe('every join starts and ends on a box', () => {
  const types = [
    type('service', { properties: [{ name: 'tier', required: true }] }),
    type('person'), type('incident'), type('deployment'), type('document'),
  ];
  const rels = [
    rel('person', 'service', 'owns', 128),
    rel('deployment', 'service', 'targets', 1204),
    rel('service', 'incident', 'affects', 94),
    rel('service', 'service', 'depends_on', 216),
    rel('person', 'document', 'wrote', 287),
  ];

  it('no endpoint floats in empty space', () => {
    // The exact fault the owner spotted: a line that stopped 78px short of its target. Asserted over every
    // path rather than the one that was wrong, because the next one will be a different path.
    const { boxes, paths } = layoutErModel(types, rels);
    const byType = new Map(boxes.map(b => [b.type, b]));
    expect(paths.length).toBeGreaterThan(0);   // floor: an empty path list would pass every check below

    for (const p of paths) {
      const pts = points(p.d);
      const a = byType.get(p.from)!;
      const b = byType.get(p.to)!;
      expect(onPerimeter(pts[0]!, a),
        `${p.from} → ${p.to} (${p.label}) STARTS at ${JSON.stringify(pts[0])}, which is not on ${p.from}'s box ${JSON.stringify(a)}`,
      ).toBe(true);
      expect(onPerimeter(pts[pts.length - 1]!, b),
        `${p.from} → ${p.to} (${p.label}) ENDS at ${JSON.stringify(pts[pts.length - 1])}, which is not on ${p.to}'s box ${JSON.stringify(b)} — this is the line-into-the-void defect`,
      ).toBe(true);
    }
  });

  it('draws a join for every relationship, and invents none', () => {
    // The mockup's other fault was a line between two types with no relationship between them.
    const { paths } = layoutErModel(types, rels);
    expect(paths.map(p => `${p.from}|${p.label}|${p.to}`).sort())
      .toEqual(rels.map(r => `${r.from}|${r.label}|${r.to}`).sort());
  });

  it('drops a relationship naming a type the model does not report', () => {
    // Rather than drawing a line to a box that is not there. A truncated read can produce exactly this.
    const { paths } = layoutErModel([type('a')], [rel('a', 'ghost')]);
    expect(paths).toEqual([]);
  });

  it('a self-join leaves and re-enters the same box', () => {
    const { boxes, paths } = layoutErModel(types, rels);
    const self = paths.find(p => p.selfJoin)!;
    expect(self).toBeDefined();
    const box = boxes.find(b => b.type === self.from)!;
    const pts = points(self.d);
    expect(onPerimeter(pts[0]!, box)).toBe(true);
    expect(onPerimeter(pts[pts.length - 1]!, box)).toBe(true);
  });

  it('no two boxes overlap', () => {
    // A join can be correct and still unreadable if it runs under a box.
    const { boxes } = layoutErModel(types, rels);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.type} overlaps ${b.type}`).toBe(true);
      }
    }
  });

  it('is deterministic, so a re-render does not shuffle the diagram', () => {
    expect(JSON.stringify(layoutErModel(types, rels))).toEqual(JSON.stringify(layoutErModel(types, rels)));
  });

  it('an empty model is an empty layout rather than a throw', () => {
    expect(layoutErModel([], [])).toEqual({ boxes: [], paths: [], width: 0, height: 0 });
  });

  it('a type with no properties still gets a box with height', () => {
    const { boxes } = layoutErModel([type('bare')], []);
    expect(boxes[0]!.h).toBeGreaterThan(20);
  });
});

/**
 * ── A BIG, LOPSIDED MODEL — because the small even one was always fine ──────────────────────────────
 *
 * Owner, 2026-08-11: *"test the layout on a big dataset you emulate. i guess with only a few records that are
 * welldefined and evenly filled its ok but not in real wordl."* That is exactly what happened: the four-lane
 * scheme and the single-column treatment of unrelated types both look correct on six tidy types and fall apart
 * past that.
 *
 * So this dataset is deliberately un-tidy: 30 types, of which 14 are connected and 16 are isolated, property
 * counts from 0 to 9, and 22 relationships concentrated on one hub. The assertions are geometric invariants,
 * not snapshots — a snapshot of a diagram this size would be unreadable and would fail on every tweak.
 */
/**
 * The owner's model, in the shape that produced the screenshot: LONG join labels, several of them, all in one
 * gap. The big-model fixture above cannot exercise this — its labels are `in0` and `chain7`, six characters,
 * narrower than three lane widths, so `slot % 3` never re-collides there and a mutation of the cycle survives
 * it. Reported labels were `implements · 113`, `refines · 53` and a clipped `conflicts`.
 */
describe('er-layout with labels wider than the lane spacing', () => {
  // Annotated, which is what makes the fixture a CHECK rather than a shape: `ErProperty.type` is a union of
  // four literals, and without the return type `type: 'string'` widens to `string` and the whole array stops
  // being an `ErEntityType[]`. That is the error this fixes, and the reason `name` was implicitly `any`.
  const t = (name: string): ErEntityType => ({
    type: name, count: 9, declared: true,
    properties: [{ name: 'p0', type: 'string', required: true }],
    linkedFrom: { facts: 0, chrono: 0, files: 0 },
  });
  const LABELS = ['implements', 'refines', 'conflicts', 'requires', 'supersedes', 'contradicts', 'elaborates'];
  const types = [t('hub'), ...LABELS.map((_, i) => t(`spoke${i}`))];
  // Every join points AT the hub, so they all land in one gap and share one lane run.
  const rels = LABELS.map((label, i) => ({ from: `spoke${i}`, to: 'hub', label, count: 100 + i }));
  const out = layoutErModel(types, rels);

  it('gives the gap room for the widest label, not just for the lanes', () => {
    const widest = Math.max(...rels.map(estimateLabelWidth));
    for (const p of out.paths) {
      const x2 = p.labelX + estimateLabelWidth(p);
      for (const b of out.boxes) {
        const yOverlap = b.y < p.labelY + 6 && b.y + b.h > p.labelY - 10;
        expect(yOverlap && x2 > b.x && p.labelX < b.x + b.w,
          `${p.label} ends at ${x2.toFixed(0)} inside ${b.type} (widest label ${widest.toFixed(0)}px)`).toBe(false);
      }
    }
  });

  it('steps labels through enough heights that no two wide ones collide', () => {
    // HONEST NOTE: this passes with the `slot % 3` cycle too, and that is why the cycle was left alone —
    // see `er-layout.ts`. `labelY` starts from each join's OWN span, so two joins three lanes apart differ
    // in height for a reason the modulo never enters. Kept as an invariant guard on the gap sizing rather
    // than claimed as the test that drove a change: it would fire if a later edit put labels in a shared
    // column or flattened the spans.
    const boxes = out.paths.map(p => ({
      x1: p.labelX, x2: p.labelX + estimateLabelWidth(p), y: p.labelY, id: p.label,
    }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        expect(a.x1 < b.x2 && b.x1 < a.x2 && Math.abs(a.y - b.y) < 11,
          `"${a.id}" and "${b.id}" overlap in x and sit ${Math.abs(a.y - b.y).toFixed(0)}px apart`).toBe(false);
      }
    }
  });
});

describe('er-layout on a big, lopsided model', () => {
  const type = (name: string, props: number, count = 10): ErEntityType => ({
    type: name,
    count,
    declared: true,
    properties: Array.from({ length: props }, (_, i) => ({ name: `p${i}`, type: 'string', required: i === 0 })),
    linkedFrom: { facts: 0, chrono: 0, files: 0 },
  });

  const connected = Array.from({ length: 14 }, (_, i) => type(`joined${i}`, i % 10));
  const isolatedTypes = Array.from({ length: 16 }, (_, i) => type(`lonely${i}`, i % 4));
  const types = [...connected, ...isolatedTypes];

  // A hub with a fan of 12 in and 9 out, plus a self-join — the shape a real space grows into.
  const rels = [
    ...Array.from({ length: 8 }, (_, i) => ({ from: `joined${i + 1}`, to: 'joined0', label: `in${i}`, count: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => ({ from: 'joined0', to: `joined${i + 9}`, label: `out${i}`, count: i + 1 })),
    { from: 'joined0', to: 'joined0', label: 'parent', count: 3 },
    ...Array.from({ length: 8 }, (_, i) => ({ from: `joined${i + 1}`, to: `joined${i + 2}`, label: `chain${i}`, count: 1 })),
  ];

  const out = layoutErModel(types, rels);
  /*
   * Throws rather than returning `undefined`. Every caller here is asserting geometry about a box the layout
   * is supposed to have produced, so a missing one is a failure with a name — not a `TypeError` two lines
   * later reading "cannot read properties of undefined", which is what `!` would have bought.
   */
  /** The lane x of a join path, asserted — a `d` this pattern cannot read is a layout change, not a null. */
  const laneOf = (d: string): number => {
    const m = /^M[\d.]+ [\d.]+ H([\d.]+) V/.exec(d);
    if (!m) throw new Error(`join path does not start with the expected move/H/V shape: ${JSON.stringify(d)}`);
    return Number(m[1]);
  };

  const boxOf = (t: string): ErBox => {
    const b = out.boxes.find(x => x.type === t);
    if (!b) throw new Error(`the layout produced no box for type ${JSON.stringify(t)}`);
    return b;
  };

  it('places every type exactly once', () => {
    expect(out.boxes.length).toBe(types.length);
    expect(new Set(out.boxes.map(b => b.type)).size).toBe(types.length);
  });

  it('puts every ISOLATED type on the shelf, and nothing else there', () => {
    const shelf = out.boxes.filter(b => b.col === 3).map(b => b.type).sort();
    expect(shelf).toEqual(isolatedTypes.map(t => t.type).sort());
  });

  it('puts the whole shelf BELOW every joined box', () => {
    // The reported symptom was unrelated types stacked among the joined ones, pushing the meaningful part of
    // the diagram out of view.
    const joinedBottom = Math.max(...out.boxes.filter(b => b.col !== 3).map(b => b.y + b.h));
    for (const b of out.boxes.filter(b => b.col === 3)) {
      expect(b.y, `${b.type} must start below the joined picture`).toBeGreaterThanOrEqual(joinedBottom);
    }
  });

  it('FILLS each shelf row instead of stacking one per line', () => {
    const shelf = out.boxes.filter(b => b.col === 3);
    const rows = new Map();
    for (const b of shelf) rows.set(b.y, (rows.get(b.y) ?? 0) + 1);
    const counts = [...rows.values()];
    expect(counts.length, 'sixteen isolated types must not be sixteen rows').toBeLessThan(shelf.length);
    expect(Math.max(...counts), 'at least one row has to hold several').toBeGreaterThan(1);
    // Every row except the last is full — that is what "fills the space" means.
    const full = Math.max(...counts);
    const notLast = [...rows.keys()].sort((a, b) => a - b).slice(0, -1).map(y => rows.get(y));
    for (const n of notLast) expect(n).toBe(full);
  });

  it('keeps every shelf box inside the diagram width', () => {
    for (const b of out.boxes.filter(b => b.col === 3)) {
      expect(b.x + b.w, `${b.type} overflows the viewBox`).toBeLessThanOrEqual(out.width);
    }
  });

  it('gives every join its OWN lane — no two share a vertical run', () => {
    // The four-lane cycle is the defect: the fifth join reused the first one's lane, and from there each new
    // relationship landed on an existing line.
    const lanes = out.paths.filter(p => !p.selfJoin).map(p => {
      const m = /^M[\d.]+ [\d.]+ H([\d.]+) V/.exec(p.d);
      return m ? Number(m[1]) : NaN;
    });
    expect(lanes.every(Number.isFinite), 'every non-self join must run down a vertical lane').toBe(true);
    // Per SIDE. Two lanes in opposite gaps may share an x by coincidence and never touch, because each only
    // exists between its own pair of boxes — asserting global uniqueness was asserting something the design
    // never claimed, which is how a test fails on correct code.
    const perSide = new Map();
    for (const p of out.paths.filter(x => !x.selfJoin)) {
      const lane = laneOf(p.d);
      const key = 'lane:' + lane;
      expect(perSide.has(key), 'two joins on the same side share lane ' + lane).toBe(false);
      perSide.set(key, p);
    }
  });

  it('does not let a lane run through a box', () => {
    const boxes = out.boxes;
    for (const p of out.paths.filter(x => !x.selfJoin)) {
      const lane = laneOf(p.d);
      // Only boxes the lane VERTICALLY overlaps can be cut. A lane exists between its two endpoints' mid
      // heights, so a shelf box far below it shares an x range and is never crossed — checking x alone
      // reported the shelf as an obstruction and was wrong about the geometry.
      const yTop = Math.min(...[...p.d.matchAll(/[HV]([\d.]+)/g)].map(m => Number(m[1])), Infinity);
      const from = boxOf(p.from), to = boxOf(p.to);
      const lo = Math.min(from.y + from.h / 2, to.y + to.h / 2);
      const hi = Math.max(from.y + from.h / 2, to.y + to.h / 2);
      void yTop;
      for (const b of boxes) {
        const yOverlap = b.y < hi && b.y + b.h > lo;
        const inside = yOverlap && lane > b.x + 1 && lane < b.x + b.w - 1;
        expect(inside, `${p.from}->${p.to} lane at ${lane} cuts through ${b.type}`).toBe(false);
      }
    }
  });

  it('keeps every label TEXT clear of every box, not just its origin', () => {
    // The defect the previous assertions could not see. They checked where a label STARTS; the owner's
    // screenshot showed `implements · 113` and `refines · 53` ending on top of the next card, because the
    // gap grew with the number of lanes and never with the width of the text those lanes carry.
    for (const p of out.paths.filter(x => !x.selfJoin)) {
      const x2 = p.labelX + estimateLabelWidth(p);
      for (const b of out.boxes) {
        const yOverlap = b.y < p.labelY + 6 && b.y + b.h > p.labelY - 10;
        const xOverlap = x2 > b.x && p.labelX < b.x + b.w;
        expect(yOverlap && xOverlap,
          `${p.from}->${p.to} label runs from ${p.labelX.toFixed(0)} to ${x2.toFixed(0)}, into ${b.type}`,
        ).toBe(false);
      }
    }
  });

  it('does not let two labels whose TEXT overlaps share a height', () => {
    // The `(slot % 3)` re-collision: the fourth lane on a side reused the first lane's offset, and a label
    // wider than three lane widths still spans that lane's x. Origin proximity cannot catch it — the two
    // origins are 66 px apart, and the text is not.
    const boxes = out.paths.filter(p => !p.selfJoin)
      .map(p => ({ x1: p.labelX, x2: p.labelX + estimateLabelWidth(p), y: p.labelY, id: `${p.from}->${p.to}` }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const xOverlap = a.x1 < b.x2 && b.x1 < a.x2;
        expect(xOverlap && Math.abs(a.y - b.y) < 11,
          `${a.id} and ${b.id} labels overlap in x and sit within 11px of each other`).toBe(false);
      }
    }
  });

  it('separates the labels enough to be read', () => {
    // Not "no overlap at all" — two labels may share a y if they are far apart horizontally. The failure
    // reported was labels ON each other, so the invariant is that no two share BOTH coordinates closely.
    const labels = out.paths.map(p => ({ x: p.labelX, y: p.labelY, id: `${p.from}->${p.to}` }));
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const near = Math.abs(labels[i].x - labels[j].x) < 8 && Math.abs(labels[i].y - labels[j].y) < 11;
        expect(near, `${labels[i].id} and ${labels[j].id} labels sit on top of each other`).toBe(false);
      }
    }
  });

  it('every label says which side of its lane it hangs off', () => {
    for (const p of out.paths) expect(['start', 'end', 'middle']).toContain(p.labelAnchor);
  });

  it('stays deterministic — the same model twice is the same picture', () => {
    expect(layoutErModel(types, rels)).toEqual(out);
  });
});

/**
 * ── Memories, chrono and files are boxes too ─────────────────────────────────────────────────────
 *
 * The server has always scanned three extra collections per space to count, for every entity type, how many
 * facts, chrono entries and files point AT it through their `entityIds` — and the client rendered that in
 * ZERO places. So the diagram called itself the data model while showing one of four record kinds, and every
 * Overview load paid for the scan and got nothing back.
 *
 * The owner found it by asking: *"are facts and chronotypes missing in the er diagram?"*
 *
 * These are placed by the SAME column/lane/shelf machinery as the entity types, deliberately. A second
 * placement algorithm is how the two would come to disagree about spacing, and the lane work that fixed
 * overlapping joins would only have applied to half the picture.
 */
describe('kind boxes', () => {
  const kinds = (boxes: ErBox[]) => boxes.filter(b => b.kind !== 'entity').map(b => b.type);

  it('draws one box per kind that has links, and none for a kind with none', () => {
    // The floor of the whole feature: an empty box is a claim that something is there.
    const { boxes } = layoutErModel([
      type('person', { linkedFrom: { facts: 4, chrono: 0, files: 0 } }),
      type('service'),
    ], [rel('person', 'service')]);

    expect(kinds(boxes)).toEqual(['Memories']);
    expect(boxes.find(b => b.type === 'Memories')!.kind).toBe('fact');
  });

  it('one box per KIND, not per linked type', () => {
    // Three types linking facts is one Memories box with three joins, not three boxes.
    const { boxes, paths } = layoutErModel([
      type('a', { linkedFrom: { facts: 1, chrono: 0, files: 0 } }),
      type('b', { linkedFrom: { facts: 2, chrono: 0, files: 0 } }),
      type('c', { linkedFrom: { facts: 3, chrono: 0, files: 0 } }),
    ], [rel('a', 'b'), rel('b', 'c')]);

    expect(kinds(boxes)).toEqual(['Memories']);
    expect(paths.filter(p => p.from === 'Memories').map(p => p.to).sort()).toEqual(['a', 'b', 'c']);
  });

  it('the box total is the SUM, and each join carries its own count', () => {
    // Two numbers that must not be the same one: the box says how many facts link anywhere in this space,
    // the join says how many link to that type. Showing the total on every join would be wrong three times.
    const { boxes, paths } = layoutErModel([
      type('a', { linkedFrom: { facts: 2, chrono: 0, files: 0 } }),
      type('b', { linkedFrom: { facts: 5, chrono: 0, files: 0 } }),
    ], [rel('a', 'b')]);

    expect(boxes.find(b => b.type === 'Memories')!.count).toBe(7);
    expect(paths.find(p => p.from === 'Memories' && p.to === 'a')!.count).toBe(2);
    expect(paths.find(p => p.from === 'Memories' && p.to === 'b')!.count).toBe(5);
  });

  it('all three kinds appear when all three link', () => {
    const { boxes } = layoutErModel([
      type('a', { linkedFrom: { facts: 1, chrono: 2, files: 3 } }),
    ], []);
    expect(kinds(boxes)).toEqual(['Memories', 'Chrono', 'Files']);
    expect(boxes.filter(b => b.kind === 'entity').map(b => b.type)).toEqual(['a']);
  });

  it('a kind box never becomes the HUB', () => {
    // Memories link to everything, so a kind box is often the most connected thing on the diagram. Letting it
    // win would put "Memories" in the middle of a picture that is about the entity model.
    const { boxes } = layoutErModel([
      type('a', { linkedFrom: { facts: 9, chrono: 0, files: 0 } }),
      type('b', { linkedFrom: { facts: 9, chrono: 0, files: 0 } }),
      type('c', { linkedFrom: { facts: 9, chrono: 0, files: 0 } }),
    ], [rel('a', 'b')]);

    const hub = boxes.find(b => b.col === 1)!;
    expect(hub.kind).toBe('entity');
  });

  it('a name collision with a real type does not merge the two boxes', () => {
    // A space may declare an entity type called `Memories`. Two boxes with one name would have the layout
    // place one and draw both sets of joins into it, silently.
    const { boxes } = layoutErModel([
      type('Memories'),
      type('a', { linkedFrom: { facts: 3, chrono: 0, files: 0 } }),
    ], [rel('Memories', 'a')]);

    const named = boxes.filter(b => b.type.startsWith('Memories'));
    expect(named).toHaveLength(2);
    expect(named.filter(b => b.kind === 'entity')).toHaveLength(1);
    expect(named.filter(b => b.kind === 'fact')).toHaveLength(1);
  });

  it('a kind box is not a schema box: no properties, and a floor height', () => {
    const { boxes } = layoutErModel([
      type('a', { linkedFrom: { facts: 1, chrono: 0, files: 0 } }),
    ], []);
    const box = boxes.find(b => b.kind === 'fact')!;
    expect(box.h).toBeGreaterThan(0);
    // Same floor an empty entity type gets — a box, not a line.
    expect(box.h).toBe(boxes.find(b => b.type === 'a')!.h);
  });

  it('every entity box still reports kind `entity`', () => {
    // The field was added to every box, not just the new ones. A caller branching on it must never see
    // undefined for a type that was there before.
    const { boxes } = layoutErModel([type('a'), type('b')], [rel('a', 'b')]);
    expect(boxes.every(b => b.kind === 'entity')).toBe(true);
  });

  it('a model with no linkedFrom anywhere is byte-identical to before', () => {
    // The regression guard for every existing space: this feature must be invisible where there are no links.
    const types = [type('a'), type('b'), type('c')];
    const rels = [rel('a', 'b')];
    const { boxes, paths } = layoutErModel(types, rels);
    expect(boxes.map(b => b.type).sort()).toEqual(['a', 'b', 'c']);
    expect(paths).toHaveLength(1);
  });
});

/**
 * THREE HEIGHTS AT MOST, AND NEVER TWO IN ONE ROW.
 *
 * ## Whose rules these are
 *
 * The canary operator's owner, at a browser on a live 3.2.0 instance, 2026-08-20. His word for the diagram was
 * "salad", and two of his three complaints were about heights: *"non-uniform height entities"*, and boxes side
 * by side in a row having different heights so *"a row has no top line and no bottom line"*.
 *
 * The numbers behind it are theirs too, measured with `er_model` against their `infrastructure` space: 22
 * entity types with property counts from 0 to 10, eighteen of them between 4 and 8. Eight distinct property
 * counts meant eight distinct box heights and no horizontal line anywhere.
 *
 * ## Why these assertions and not a snapshot
 *
 * A snapshot of a 22-type diagram fails on every tweak and tells nobody which rule broke. These are the two
 * rules stated as properties, so a future change to the layout that reintroduces a ragged field fails on the
 * rule it broke.
 *
 * The fixture is deliberately built to a spread that WOULD produce many heights: property counts 0..9 across
 * ten types. A fixture whose types all had the same count would satisfy both rules without the code doing
 * anything, which is the vacuous pass this file exists to avoid.
 */
describe('er-layout box heights are bucketed, and rows are bands', () => {
  /** Ten types with property counts 0..9 — nine distinct natural heights before bucketing. */
  const spread = Array.from({ length: 10 }, (_, i) => type(`t${i}`, {
    properties: Array.from({ length: i }, (_, j) => ({ name: `p${j}`, type: 'string', required: false })),
  }));
  // Half point at the hub, half are pointed at by it, so both columns fill and rows can be compared.
  const hubbed = [
    ...[1, 2, 3, 4].map(i => rel(`t${i}`, 't0')),
    ...[5, 6, 7, 8, 9].map(i => rel('t0', `t${i}`)),
  ];
  const out = layoutErModel(spread, hubbed);

  it('the fixture really does have a spread of property counts', () => {
    // Without this the two assertions below pass on a model that could not have broken either rule.
    const distinct = new Set(spread.map(t => t.properties.length));
    expect(distinct.size).toBe(10);
    expect(out.boxes.length).toBeGreaterThanOrEqual(10);
  });

  it('collapses to AT MOST three distinct heights', () => {
    const heights = new Set(out.boxes.map(b => b.h));
    expect(heights.size).toBeLessThanOrEqual(3);
  });

  it('and never CLIPS a type — a bucket is as tall as its tallest member needs', () => {
    // The failure an average would produce: the 9-property type losing rows to look tidy. Buckets only ever
    // grow a box, so every box is at least the height its own properties need.
    for (const b of out.boxes) {
      const src = spread.find(t => t.type === b.type);
      if (!src) continue;                                  // a synthetic kind box has no source type
      const needed = 26 + Math.max(2, src.properties.length + 1) * 16 + 12;
      expect(b.h).toBeGreaterThanOrEqual(needed);
    }
  });

  it('the two columns are BANDS — same y, same height, per row', () => {
    // Rule 2, and the one they said matters most: rule 1 alone still permits a short box beside a tall one.
    const l = out.boxes.filter(b => b.col === 0).sort((a, b) => a.y - b.y);
    const r = out.boxes.filter(b => b.col === 2).sort((a, b) => a.y - b.y);
    expect(l.length).toBeGreaterThan(0);
    expect(r.length).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(l.length, r.length); i++) {
      expect(l[i]!.y).toBe(r[i]!.y);
      expect(l[i]!.h).toBe(r[i]!.h);
    }
  });

  it('a row has ONE top edge and ONE bottom edge', () => {
    // The same claim from the reader's side, which is how it was reported: group every box by its top edge and
    // require the group to share a bottom edge too.
    const byTop = new Map<number, number[]>();
    for (const b of out.boxes) {
      if (b.col === 1) continue;                           // the hub is centred against the columns by design
      const bottoms = byTop.get(b.y) ?? [];
      bottoms.push(b.y + b.h);
      byTop.set(b.y, bottoms);
    }
    for (const [top, bottoms] of byTop) {
      expect(new Set(bottoms).size, `row at y=${top} has ${new Set(bottoms).size} bottom edges`).toBe(1);
    }
  });

  it('the unlinked shelf is a band too', () => {
    // The shelf's rows are literal rows, and its row height was already the tallest box in it — but each box
    // kept its own height inside that slot, so a row of four had four bottom edges inside one band.
    const isolated = Array.from({ length: 5 }, (_, i) => type(`iso${i}`, {
      properties: Array.from({ length: i * 2 }, (_, j) => ({ name: `p${j}`, type: 'string', required: false })),
    }));
    const shelfOut = layoutErModel([...spread, ...isolated], hubbed);
    const shelf = shelfOut.boxes.filter(b => b.col === 3);
    expect(shelf.length).toBe(5);
    const rows = new Map<number, number[]>();
    for (const b of shelf) rows.set(b.y, [...(rows.get(b.y) ?? []), b.h]);
    for (const [y, hs] of rows) {
      expect(new Set(hs).size, `shelf row at y=${y} has ${new Set(hs).size} heights`).toBe(1);
    }
  });

  it('a uniform model collapses to ONE height, which is still "at most three"', () => {
    // The reason the split is by tercile of the TYPES rather than their proposed fixed `<=4 / 5-7 / >=8`:
    // those three numbers are right for a 22-type model with that spread and wrong for four types that all
    // have two properties, where two of the three buckets would be empty.
    const flat = Array.from({ length: 4 }, (_, i) => type(`f${i}`, {
      properties: [{ name: 'a', type: 'string', required: false }, { name: 'b', type: 'string', required: false }],
    }));
    const flatOut = layoutErModel(flat, [rel('f1', 'f0'), rel('f0', 'f2')]);
    expect(new Set(flatOut.boxes.map(b => b.h)).size).toBe(1);
  });
});

/**
 * The unlinked shelf spreads across the width it is GIVEN, not the width the columns needed.
 *
 * ## The report, and the correction to it
 *
 * The canary operator's owner, 2026-08-20: *"use the whole row for the unlinked listings"* — the shelf wraps
 * after four entries however wide the viewport is.
 *
 * His diagnosis was one step off in a way worth keeping, because "make it flow" was already done. The shelf
 * computes `perRow` from a width; that width was the DIAGRAM's own — three columns plus their gaps — so it was
 * never a four-column grid, just a width that happens to fit four. Widening the window could not help, because
 * nothing in the calculation read the window.
 *
 * ## What is asserted, and why the fixture is built the way it is
 *
 * Twelve isolated types, so a change in `perRow` is unmistakable rather than a one-box difference. And the
 * cases include a NARROWER container: the stage scrolls horizontally, so a narrow window must not squeeze the
 * shelf below what the joined columns already occupy — taking the minimum would reflow the shelf into a tall
 * stack while the part of the diagram that has meaning stayed exactly as wide as before, which is the failure
 * the shelf exists to have fixed.
 */
describe('er-layout — the shelf uses the available width', () => {
  const isolated = Array.from({ length: 12 }, (_, i) => type(`iso${i}`));
  const joined = [type('hub'), type('spoke')];
  const rels = [rel('spoke', 'hub')];
  const model = [...joined, ...isolated];

  /** How many shelf boxes share the topmost shelf row — i.e. `perRow`, observed. */
  const perRow = (availableWidth?: number): number => {
    const out = layoutErModel(model, rels, availableWidth);
    const shelf = out.boxes.filter(b => b.col === 3);
    expect(shelf.length, 'the fixture must produce a shelf').toBe(12);
    const top = Math.min(...shelf.map(b => b.y));
    return shelf.filter(b => b.y === top).length;
  };

  it('lays out the same as before when no width is given', () => {
    // The compatibility claim. Every existing caller and every spec above passes two arguments, so absence has
    // to mean "the previous behaviour" rather than "zero width".
    const fallback = perRow(undefined);
    expect(fallback).toBeGreaterThan(0);
    expect(perRow(0), 'zero is treated as absent, not as no room').toBe(fallback);
  });

  it('fits MORE per row when the container is wider', () => {
    const narrow = perRow(undefined);
    const wide = perRow(4000);
    expect(wide, `4000px must fit more than the diagram's own width did (${narrow})`).toBeGreaterThan(narrow);
  });

  it('and the reported width covers the shelf, or the SVG clips it', () => {
    // `width` sizes the viewBox. Once the shelf can be wider than the joined columns, reporting the columns'
    // width would cut the shelf off at the right edge — visible only as boxes that are not drawn.
    const out = layoutErModel(model, rels, 4000);
    const rightmost = Math.max(...out.boxes.map(b => b.x + b.w));
    expect(out.width).toBeGreaterThanOrEqual(rightmost);
  });

  it('but does not report the whole container when the shelf does not fill it', () => {
    // A shelf of two boxes in a 4000px container occupies what two boxes occupy. Reporting the container would
    // leave a lake of empty canvas that the stage would then offer to scroll.
    const twoOnly = [...joined, type('isoA'), type('isoB')];
    const out = layoutErModel(twoOnly, rels, 4000);
    expect(out.width).toBeLessThan(4000);
  });

  it('a NARROWER container never squeezes the shelf below the joined width', () => {
    // The stage scrolls, so a narrow window must not reflow the shelf into a tall stack while the joined part
    // stays as wide as it was. `Math.max`, not a straight swap.
    const fallback = perRow(undefined);
    expect(perRow(100), 'a 100px container must not narrow the shelf').toBe(fallback);
  });

  it('is monotonic in the width — more room never means fewer per row', () => {
    // A property rather than three points: any arithmetic slip in the fitting calculation shows up here even
    // where a single comparison would pass.
    const widths = [undefined, 600, 900, 1200, 1800, 2400, 3600];
    const counts = widths.map(w => perRow(w));
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, `width ${widths[i]} fits fewer than ${widths[i - 1]}`)
        .toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });
});
