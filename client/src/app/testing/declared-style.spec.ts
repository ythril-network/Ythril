/**
 * The stylesheet reader the vote specs lean on, held to what it claims: it reads a rule, an inline style and
 * inheritance by nearest declaration, and it names a box that cuts text off. A reader that answers "nothing
 * declared" for everything would make every spec built on it pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { declaredNearest, declaredValue, elementHolding, truncationAround } from './declared-style';

describe('declared-style', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.head.innerHTML = `<style>
      .clipped { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wraps { white-space: pre-line; overflow-wrap: anywhere; }
      .clamped { -webkit-line-clamp: 2; }
    </style>`;
    document.body.innerHTML = `<div id="root" class="clipped"><p class="wraps"><span id="t">hello</span></p></div>
      <div id="inline" style="white-space: nowrap"><b id="deep">x</b></div><div id="c" class="clamped"><i id="ci">y</i></div>`;
    root = document.getElementById('root')!;
  });

  it('reads a declaration from a rule and from an inline style, and null where nothing declares it', () => {
    expect(declaredValue(root, 'text-overflow')).toBe('ellipsis');
    expect(declaredValue(document.getElementById('inline')!, 'white-space')).toBe('nowrap');
    expect(declaredValue(document.getElementById('t')!, 'text-overflow')).toBeNull();
  });

  it('resolves an inherited property to the NEAREST declaration', () => {
    const t = document.getElementById('t')!;
    expect(declaredNearest(t, 'white-space', root)).toBe('pre-line');
    expect(declaredNearest(t, 'overflow-wrap', root)).toBe('anywhere');
  });

  it('names a box that cuts the text off, however far above the text it sits', () => {
    const t = document.getElementById('t')!;
    expect(truncationAround(t, root).join(' ')).toContain('text-overflow ellipsis');
    expect(truncationAround(document.getElementById('deep')!, document.getElementById('inline')!).join(' ')).toContain('nowrap');
    expect(truncationAround(document.getElementById('ci')!, document.getElementById('c')!).join(' ')).toContain('line-clamp');
    expect(truncationAround(t, t)).toEqual([]);
  });

  it('finds the smallest element holding a string', () => {
    expect(elementHolding(root, 'hello')?.id).toBe('t');
  });
});
