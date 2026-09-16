/**
 * Where the ER diagram's boxes and joins go — pure, so the geometry can be proven rather than eyeballed.
 *
 * ## Why this is a module and not inline SVG
 *
 * The first hand-drawn version of this diagram shipped two defects into a mockup that the owner caught by
 * looking: a join that ended 78 px short of the box it pointed at, and a relationship drawn between two types
 * that have none. Both were possible because the coordinates were typed.
 *
 * Here every endpoint is COMPUTED from the source and target rectangles, so a path cannot terminate anywhere
 * except on a real edge of a real box — the defect stops being something to catch and becomes something that
 * cannot be expressed. `er-layout.spec.ts` asserts exactly that, over every path the layout produces.
 *
 * ## The layout, in one paragraph
 *
 * Three columns. The **hub** — the type with the most relationship endpoints — sits in the middle, because
 * that is what a reader is looking for and it keeps the longest joins short. Types that point AT the hub go
 * left, types the hub points at go right, and anything unrelated to it fills the right column afterwards.
 * Each column stacks top-down with a fixed gap. Joins leave a box's right or left face, run down their own
 * vertical lane, and enter the far box's opposite face; a self-join loops over the top of its own box.
 *
 * Lanes are assigned per join rather than shared, which is what stops two joins overlapping into a single
 * ambiguous line. That costs horizontal space and buys a diagram that can be read.
 */
import type { ErEntityType, ErRelationship } from '../../core/api.types';

export interface ErBox {
  type: string;
  x: number; y: number; w: number; h: number;
  /**
   * Column index, kept so a caller can group or animate by depth without recomputing it.
   *
   * `3` is the unconnected shelf along the bottom, which is not a column at all — it is a wrapping grid. It
   * keeps the same field because every caller wants the same thing from it: a way to tell these boxes apart
   * from the joined ones without re-deriving degree.
   */
  col: 0 | 1 | 2 | 3;
  /**
   * What this box represents.
   *
   * `'entity'` for a declared or observed entity type — every box was one of these until facts, chrono and
   * files joined the diagram. The other three are one box per KIND, carrying that kind's total, and they must
   * be drawn differently: they have no properties and no naming pattern, so styling them as an entity box
   * would present them as a type somebody declared.
   */
  kind: 'entity' | 'fact' | 'chrono' | 'file';
  /**
   * How many records this box stands for.
   *
   * Carried on the box so a KIND box is self-describing: its total lives on a synthetic type the caller cannot
   * look up in `entityTypes`, and having the renderer sum `linkedFrom` again would be a second computation of
   * a number the layout already had.
   */
  count: number;
}

export interface ErPath {
  from: string; to: string; label: string; count: number;
  /** The rendered path. Every point is derived from a box rectangle. */
  d: string;
  /** Where the label sits — on its own lane, stepped so neighbouring lanes do not collide. */
  labelX: number; labelY: number;
  /** Which side of the lane the text hangs off, so it never straddles its own line. */
  labelAnchor: 'start' | 'end' | 'middle';
  /** A self-join is drawn and read differently, so the caller does not have to infer it from `from === to`. */
  selfJoin: boolean;
}

export interface ErLayout {
  boxes: ErBox[];
  paths: ErPath[];
  width: number;
  height: number;
}

const BOX_W = 216;
const HUB_W = 248;
const GAP_Y = 24;
/** Horizontal gap between shelf boxes, and the gap between the joined picture and the shelf above it. */
const GAP_X = 20;
const SHELF_GAP = 40;
const COL_GAP = 120;
/**
 * One lane every 22 px, and the label nudged 5 px off its own line so glyphs do not sit astride the stroke.
 *
 * Module constants because BOTH the gap sizing and the path loop need them, and they were two literals: the
 * sizing said `n * 22` and the loop said `laneStep = 22`. Same number, written twice, in the two places that
 * must never disagree — if the loop's step grew, lanes would be drawn into a gap that was measured for the
 * old one.
 */
const LANE_STEP = 22;
const LABEL_NUDGE = 5;

/** Monospace advance at the label's rendered 10.5 px, rounded UP — see `estimateLabelWidth`. */
const LABEL_CHAR_W = 6.6;

/**
 * How wide a join label renders, as an upper bound.
 *
 * Exported so the spec measures the same text extent the layout reserved for. A test that re-derived this
 * would be checking the layout against a second guess, and the two could agree while both were wrong — which
 * is how `er-layout.spec.ts` passed through a clipped label: it asserted where a label's ORIGIN sits and said
 * nothing about where its text ENDS.
 *
 * The component renders `<label> · <count>` in `var(--font-mono)` at 10.5 px. A monospace advance is a fixed
 * fraction of the size, so character count times a rounded-up advance bounds any string rather than averaging
 * it — under-reserving would put text through a box, over-reserving only widens a gap.
 */
export const estimateLabelWidth = (r: { label: string; count: number }): number =>
  (r.label.length + 3 + String(r.count).length) * LABEL_CHAR_W;
const PAD = 16;
const HEAD_H = 26;
const ROW_H = 16;
/** The natural height of a box: its header plus a row per property, floored so an empty type is a box. */
const naturalHeight = (t: ErEntityType): number => HEAD_H + Math.max(2, t.properties.length + 1) * ROW_H + 12;

/**
 * AT MOST THREE DISTINCT BOX HEIGHTS IN A DIAGRAM, chosen once from the model's own distribution.
 *
 * ## Why, in the words of the person looking at it
 *
 * The canary operator's owner, at a browser on a live instance, 2026-08-20: *"a salad of edges"*, *"non-uniform
 * height entities"*, and the whole thing *"salad"*. Their post is a specification rather than a defect list,
 * and this is its first rule: not a height per entity, but three buckets chosen once for the whole diagram,
 * with a box taking its bucket's height and padding.
 *
 * The measurement behind it is theirs too, from `er_model` against their `infrastructure` space: 22 entity
 * types whose property counts run 0 to 10, with **eighteen of the twenty-two between 4 and 8**. Eight distinct
 * property counts, therefore eight distinct box heights, therefore no horizontal line anywhere in the picture.
 *
 * ## How the buckets are chosen, and why not their literal split
 *
 * They proposed `<=4 / 5-7 / >=8`, derived from their data — and said so, which is why it is not hardcoded
 * here. Those three numbers are right for a 22-type model with that spread and wrong for a model of four types
 * that all have two properties, where they would produce one bucket doing nothing and two empty.
 *
 * So the split is by TERCILE OF THE TYPES, not by fixed property counts: sort the types by property count and
 * cut where a third and two thirds of them fall. On their space that lands within a property of their own
 * split; on a uniform model it collapses to one bucket, which is correct — one height is *at most three*.
 *
 * **A bucket's height is the height its LARGEST member needs**, never an average. Averaging would clip the
 * properties of the tallest type in each bucket, and a diagram that hides a field to look tidy is worse than a
 * ragged one. So this only ever grows a box, never shrinks it.
 */
export function heightBuckets(types: readonly ErEntityType[]): (t: ErEntityType) => number {
  if (types.length === 0) return naturalHeight;
  const counts = types.map(t => t.properties.length).sort((a, b) => a - b);
  // Tercile boundaries by POSITION in the sorted list, so each bucket holds roughly a third of the types.
  const lo = counts[Math.floor(counts.length / 3)]!;
  const hi = counts[Math.floor((counts.length * 2) / 3)]!;

  /** The tallest natural height among types falling in a bucket, or 0 when the bucket is empty. */
  const ceilingFor = (pred: (n: number) => boolean): number =>
    types.filter(t => pred(t.properties.length)).reduce((h, t) => Math.max(h, naturalHeight(t)), 0);

  const heights = [
    ceilingFor(n => n <= lo),
    ceilingFor(n => n > lo && n <= hi),
    ceilingFor(n => n > hi),
  ];
  return (t: ErEntityType): number => {
    const n = t.properties.length;
    const h = n <= lo ? heights[0]! : n <= hi ? heights[1]! : heights[2]!;
    // An empty bucket cannot happen for a type that selects it, but a defensive floor costs nothing and a
    // zero height would collapse a box to a line — the exact failure `Math.max(2, …)` above guards against.
    return h > 0 ? h : naturalHeight(t);
  };
}

/** The three kinds that link INTO entities, and the label each one's box carries. */
const KINDS = [
  { key: 'facts', kind: 'fact' as const, label: 'Memories' },
  { key: 'chrono', kind: 'chrono' as const, label: 'Chrono' },
  { key: 'files', kind: 'file' as const, label: 'Files' },
] as const;

/**
 * Turn `linkedFrom` into boxes and joins.
 *
 * ## Why this exists at all
 *
 * The server scans three extra collections per space to count, for every entity type, how many facts,
 * chrono entries and files point AT it through their `entityIds`. It has always sent that as `linkedFrom`, and
 * the client rendered it in **zero places** — so the diagram claimed to be the data model while showing one of
 * four record kinds, and the space paid for the scan on every Overview load and got nothing back.
 *
 * The owner asked the question that found it: *"are facts and chronotypes missing in the er diagram?"*
 *
 * ## One box per KIND, not per record
 *
 * A space has thousands of facts and one idea of what a memory is. The box is the kind and its total; the
 * joins carry the per-type counts. Drawing a box per record would be a different diagram and an unreadable one.
 *
 * ## A kind with no links gets NO box
 *
 * Not an empty one. A space that has never linked a file must not reserve a lane for files — an empty box is a
 * claim that something is there.
 *
 * ## The names have to survive a collision
 *
 * A space may legitimately declare an entity type called `Memories`. Two types with one name would have the
 * layout place one box and draw both sets of joins into it, silently. So a synthetic name that is already
 * taken gets a suffix until it is not, and the kind is tracked by name in a map rather than by guessing from
 * the label later.
 */
function syntheticKinds(realTypes: ErEntityType[]): {
  types: ErEntityType[];
  rels: ErRelationship[];
  kindOf: Map<string, 'fact' | 'chrono' | 'file'>;
} {
  const taken = new Set(realTypes.map(t => t.type));
  const types: ErEntityType[] = [];
  const rels: ErRelationship[] = [];
  const kindOf = new Map<string, 'fact' | 'chrono' | 'file'>();

  for (const { key, kind, label } of KINDS) {
    const linked = realTypes.filter(t => (t.linkedFrom?.[key] ?? 0) > 0);
    if (linked.length === 0) continue;

    // Annotated, because `KINDS` is `as const` and an inferred literal type refuses the suffixed reassignment.
    let name: string = label;
    while (taken.has(name)) name = `${name} (${kind})`;
    taken.add(name);
    kindOf.set(name, kind);

    types.push({
      type: name,
      count: linked.reduce((n, t) => n + (t.linkedFrom?.[key] ?? 0), 0),
      declared: false,
      // No properties and no naming pattern: a memory has no schema of its own here, so the box is a name and
      // a count. `naturalHeight`'s floor of two rows is what keeps it a box rather than a line.
      properties: [],
      linkedFrom: { facts: 0, chrono: 0, files: 0 },
    });

    for (const t of linked) {
      rels.push({ from: name, to: t.type, label: 'links', count: t.linkedFrom![key] });
    }
  }
  return { types, rels, kindOf };
}

/** Relationship endpoints touching a type — how "central" it is, and so which type earns the middle. */
function degree(rels: ErRelationship[], type: string): number {
  return rels.reduce((n, r) => n + (r.from === type ? 1 : 0) + (r.to === type ? 1 : 0), 0);
}

/**
 * Build the layout.
 *
 * Deterministic for a given model: the same input produces the same picture, so a re-render does not shuffle
 * the diagram under someone's cursor.
 */
export function layoutErModel(
  realTypes: ErEntityType[],
  realRels: ErRelationship[],
  /**
   * How much width the diagram may USE, in CSS pixels — the stage's inner width, not the window's.
   *
   * ## Why this parameter exists, and why it is optional
   *
   * The canary operator's owner, 2026-08-20: *"use the whole row for the unlinked listings"* — the shelf wraps
   * after four entries however wide the viewport is. His diagnosis was one step off in a way that matters:
   * the shelf ALREADY flows to a width rather than to a fixed column count, but that width is the DIAGRAM's
   * own (three columns plus their gaps), so widening the window cannot help. It is not a four-column grid; it
   * is a width that happens to fit four.
   *
   * A pure function cannot know how much room it has been given, so the caller measures and passes it. That
   * makes this the one input to the layout that is not a fact about the MODEL, which is why it is optional and
   * why absence means "use the joined picture's own width" — the previous behaviour exactly. Every existing
   * caller and every spec keeps working, and a caller with no element to measure (a test, a server-side
   * render) is not forced to invent a number.
   *
   * It only ever WIDENS the shelf. The joined columns are unaffected: their width is what the lanes and labels
   * need, and stretching them would push the hub away from its neighbours to fill space.
   */
  availableWidth?: number,
): ErLayout {
  if (realTypes.length === 0) return { boxes: [], paths: [], width: 0, height: 0 };

  // Memories, chrono and files join the picture as boxes of their own — see `syntheticKinds`. From here down
  // they are ordinary types and relationships, deliberately: one placement algorithm, not two.
  const synth = syntheticKinds(realTypes);
  const types = [...realTypes, ...synth.types];
  const rels = [...realRels, ...synth.rels];

  /**
   * The hub is the most connected type; ties break on record count, which the server already sorted by.
   *
   * Chosen from the REAL types only. A facts box is frequently the most connected thing on the diagram —
   * facts link to everything — and letting it win would put "Memories" in the centre of a picture that is
   * supposed to describe the entity model. The kinds are context around that model, not the subject of it.
   */
  const hub = [...realTypes].sort((a, b) =>
    degree(rels, b.type) - degree(rels, a.type) || b.count - a.count)[0]!;

  /**
   * Rule 1's bucketed height, resolved ONCE for this diagram and used for every box in it.
   *
   * Over `types`, not `realTypes`: the synthetic Memories / Chrono / Files boxes are boxes on the same
   * picture, so a bucket chosen without them would put them outside every band. They carry no properties, so
   * they land in the shortest bucket, which is where a box with a count and no fields belongs.
   */
  const boxHeight = heightBuckets(types);

  const pointsAtHub = new Set(rels.filter(r => r.to === hub.type && r.from !== hub.type).map(r => r.from));
  const hubPointsAt = new Set(rels.filter(r => r.from === hub.type && r.to !== hub.type).map(r => r.to));

  /**
   * Unconnected types go on a SHELF at the bottom, not into a column.
   *
   * They used to fall into the right-hand column together with everything the hub points at, so on a real
   * space they were a tall centred stack of unrelated boxes with the joined ones hidden among them — and the
   * hub was vertically centred against that stack, pushing the part of the diagram that has meaning
   * off-screen. Reported directly: *"unconnected nodes should go on the bottom of the card and those
   * unconnected card should fill the space and not be centered and stacked on top of each other."*
   *
   * A type is unconnected when no relationship names it at all, self-joins included: a self-join is a
   * relationship and belongs in the connected picture.
   */
  const isolated = (t: ErEntityType): boolean => degree(rels, t.type) === 0;

  const left: ErEntityType[] = [];
  const right: ErEntityType[] = [];
  const shelf: ErEntityType[] = [];
  for (const t of types) {
    if (t.type === hub.type) continue;
    if (isolated(t)) shelf.push(t);
    else if (pointsAtHub.has(t.type)) left.push(t);
    else right.push(t);          // hubPointsAt, plus anything joined to something other than the hub
  }
  void hubPointsAt;

  /**
   * The column gap is SIZED FROM THE LANE COUNT, not fixed.
   *
   * Every join gets its own lane (see below), and the lanes live in the gaps either side of the hub. With a
   * constant 120 px gap, a model with nine joins on one side either overlapped them or drew them outside the
   * gap and across the boxes. So the joins are counted first, and the columns are placed around the space
   * their lanes actually need. A small model looks exactly as it did; a large one gets wider instead of
   * illegible.
   */
  /**
   * TWO PASSES, because the side a join runs on is a fact about the geometry and the geometry depends on how
   * many joins run on each side. Guessing the side from `pointsAtHub` and then deciding it again from `a.x <
   * b.x` in the path loop is what put a lane through a box, and what sent a same-column join out of the
   * diagram entirely — reported as *"i saw edges go out of the diagram space completely"*.
   *
   * Pass one places the columns at the old fixed gap purely to learn which column each type lands in. Nothing
   * from it is kept except that. Pass two sizes the gaps from the real counts and places the boxes for good.
   */
  const columnOf = (t: string): 0 | 1 | 2 =>
    t === hub.type ? 1 : left.some(x => x.type === t) ? 0 : 2;

  /**
   * Which gap a join's lane belongs in, decided once and reused by both the counting and the drawing.
   *
   * A join between two boxes in the SAME column has no gap between them, so it borrows the ADJACENT one and
   * leaves and enters on the same face. Previously it fell through the `a.x < b.x` test as right-to-left and
   * ran leftwards out of its own column — negative x for column 0, i.e. off the canvas.
   */
  const gapOf = (r: ErRelationship): 'L' | 'R' | null => {
    if (r.from === r.to) return null;                      // self-joins loop over their own box
    const cf = columnOf(r.from), ct = columnOf(r.to);
    if (cf === ct) return cf === 0 ? 'L' : 'R';            // same column: borrow the neighbouring gap
    return Math.min(cf, ct) === 0 ? 'L' : 'R';             // 0↔1 and 0↔2 use the left gap; 1↔2 the right
  };

  const placeable = rels.filter(r => types.some(t => t.type === r.from) && types.some(t => t.type === r.to));
  const onL = placeable.filter(r => gapOf(r) === 'L');
  const onR = placeable.filter(r => gapOf(r) === 'R');
  const nL = onL.length;
  const nR = onR.length;

  /**
   * The gap is sized for the LABEL TEXT as well as for the lanes, and that second half was missing.
   *
   * The lane count has grown the gap since joins started piling up. The label never entered the calculation:
   * it is placed at `lane + 5` and anchored `start`, so it grows RIGHTWARD out of its lane — and the next
   * thing rightward is the target column. `implements · 113` is sixteen characters, about 100 px rendered,
   * against a gap that could have twenty left after the lanes. Owner-reported 2026-08-14 with a screenshot
   * showing `implements · 113`, `refines · 53` and a clipped `conflicts` sitting on top of the next card.
   *
   * The width is ESTIMATED rather than measured, and that is a deliberate limit rather than an oversight:
   * this module is pure geometry with no DOM, which is what lets it be unit-tested without a browser. The
   * estimate is safe because the label renders in `var(--font-mono)` at 10.5 px — a monospace advance is a
   * fixed fraction of the size, so `chars × 0.62 × 10.5` is an upper bound for any glyph in the string
   * rather than an average that a wide character could beat. `LABEL_CHAR_W` is rounded up for the same
   * reason: over-reserving widens a gap, under-reserving puts text through a box.
   */
  const widestIn = (rs: ErRelationship[]): number => rs.reduce((w, r) => Math.max(w, estimateLabelWidth(r)), 0);

  // 20 px clear of the source face, one lane every 22, 5 px of nudge off the last lane, the widest label,
  // then 20 px clear of the target face.
  const gapFor = (n: number, widest: number): number =>
    Math.max(COL_GAP, 20 + n * LANE_STEP + LABEL_NUDGE + widest + 20);
  const gapL = gapFor(nL, widestIn(onL));
  const gapR = gapFor(nR, widestIn(onR));

  const colX = [PAD, PAD + BOX_W + gapL, PAD + BOX_W + gapL + HUB_W + gapR];

  /** A synthetic kind box, or an ordinary entity type. Read from the map rather than re-derived from the
   *  label, because a space may declare an entity type whose name matches one. */
  const kindFor = (name: string): ErBox['kind'] => synth.kindOf.get(name) ?? 'entity';

  const boxes: ErBox[] = [];

  /**
   * NEVER TWO HEIGHTS IN ONE ROW — the two columns advance in LOCKSTEP.
   *
   * The canary operator's second rule, and the one they said matters most: *"Within a row, every box takes the
   * height of the tallest bucket present in that row. A row then has a single top edge and a single bottom
   * edge. This is the rule that turns a ragged field into bands, and it is worth stating separately because
   * rule 1 alone still permits a short box beside a tall one."*
   *
   * Rule 1 gives at most three heights; it does not stop a 3-property box sitting beside an 8-property one. So
   * the left and right columns are no longer stacked independently. Row `i` takes the taller of its two boxes,
   * both boxes take that height, and both start at the same `y`. Where one column runs out, the row is just
   * the remaining box — nothing to align it against, and a phantom row would only add space.
   *
   * The cost is honest and small: a short box beside a tall one grows to match, so a column can be a little
   * taller than the sum of its natural heights. The gain is that every horizontal edge in the picture lines up
   * with another one, which is what a reader's eye follows and — per their own prerequisite argument — what
   * gives an orthogonal router consistent channels to run lines through.
   */
  const rows = Math.max(left.length, right.length);
  let rowY = PAD;
  for (let i = 0; i < rows; i++) {
    const l = left[i];
    const r = right[i];
    const rowH = Math.max(l ? boxHeight(l) : 0, r ? boxHeight(r) : 0);
    if (l) boxes.push({ type: l.type, x: colX[0]!, y: rowY, w: BOX_W, h: rowH, col: 0, kind: kindFor(l.type), count: l.count });
    if (r) boxes.push({ type: r.type, x: colX[2]!, y: rowY, w: BOX_W, h: rowH, col: 2, kind: kindFor(r.type), count: r.count });
    rowY += rowH + GAP_Y;
  }

  // The hub is centred against the taller of the two columns, so the picture is not bottom-heavy.
  const colHeight = (col: 0 | 2): number => {
    const inCol = boxes.filter(b => b.col === col);
    return inCol.length === 0 ? 0 : inCol[inCol.length - 1]!.y + inCol[inCol.length - 1]!.h - PAD;
  };
  const hubH = boxHeight(hub);
  const tallest = Math.max(colHeight(0), colHeight(2), hubH);
  boxes.push({ type: hub.type, x: colX[1]!, y: PAD + Math.max(0, (tallest - hubH) / 2), w: HUB_W, h: hubH, col: 1, kind: kindFor(hub.type), count: hub.count });

  const byType = new Map(boxes.map(b => [b.type, b]));
  const paths: ErPath[] = [];

  // Lanes are handed out per join so two never share a line. Left-side joins run in the gap before the hub,
  // right-side joins in the gap after it.
  /**
   * ONE LANE PER JOIN, and labels stepped down the lane.
   *
   * The lane index used to be `(n++ % 4)`, so the fifth join on a side reused the first join's lane and every
   * subsequent one piled onto an earlier line. The label was worse: `labelX` was the lane and `labelY` was the
   * top of that join's own span, so two joins sharing a lane put their labels at almost the same point.
   * Reported as *"edges overlap too much and labels overlap as well so you cant read anything"* — which is
   * exactly what an unbounded model does to a four-lane scheme.
   *
   * The gap has to grow with the number of joins, so `COL_GAP` is no longer a constant: the lanes are counted
   * first and the columns placed around them. A diagram that needs eighteen lanes gets a wider gap rather than
   * eighteen lines on top of each other.
   */
  let leftLane = 0;
  let rightLane = 0;

  /**
   * The label steps down by its FULL slot, not by `slot % 3`.
   *
   * ## Why a modulo was wrong here, and why the first diagnosis of it was also wrong
   *
   * ER-1 said the fourth lane on a side reuses the first lane's offset, so two joins sharing a `spanTop` end
   * up at the same height. A cycle derived from the label width was written to fix that — and removed,
   * because mutating it back to `% 3` passed every test including a fixture built for it.
   *
   * The screenshot showed what neither could: joins CONVERGING on one box all take their `spanTop` from that
   * box, so every one of them starts counting from the same y. `supersedes`, `contradicts` and `elaborates`
   * came out 13 px apart with lane lines running between them — not overlapping, which is why the specs were
   * quiet, and not readable either, which is what was reported.
   *
   * A modulo is the wrong tool for a shared origin. Three offsets is enough only while the joins that share
   * an origin are at most three; seven converge here, and a real model converges harder. Stepping by the full
   * slot spreads them down the span they all share, and `Math.min(spanBottom - 6, …)` still stops a label
   * leaving its own span — which is the same clamp as before and does the job the modulo was standing in for.
   *
   * The step goes to 15 for the same reason: 13 px between two ~11 px lines, with a lane drawn through the
   * gap, is the crowding the screenshot showed rather than a collision the arithmetic could catch.
   */
  const LABEL_STEP_Y = 15;

  for (const r of rels) {
    const a = byType.get(r.from);
    const b = byType.get(r.to);
    // A relationship naming a type the model did not report cannot be placed. Dropping it is the honest
    // answer — the alternative is a line to a box that is not there, which is the defect this file exists
    // to prevent.
    if (!a || !b) continue;

    if (r.from === r.to) {
      // Self-join: up out of the top face, across, and back down into it. Both ends are ON the top edge.
      const x1 = a.x + a.w * 0.35;
      const x2 = a.x + a.w * 0.65;
      const top = a.y;
      const arc = top - 26;
      paths.push({
        from: r.from, to: r.to, label: r.label, count: r.count, selfJoin: true,
        d: `M${x1} ${top} V${arc} H${x2} V${top}`,
        labelX: (x1 + x2) / 2, labelY: arc - 6, labelAnchor: 'middle',
      });
      continue;
    }

    // The gap is decided by `gapOf`, which the gap SIZING above used — so a lane can never be drawn into a
    // gap that was not measured for it. That agreement is the fix.
    const gap = gapOf(r);
    const sameCol = a.x === b.x;
    const inLeftGap = gap === 'L';
    const slot = inLeftGap ? leftLane++ : rightLane++;
    // The lane's home is the gap's own span, counted from the gap's left edge inward.
    const gapStart = inLeftGap ? colX[0]! + BOX_W : colX[1]! + HUB_W;
    const lane = gapStart + 20 + slot * LANE_STEP;

    const sy = a.y + a.h / 2;
    const ty = b.y + b.h / 2;
    // A same-column join leaves and enters the face that looks at its borrowed gap, so both ends stay on real
    // edges and the whole path stays inside the diagram.
    const faceRight = (box: ErBox): number => box.x + box.w;
    const sx = sameCol ? (inLeftGap ? faceRight(a) : a.x) : (a.x < b.x ? a.x + a.w : a.x);
    const tx = sameCol ? (inLeftGap ? faceRight(b) : b.x) : (a.x < b.x ? b.x : b.x + b.w);

    // The label sits ON its own lane, and steps DOWN it so two adjacent lanes never put their text at the
    // same height. `labelX` is nudged off the line itself so the glyphs do not sit astride the stroke.
    const spanTop = Math.min(sy, ty);
    const spanBottom = Math.max(sy, ty);
    const labelY = Math.min(spanBottom - 6, spanTop + 14 + slot * LABEL_STEP_Y);

    paths.push({
      from: r.from, to: r.to, label: r.label, count: r.count, selfJoin: false,
      d: `M${sx} ${sy} H${lane} V${ty} H${tx}`,
      labelX: lane + LABEL_NUDGE, labelY,
      labelAnchor: 'start',
    });
  }

  const width = colX[2]! + BOX_W + PAD;

  /**
   * The unconnected shelf: a wrapping grid across the full width, below everything joined.
   *
   * It FILLS the row before starting a new one, which is the whole point — these were a centred single-file
   * stack, so twelve unrelated types made the diagram three screens tall and pushed the joined part out of
   * view. Laid out after `width` is known, because how many fit per row is a function of the width the joined
   * part already needed.
   *
   * Row height is the tallest box in that row, not the tallest overall: a row of two-property types should not
   * be as tall as the one type that declares nine.
   */
  const joinedBottom = boxes.length > 0 ? Math.max(...boxes.map(b => b.y + b.h)) : PAD;
  let shelfBottom = joinedBottom;
  /**
   * The width the SHELF may spread across — the container's when we were told it, else the diagram's own.
   *
   * `Math.max` rather than a straight swap: a container NARROWER than the joined picture must not squeeze the
   * shelf below what the columns already occupy, because the stage scrolls horizontally anyway. Taking the
   * minimum would make a narrow window reflow the shelf into a tall stack while the part of the diagram that
   * has meaning stayed exactly as wide as before — the failure this whole shelf exists to have fixed.
   */
  const shelfWidth = Math.max(width, availableWidth ?? 0);
  if (shelf.length > 0) {
    const perRow = Math.max(1, Math.floor((shelfWidth - PAD * 2 + GAP_X) / (BOX_W + GAP_X)));
    let y = joinedBottom + SHELF_GAP;
    for (let i = 0; i < shelf.length; i += perRow) {
      const row = shelf.slice(i, i + perRow);
      // Rule 2 on the shelf, where the rows are literal. The row height was already the tallest box in it —
      // that part was right — but each box kept its OWN height inside that slot, so a row of four boxes had
      // four different bottom edges inside one band. Every box in the row takes the row's height now.
      const rowH = Math.max(...row.map(boxHeight));
      row.forEach((t, j) => {
        boxes.push({ type: t.type, x: PAD + j * (BOX_W + GAP_X), y, w: BOX_W, h: rowH, col: 3, kind: kindFor(t.type), count: t.count });
      });
      y += rowH + GAP_Y;
      shelfBottom = y - GAP_Y;
    }
  }

  const height = Math.max(joinedBottom, shelfBottom) + PAD;
  /*
   * The reported width has to cover the SHELF as well, or the SVG clips it.
   *
   * `width` is what the joined columns need. Once the shelf can be wider than that, returning `width` would
   * size the viewBox to the columns and cut the shelf off at the right — visible only as boxes that are
   * simply not drawn, with nothing to say why. So the answer is the widest row actually laid out.
   *
   * Computed from the boxes rather than from `shelfWidth`: a shelf of two boxes in a 2000-pixel container
   * occupies what two boxes occupy, and reporting the container would leave a lake of empty canvas that the
   * stage would then offer to scroll.
   */
  const occupied = boxes.length > 0 ? Math.max(...boxes.map(b => b.x + b.w)) : 0;
  return { boxes, paths, width: Math.max(width, occupied + PAD), height };
}
