import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PhIconComponent } from './ph-icon.component';
import { PluralPipe } from '../core/plural.pipe';

/** What a value is, for rendering. `null` is its own kind because `typeof null` is not useful here. */
export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** One visible line of the tree. Flat on purpose — see the component docblock. */
export interface JsonRow {
  /** Stable identity AND the collapse key: the slash-joined path from the root. */
  path: string;
  depth: number;
  /** The property name or array index this value sits under; `null` at the root. */
  key: string | null;
  kind: JsonKind;
  /** Children, for a container. Shown collapsed so the size is readable without expanding. */
  size: number;
  /** The scalar, rendered. Empty for a container — the row draws its own braces. */
  text: string;
  /** True when the row can be expanded at all. */
  container: boolean;
  /** Whether it is expanded right now. */
  open: boolean;
  /** The value itself, so a copy action does not have to walk the path again. */
  value: unknown;
}

const kindOf = (v: unknown): JsonKind => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'object': return 'object';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return 'string';
  }
};

const entriesOf = (v: unknown, kind: JsonKind): Array<[string, unknown]> =>
  kind === 'array'
    ? (v as unknown[]).map((x, i) => [String(i), x] as [string, unknown])
    : Object.entries(v as Record<string, unknown>);

/**
 * A JSON value as an expandable tree.
 *
 * ## Why a FLAT row list and not a recursive component
 *
 * A recall answer can be tens of thousands of characters — that is the whole reason the byte budget exists —
 * and a component per node would build thousands of instances to render a screenful. The rows here are
 * computed by walking only into what is OPEN, so the work is proportional to what you can actually see: a
 * collapsed hundred-element array costs one row, whatever is inside it.
 *
 * It also means collapsing is not a re-render of a subtree. It is a shorter list.
 *
 * ## Openness is an OVERRIDE map, not a set of open paths
 *
 * A path with no entry falls back to `depth < openTo`, so the default shape of a fresh value needs no reset
 * when the value changes — and a path the reader has explicitly opened or closed keeps that decision if the
 * same path appears again. Storing "the open set" instead would make every new answer arrive fully collapsed
 * or need an effect to re-seed it, and an effect that rewrites state on input change is the thing that makes
 * a signal graph hard to reason about.
 *
 * `expandAll` / `collapseAll` set a floor under the same map rather than enumerating paths, which is what
 * lets them work on a subtree that has not been built yet.
 */
@Component({
  selector: 'app-json-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, PhIconComponent, PluralPipe],
  styles: [`
    :host {
      display: block;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.65;
      /* A custom element is inline, so without this the border and background shrink-wrap the text. */
      min-width: 0;
    }
    .jt-row {
      display: flex;
      align-items: baseline;
      gap: 4px;
      padding: 0 6px;
      border-radius: var(--radius-sm);
      white-space: pre;
    }
    .jt-row:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); }
    .jt-row:hover .jt-copy { opacity: 1; }
    .jt-toggle {
      flex: none;
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      padding: 0;
      background: none;
      cursor: pointer;
      color: var(--text-muted);
      align-self: center;
    }
    .jt-toggle:hover { color: var(--text-primary); }
    /* Keeps a leaf's text on the same column as a container's, so the tree reads as one ladder. */
    .jt-toggle-spacer { flex: none; width: 14px; }
    .jt-label { color: var(--text-muted); }
    .jt-key { color: var(--text-primary); font-weight: 600; }
    .jt-punct { color: var(--text-muted); }
    .jt-size { color: var(--text-muted); font-style: italic; }
    .jt-string { color: var(--success, #2e7d32); }
    .jt-number { color: var(--brand, #1565c0); }
    .jt-boolean { color: var(--warning, #b26a00); }
    .jt-null { color: var(--text-muted); font-style: italic; }
    /* A long string wraps rather than pushing the row into a horizontal scroll of its own. */
    .jt-string { white-space: pre-wrap; word-break: break-word; }
    .jt-copy {
      flex: none;
      margin-left: 4px;
      border: 0;
      background: none;
      padding: 0 2px;
      cursor: pointer;
      color: var(--text-muted);
      opacity: 0;
      transition: opacity .12s ease;
    }
    .jt-copy:hover { color: var(--text-primary); }
    .jt-copy:focus-visible { opacity: 1; }
    .jt-empty { color: var(--text-muted); font-style: italic; padding: 2px 6px; }
  `],
  template: `
@if (rows().length) {
  @for (r of rows(); track r.path) {
    <div class="jt-row" [style.padding-left.px]="6 + r.depth * 14">
      @if (r.container) {
        <button type="button" class="jt-toggle" (click)="toggle(r)"
          [attr.aria-expanded]="r.open"
          [attr.aria-label]="(r.open ? 'Collapse ' : 'Expand ') + (r.key ?? 'root')">
          <ph-icon [name]="r.open ? 'caret-down' : 'caret-right'" [size]="12" />
        </button>
      } @else {
        <span class="jt-toggle-spacer"></span>
      }

      @if (r.key !== null) {
        <!-- ONE element, because the row is a flex container with a gap: two spans put a space between the
             key and its colon, which reads as a typo in a monospace block. -->
        <span class="jt-label"><span class="jt-key">{{ r.key }}</span>:</span>
      }

      @if (r.container) {
        <span class="jt-punct">{{ r.kind === 'array' ? '[' : '{' }}</span>
        @if (!r.open) {
          <span class="jt-punct">…{{ r.kind === 'array' ? ']' : '}' }}</span>
          <span class="jt-size">@if (r.kind === 'array') { {{ r.size | plural:'jsonTree.item' }} } @else { {{ r.size | plural:'jsonTree.key' }} }</span>
        }
      } @else {
        <span [class]="'jt-' + r.kind">{{ r.text }}</span>
      }

      <button type="button" class="jt-copy" (click)="copy(r)" [attr.title]="copied() === r.path ? 'Copied' : 'Copy'">
        <ph-icon [name]="copied() === r.path ? 'check' : 'copy'" [size]="11" />
      </button>
    </div>
  }
} @else {
  <div class="jt-empty">{{ emptyText() }}</div>
}
`,
})
export class JsonTreeComponent {
  readonly value = input<unknown>(null);
  /** The root's label. `null` renders the root's braces with no key in front of them. */
  readonly name = input<string | null>(null);
  /** How deep to open a value nobody has touched yet. 1 shows the root's own keys. */
  readonly openTo = input(1);
  readonly emptyText = input('nothing to show');

  /** Explicit reader decisions, by path. Absent means "whatever `openTo` says". */
  private readonly overrides = signal<ReadonlyMap<string, boolean>>(new Map());
  /** Set by expand/collapse all: a floor applied where there is no explicit override. */
  private readonly allMode = signal<boolean | null>(null);
  readonly copied = signal<string | null>(null);

  private isOpen(path: string, depth: number): boolean {
    const explicit = this.overrides().get(path);
    if (explicit !== undefined) return explicit;
    const all = this.allMode();
    if (all !== null) return all;
    return depth < this.openTo();
  }

  readonly rows = computed<JsonRow[]>(() => {
    const out: JsonRow[] = [];
    const walk = (val: unknown, key: string | null, path: string, depth: number): void => {
      const kind = kindOf(val);
      const entries = kind === 'object' || kind === 'array' ? entriesOf(val, kind) : [];
      /*
       * An EMPTY container is not expandable. Opening one would draw `{` and `}` on two lines with nothing
       * between them — an invitation to click, followed by nothing — so it renders `{}` inline as a leaf
       * and keeps its caret column blank.
       */
      const container = entries.length > 0;
      const open = container && this.isOpen(path, depth);
      out.push({
        path, depth, key, kind,
        size: entries.length,
        text: container ? '' : renderLeaf(val, kind, entries.length),
        container,
        open,
        value: val,
      });
      if (!open) return;
      for (const [k, v] of entries) walk(v, k, `${path}/${k}`, depth + 1);
      // The closing brace, as its own row, so a long object reads as a block rather than trailing off.
      out.push({
        path: `${path}#close`, depth, key: null, kind,
        size: 0, text: kind === 'array' ? ']' : '}', container: false, open: false, value: undefined,
      });
    };
    walk(this.value(), this.name(), '', 0);
    // A root that is `null`/undefined renders as one row saying so, which is more useful than an empty box —
    // but an EMPTY object or array should still draw itself, so only a truly absent value is "nothing".
    return this.value() === null || this.value() === undefined ? [] : out;
  });

  toggle(r: JsonRow): void {
    const next = new Map(this.overrides());
    next.set(r.path, !r.open);
    this.overrides.set(next);
  }

  expandAll(): void { this.allMode.set(true); this.overrides.set(new Map()); }
  collapseAll(): void { this.allMode.set(false); this.overrides.set(new Map()); }

  async copy(r: JsonRow): Promise<void> {
    const text = r.container || r.value !== undefined
      ? JSON.stringify(r.value, null, 2)
      : r.text;
    try {
      await navigator.clipboard.writeText(text ?? '');
      this.copied.set(r.path);
      setTimeout(() => this.copied.update(p => (p === r.path ? null : p)), 1200);
    } catch {
      // A clipboard the browser refuses is not worth an error state on a viewer — the value is on screen.
    }
  }
}

/**
 * A leaf as it should read in a tree: strings quoted, everything else bare — and an EMPTY container is a
 * leaf here, rendered as the two braces it is.
 */
function renderLeaf(v: unknown, kind: JsonKind, size: number): string {
  if (kind === 'array') return size === 0 ? '[]' : '';
  if (kind === 'object') return size === 0 ? '{}' : '';
  if (kind === 'string') return JSON.stringify(v);
  if (kind === 'null') return v === undefined ? 'undefined' : 'null';
  return String(v);
}
