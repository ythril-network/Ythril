import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { parentPath } from './file-format';

/**
 * One node of the directory tree in the file manager's sidebar.
 *
 * `children: null` means **not fetched yet** and `[]` would mean **fetched, and there are none**. The
 * difference decides whether expanding issues a request at all, so a store that initialised children to `[]`
 * would give a tree whose folders can never be opened — with no error. Pinned in
 * `file-manager.characterization.spec.ts`.
 */
export interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null;
  /**
   * Why the last expand of THIS node failed, or null.
   *
   * The tree had no failure state at all: a failed expand reset the spinner, left the node closed, and said
   * nothing — the caret sprang back and that was the whole message. An operator did see something, but only
   * BY ACCIDENT: clicking a folder fires two identical requests, and the second one put the error on the
   * listing beside the tree. Every other load on this page has a visible failure state (`loadError`,
   * `refreshFailed`, `spacesError`); this is the tree's.
   *
   * Per node rather than one for the tree, because a failure belongs to the folder that could not be opened —
   * a single banner would leave an operator with two collapsed folders and no idea which one refused.
   */
  error: string | null;
}

/**
 * The directory tree in the file manager's sidebar — the markup, the styles and the keyboard.
 *
 * It is a WAI-ARIA tree (`Q-476`): `role="tree"`, a `treeitem` per folder holding its children in a `group`, `aria-expanded`,
 * `aria-current` on the folder being shown, ONE tab stop that follows the focus, and the arrow keys. What a key MEANS stays
 * the page's: this component reports `nodeClick` (Enter, Space, a click) and `toggleNode` (Right and Left) and moves the focus
 * between items itself, which is the one thing only it can do.
 *
 * ## Why it left the page
 *
 * G-3: `file-manager.component.ts` is the largest file in the repo, and this was the biggest block its shell
 * still rendered inline — a recursive template, six CSS rules and an interface. The gate that froze the file
 * says why in its own message: *"every change lands in the same place because that is where the code already
 * is."*
 *
 * It was also the last part of that page with no assertion anywhere. Ten characterization cases went in first,
 * as their own change, and were proven green against the unrefactored page (#1114) — which is what makes this
 * cut checkable rather than hopeful. One of those cases exists because of the trap below.
 *
 * ## The nodes are mutated in place, and that is why the page hands over an ARRAY
 *
 * `node.expanded = false`, `node.children = [...]`, `node.loading = true` — every one of those mutates a node
 * the page already holds. The page is `OnPush`, so a mutation alone marks nothing dirty; what redraws the view
 * is `treeRoot.set([...treeRoot()])`, a fresh array reference. Nothing in the code says that out loud.
 *
 * So this component takes `[nodes]` and renders it. It does not copy, normalise or re-key them: a `@for` over a
 * mapped copy would break the identity the page's mutations rely on, and the symptom would be a tree that is
 * correct in memory and frozen on screen — no error, no warning.
 *
 * ## And why the requests stayed behind
 *
 * The sidebar lives inside an `@if (sidebarOpen())`, so this component is destroyed every time the sidebar is
 * closed. A component that owned the directory listing would cancel it on destroy and lose the loaded tree, so
 * reopening would re-fetch — one of the characterization cases pins that it does not. The page owns the
 * requests; this renders their result and reports clicks.
 */
@Component({
  selector: 'app-file-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  /*
   * `NgTemplateOutlet` is not optional and its absence is SILENT: a standalone component that does not import
   * it treats `*ngTemplateOutlet` as an unknown attribute, renders nothing, and raises no error. The tree came
   * out empty on the first run of this cut and the characterization case is what said so.
   */
  imports: [NgTemplateOutlet, TranslocoPipe, PhIconComponent],
  styles: [`
    /*
     * A block, stated. This was a div on the page and a div is display:block; a custom element is
     * display:inline, so the width, border and overflow below would apply to a shrink-wrapping box that still
     * renders — which is exactly how the upload panel came out wrong in an earlier cut of this same file.
     */
    :host {
      display: block;
      width: 220px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      padding: 8px 0;
      overflow-y: auto;
      max-height: calc(100vh - 180px);
    }
    .tree-node {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 4px;
      margin: 0 4px;
    }
    /* Stacked above the list on a narrow window, full width and short, instead of a 220px column the list is squeezed beside. */
    @media (max-width: 720px) {
      :host { display: block; width: auto; border-right: none; border-bottom: 1px solid var(--border); max-height: 180px; }
    }
    /* A long folder name ends in an ellipsis (its title has the whole of it): a flex container cannot ellipsize itself, its label can. */
    .tree-node > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tree-node:hover { background: var(--bg-hover); }
    /* The folder being shown is marked by more than colour: a bar and weight, so it reads without the accent. */
    .tree-node.active { background: var(--accent-dim); color: var(--accent); font-weight: 500; box-shadow: inset 3px 0 0 var(--accent); }
    /* The focus ring is drawn on the node, not on the item, which also holds its whole subtree. */
    .tree-item:focus { outline: none; }
    .tree-item:focus-visible > .tree-node { outline: 2px solid var(--accent); outline-offset: -2px; }
    .tree-caret {
      width: 16px;
      text-align: center;
      flex-shrink: 0;
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.15s;
    }
    .tree-caret.expanded { transform: rotate(90deg); }
    .tree-children { padding-left: 12px; }
    .tree-spinner { font-size: 10px; color: var(--text-muted); padding: 2px 8px 2px 28px; }
    /* Indented to the spinner's column so it reads as belonging to the folder above it, not to the tree. */
    .tree-error { font-size: 10px; color: var(--danger); padding: 2px 8px 4px 28px; word-break: break-word; }
    /* The root's has no folder above it to indent under. */
    .tree-error-root { padding-left: 8px; }
  `],
  template: `
    @if (rootError()) {
      <!-- The one failure a per-node message cannot carry: there is no node to hang it on. Without it, a tree
           that could not load looks exactly like a space with no folders. -->
      <div class="tree-error tree-error-root" role="alert">
        {{ 'files.tree.loadFailed' | transloco }} — {{ rootError() }}
      </div>
    }

    <!-- A WAI-ARIA tree (Q-476): roles, ONE tab stop that travels with the focus, the arrow keys, aria-expanded and
         aria-current. The treeitem is the whole node INCLUDING its children's group, so the keyboard handler is on
         it and ignores events that bubble up from a nested item. The accessible name is the folder's name: the
         spinner and the error line that can sit inside the item are not part of what it is called. -->
    <div role="tree" [attr.aria-label]="'files.tree.ariaLabel' | transloco">
      <ng-container *ngTemplateOutlet="treeTemplate; context: { $implicit: nodes() }"></ng-container>
    </div>

    <ng-template #treeTemplate let-list>
      @for (node of list; track node.path) {
        <div role="treeitem" class="tree-item"
             [attr.data-path]="node.path"
             [attr.aria-label]="node.name"
             [attr.aria-expanded]="node.expanded ? 'true' : 'false'"
             [attr.aria-current]="currentPath() === node.path ? 'page' : null"
             [attr.tabindex]="rovingPath() === node.path ? 0 : -1"
             (focus)="focused.set(node.path)"
             (keydown)="onKeydown($event, node)">
          <div class="tree-node"
               [attr.title]="node.name"
               [class.active]="currentPath() === node.path"
               (click)="nodeClick.emit(node)">
            <span class="tree-caret" [class.expanded]="node.expanded"><ph-icon name="caret-right" [size]="10"/></span>
            <span><ph-icon name="folder" [size]="14"/> {{ node.name }}</span>
          </div>
          @if (node.loading) {
            <div class="tree-spinner">{{ 'files.tree.loading' | transloco }}</div>
          }
          @if (node.error) {
            <!--
              Under the folder it belongs to, not in a banner: two failed folders would otherwise share one
              message and an operator could not tell which refused.

              NOT app-error-state, which the listing uses. That is a card with an icon and a retry button, and
              the sidebar is a narrow column — it would take over the tree it is reporting about. There is also
              nothing for a retry button to do here that clicking the folder again does not already do.
            -->
            <div class="tree-error" role="alert">{{ 'files.tree.expandFailed' | transloco }} — {{ node.error }}</div>
          }
          @if (node.expanded && node.children) {
            <div class="tree-children" role="group">
              <ng-container *ngTemplateOutlet="treeTemplate; context: { $implicit: node.children }"></ng-container>
            </div>
          }
        </div>
      }
    </ng-template>
  `,
})
export class FileTreeComponent {
  /** The page's own array, by reference. See the docblock: a copy would break its in-place mutations. */
  nodes = input.required<TreeNode[]>();
  currentPath = input('');
  /** Why the ROOT listing failed, or null — see `TreeNode.error` for why the per-node one is per node. */
  rootError = input<string | null>(null);

  /**
   * One output for one gesture, and the page does two things with it: navigate, and expand or collapse.
   *
   * Split into `navigate` and `toggle` this component would be deciding which a click means, and a
   * characterization case pins that a single click does both.
   */
  nodeClick = output<TreeNode>();

  /**
   * Open or close one folder WITHOUT going there: the right and left arrow keys. Enter and a click are `nodeClick` (they
   * navigate as well), and the page decides what each means; this component only reports which key was pressed on which node.
   */
  toggleNode = output<TreeNode>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The path of the item that last had the focus, or null before any did. It is what the one tab stop follows. */
  readonly focused = signal<string | null>(null);

  /** The folders a reader can reach right now, top to bottom: an open folder's children follow it, a closed one's are hidden. */
  private readonly visible = computed<TreeNode[]>(() => {
    const walk = (list: TreeNode[]): TreeNode[] => list.flatMap(node => [node, ...(node.expanded && node.children ? walk(node.children) : [])]);
    return walk(this.nodes());
  });

  /**
   * The one item with `tabindex="0"`: where the focus last was, else the folder being shown, else the first. Every other item is
   * -1, so Tab enters the tree once and leaves it once, however many folders are open.
   */
  readonly rovingPath = computed<string | null>(() => {
    const paths = this.visible().map(node => node.path);
    const focused = this.focused();
    if (focused !== null && paths.includes(focused)) return focused;
    return paths.includes(this.currentPath()) ? this.currentPath() : (paths[0] ?? null);
  });

  constructor() {
    /*
     * When the item that had the focus leaves the view (its folder was deleted, or an ancestor was closed), the focus goes to
     * its nearest remaining ancestor: a removed element leaves the focus on the document body, and a keyboard user would be
     * back at the top of the page.
     *
     * The DOM focus moves ONLY if it was in the tree (or already lost). An operator who deleted the folder from the LISTING has
     * the focus there, and the page is about to move it to the next row: this must not take it back.
     */
    effect(() => {
      const visible = new Set(this.visible().map(node => node.path));
      const focused = untracked(() => this.focused());
      if (focused === null || visible.has(focused)) return;
      let target = parentPath(focused);
      while (target !== '/' && !visible.has(target)) target = parentPath(target);
      const next = target !== '/' ? target : (this.visible()[0]?.path ?? null);
      const active = document.activeElement;
      const hadFocus = !active || active === document.body || this.host.nativeElement.contains(active);
      this.focused.set(next);
      if (hadFocus && next !== null) this.focusItem(next);
    });
  }

  /** The DOM item for a path, focused. The item may not be rendered yet (a folder just opened): then nothing happens. */
  private focusItem(path: string): void {
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    items.find(item => item.getAttribute('data-path') === path)?.focus();
  }

  /**
   * The keys of a tree (WAI-ARIA authoring practices): Down and Up through the VISIBLE items without wrapping, Right opens a
   * closed folder and then steps into it, Left closes an open one and then steps to its parent, Home and End, Enter and Space
   * activate. A key that bubbles up from a nested item is that item's business, not this one's.
   */
  onKeydown(event: KeyboardEvent, node: TreeNode): void {
    if (event.target !== event.currentTarget) return;
    const visible = this.visible();
    const at = visible.findIndex(item => item.path === node.path);
    const go = (target: TreeNode | undefined): void => {
      if (!target) return;
      this.focused.set(target.path);
      this.focusItem(target.path);
    };
    switch (event.key) {
      case 'ArrowDown': go(visible[at + 1]); break;
      case 'ArrowUp': go(visible[at - 1]); break;
      case 'Home': go(visible[0]); break;
      case 'End': go(visible[visible.length - 1]); break;
      case 'ArrowRight':
        if (!node.expanded) this.toggleNode.emit(node);
        else go(node.children?.[0]);
        break;
      case 'ArrowLeft':
        if (node.expanded) this.toggleNode.emit(node);
        else go(visible.find(item => item.path === parentPath(node.path)));
        break;
      case 'Enter':
      case ' ': this.nodeClick.emit(node); break;
      default: return;
    }
    event.preventDefault();
  }
}
