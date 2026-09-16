import { describe, it, expect } from 'vitest';
import { layoutErModel } from './er-layout';
import type { ErEntityType, ErRelationship } from '../../core/api.types';

/** A realistic messy space: 24 types, uneven properties, 30 joins, links from all three kinds. */
function bigModel(): { types: ErEntityType[]; rels: ErRelationship[] } {
  const types: ErEntityType[] = [];
  for (let i = 0; i < 24; i++) {
    types.push({
      type: `type_${i}`,
      count: (i * 37) % 500,
      declared: i % 3 !== 0,
      properties: Array.from({ length: i % 6 }, (_, j) => ({ name: `p${j}`, type: 'string' as const, required: j === 0 })),
      linkedFrom: {
        facts: i % 2 === 0 ? (i + 1) * 3 : 0,
        chrono: i % 5 === 0 ? i + 2 : 0,
        files: i % 7 === 0 ? i : 0,
      },
    });
  }
  const rels: ErRelationship[] = [];
  for (let i = 0; i < 30; i++) {
    rels.push({ from: `type_${i % 24}`, to: `type_${(i * 5 + 3) % 24}`, label: `rel_${i}`, count: i + 1 });
  }
  return { types, rels };
}

describe('the diagram survives a big, uneven space', () => {
  const { types, rels } = bigModel();
  const out = layoutErModel(types, rels);

  it('every box is inside the reported canvas', () => {
    // "i saw edges go out of the diagram space completely" was reported on this panel. Boxes first.
    for (const b of out.boxes) {
      expect(b.x, b.type).toBeGreaterThanOrEqual(0);
      expect(b.y, b.type).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, b.type).toBeLessThanOrEqual(out.width);
      expect(b.y + b.h, b.type).toBeLessThanOrEqual(out.height);
    }
  });

  it('every path point is inside the canvas', () => {
    const nums = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    for (const p of out.paths) {
      for (const n of nums(p.d)) {
        expect(Number.isFinite(n), `${p.from}->${p.to}`).toBe(true);
      }
      const xs = nums(p.d);
      expect(Math.min(...xs), `${p.from}->${p.to}`).toBeGreaterThanOrEqual(-1);
      expect(Math.max(...xs)).toBeLessThanOrEqual(Math.max(out.width, out.height) + 1);
    }
  });

  it('no two boxes overlap', () => {
    // The failure the owner saw as "stacked on top of each other".
    for (let i = 0; i < out.boxes.length; i++) {
      for (let j = i + 1; j < out.boxes.length; j++) {
        const a = out.boxes[i]!, b = out.boxes[j]!;
        const clear = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(clear, `${a.type} overlaps ${b.type}`).toBe(true);
      }
    }
  });

  it('the three kind boxes are present and joined', () => {
    const kinds = out.boxes.filter(b => b.kind !== 'entity');
    expect(kinds.map(b => b.kind).sort()).toEqual(['chrono', 'fact', 'file']);
    for (const k of kinds) {
      expect(out.paths.some(p => p.from === k.type), `${k.type} has no joins`).toBe(true);
    }
  });

  it('no join label sits on top of another', () => {
    // Reported: "labels overlap as well so you cant read anything". Same label position twice is the signal.
    const seen = new Set<string>();
    for (const p of out.paths) {
      const key = `${Math.round(p.labelX)},${Math.round(p.labelY)}`;
      expect(seen.has(key), `two labels at ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
