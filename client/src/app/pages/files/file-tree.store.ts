import { Injectable, inject, signal } from '@angular/core';
import { FilesApi } from '../../core/files-api.service';
import { joinPath, parentPath } from './file-format';
import { httpErrorReason } from '../../core/http-error';
import type { TreeNode } from './file-tree.component';
import type { FileEntry } from '../../core/api.types';

/** Where the sidebar's open/closed state is remembered between visits. */
const SIDEBAR_KEY = 'ythril.sidebar';

/**
 * The directory tree's state and its two requests.
 *
 * ## Why a store and not a component
 *
 * G-3's seventh cut, and the reason is the one the previous cut wrote down rather than a new one. The sidebar
 * renders inside an `@if (sidebarOpen())`, so `FileTreeComponent` is destroyed every time the sidebar is
 * closed — a component owning `listFiles` would cancel it on destroy and lose the loaded tree, and reopening
 * would re-fetch. A characterization case pins that reopening does NOT re-fetch.
 *
 * A store injected by the page has the page's lifetime, which is what the requests need, while taking them off
 * a file that is the largest in the repo. `providers: [FileTreeStore]` on the page, deliberately: instance per
 * page, not per application, because the tree belongs to the space the page is showing.
 *
 * ## The nodes are mutated IN PLACE, and every mutation must replace the array
 *
 * `node.expanded = false`, `node.children = [...]`, `node.loading = true` — the tree is a recursive structure
 * and rebuilding it immutably on every expand would lose the identity the component's `@for` tracks. The page
 * and the tree component are both `OnPush`, so a mutation alone marks nothing dirty; what redraws the view is
 * `treeRoot.set([...])`, a fresh reference and nothing else.
 *
 * Nothing in the code says that out loud, which is why it is said here and why `bump()` is the only way this
 * class writes the signal. A mutation followed by a forgotten `set` gives a tree that is correct in memory and
 * frozen on screen: no error, no warning, and the data inspector agrees with you.
 *
 * ## What it deliberately does NOT own
 *
 * Navigation. `onTreeClick` on the page decides whether the click needs a listing and then navigates, and
 * those are two separate effects of one gesture — a characterization case pins both. Folding navigation in
 * here would make this store decide what a click means.
 *
 * This paragraph used to end by saying the duplicate listing was findable BECAUSE the two calls sat side by
 * side at the call site, and it was right: `G-13` found it there and removed it. What is left is one
 * listing, fed to this store by whoever fetched it.
 */
@Injectable()
export class FileTreeStore {
  private filesApi = inject(FilesApi);

  /** The root nodes. Mutated in place by the methods below, and always re-set through `bump()`. */
  readonly treeRoot = signal<TreeNode[]>([]);

  /**
   * Remembered across visits, because a sidebar the operator closed should stay closed.
   *
   * Read at construction rather than in an effect: the template needs it on the first render, and an effect
   * would flash the tree open for one frame on a page whose owner had hidden it.
   */
  readonly sidebarOpen = signal(localStorage.getItem(SIDEBAR_KEY) !== 'closed');

  /** Hand Angular a new array reference. The ONLY place this signal is written — see the class docblock. */
  private bump(): void {
    this.treeRoot.set([...this.treeRoot()]);
  }

  /** Directories only — a tree of files is not a tree, and the filter is the whole of what makes it one. */
  private nodesFrom(entries: FileEntry[], base: string): TreeNode[] {
    return entries
      .filter(e => e.isDirectory)
      .map(e => ({
        name: e.name, path: joinPath(base, e.name),
        expanded: false, loading: false, children: null, error: null,
      }));
  }

  /**
   * Why the ROOT listing failed, or null.
   *
   * Separate from a node's own `error` because there is no node to hang it on: the tree is empty, and an empty
   * tree and a failed one looked identical. That is the same silence one level up.
   */
  readonly rootError = signal<string | null>(null);

  /**
   * Load the space's top-level directories.
   *
   * It used to swallow its error on the reasoning that the listing beside it reports the same failure for the
   * same path. That is true for the ROOT and false for everything else, and it left an operator unable to tell
   * a space with no folders from a tree that could not load.
   */
  loadRoot(spaceId: string): void {
    if (!spaceId) return;
    this.loadedFor = spaceId;
    this.rootError.set(null);
    this.filesApi.listFiles(spaceId, '/').subscribe({
      next: ({ entries }) => {
        this.rootError.set(null);
        this.treeRoot.set(this.nodesFrom(entries, '/'));
      },
      error: (e: unknown) => this.rootError.set(httpErrorReason(e)),
    });
  }

  /**
   * Expand a collapsed node, or collapse an expanded one.
   *
   * **Collapsing keeps the loaded children**, so re-expanding costs no request. That is not an optimisation to
   * be tidied away later: a characterization case counts the requests, because rebuilding a node's children
   * from a fresh listing on every toggle is invisible on a fast network and shows up only as a slower click.
   */
  toggle(node: TreeNode, spaceId: string): void {
    if (node.expanded) {
      node.expanded = false;
      this.bump();
      return;
    }
    if (node.children !== null) {
      node.expanded = true;
      this.bump();
      return;
    }
    node.loading = true;
    // Cleared on every attempt, so a folder that failed once and then succeeded does not keep the old message
    // under it — a stale error beside working children is worse than none.
    node.error = null;
    this.bump();
    this.filesApi.listFiles(spaceId, node.path).subscribe({
      next: ({ entries }) => {
        node.children = this.nodesFrom(entries, node.path);
        node.loading = false;
        node.expanded = true;
        this.bump();
      },
      error: (e: unknown) => {
        /*
         * Spinner off, node left CLOSED — and now it SAYS so.
         *
         * It said nothing before. An operator saw a message only by accident: clicking a folder fires two
         * identical requests and the second one put the error on the listing beside the tree. That accident is
         * why the duplicate has to go SECOND — removing it first would have taken away the only feedback there
         * was.
         */
        node.loading = false;
        node.error = httpErrorReason(e);
        this.bump();
      },
    });
  }

  /**
   * Open a node from a listing somebody else already fetched.
   *
   * ## Why the tree stopped fetching
   *
   * Clicking a folder in the sidebar fired TWO identical requests: `navigate(path)` for the main listing and
   * `toggle(node)` for the children, same URL, same moment, every time. The listing's own result already
   * contains the directories the tree wants, so the second one bought nothing.
   *
   * It could not simply be deleted, and the order is the whole story: the tree had no failure state, and the
   * SECOND request was the only thing that put an error on screen. Removing it first would have made a failed
   * expand genuinely silent. The tree got its own error first (`G-10`), and this is the follow-up (`G-13`).
   *
   * ## Which is why `failFrom` exists beside it
   *
   * The tree no longer has a request that can fail, so its error has to come from the listing's failure. A
   * `fillFrom` without a `failFrom` would put the silence back.
   *
   * ## And why the PATH is checked here rather than at the call site
   *
   * A listing that lands is not necessarily the one the node is waiting for — go somewhere else before it
   * arrives and the other directory's contents would fill the folder you clicked, silently and permanently.
   * The check belongs to whoever owns the waiting node, which is this store: at the call site it would be one
   * rule copied into the success branch and the error branch of a listing that has six callers.
   */
  fillFrom(path: string, entries: FileEntry[]): void {
    const node = this.takePending(path);
    if (!node) return;
    node.children = this.nodesFrom(entries, node.path);
    node.loading = false;
    node.error = null;
    node.expanded = true;
    this.bump();
  }

  /** The other half of `fillFrom`: the listing failed, so the node stays closed and says why. */
  failFrom(path: string, reason: string): void {
    const node = this.takePending(path);
    if (!node) return;
    node.loading = false;
    node.error = reason;
    this.bump();
  }

  /** The node waiting for a listing of `path`, claimed — a listing resolves the wait exactly once. */
  private takePending(path: string): TreeNode | null {
    const node = this.pending;
    if (!node || node.path !== path) return null;
    this.pending = null;
    return node;
  }

  /** The node waiting for a listing somebody else started, if any. */
  private pending: TreeNode | null = null;

  /**
   * Mark a node as waiting for a listing that is already in flight.
   *
   * Separate from `fillFrom` because the spinner has to appear NOW, on the click, while the request the page
   * started is still running — a node that showed nothing until the listing landed would look like a click
   * that did nothing.
   */
  awaitFrom(node: TreeNode): void {
    this.pending = node;
    node.loading = true;
    node.error = null;
    this.bump();
  }

  /** The space the tree was last loaded for: an answer that arrives after the page moved to another space is not for this tree. */
  private loadedFor = '';

  /** A node by path, anywhere in the loaded tree, or undefined (a path under a folder that was never opened is not in it). */
  private find(path: string, list: TreeNode[] = this.treeRoot()): TreeNode | undefined {
    for (const node of list) {
      if (node.path === path) return node;
      const inner = node.children ? this.find(path, node.children) : undefined;
      if (inner) return inner;
    }
    return undefined;
  }

  /**
   * Take a folder out of the tree, and everything under it, without asking the server and without touching any other node.
   *
   * The delete used to reload the root, which rebuilt every node collapsed: deleting one folder closed everything the operator
   * had opened. A node is identified by its exact path, so `/docs` never removes `/docs-archive`, and a path the tree does not
   * hold (never opened, or already gone) is a no-op. It ends in `bump()` like every other mutation here.
   */
  removeByPath(path: string): void {
    const parent = parentPath(path) === '/' ? null : this.find(parentPath(path));
    const siblings = parent ? parent.children : this.treeRoot();
    if (!siblings?.some(node => node.path === path)) return;
    const kept = siblings.filter(node => node.path !== path);
    if (parent) parent.children = kept;
    else this.treeRoot.set(kept);
    this.bump();
  }

  /**
   * Re-list ONE folder and merge the answer into its node, keeping every child the operator had opened.
   *
   * Used for a created folder (its parent) and a moved one (the old parent and the new): the tree learns about a change under
   * one folder from one request for that folder, instead of a reload of the root that collapses it all. A child that is in
   * both the old and the new listing is kept AS IT WAS, with its own children and its expanded flag; one that is only in the
   * new listing is a fresh collapsed node; one that is only in the old is gone.
   *
   * A folder whose children were never loaded has nothing to merge into (the next time it is opened it lists itself), and an
   * answer for a space the page has since left is dropped. A failure changes nothing: the tree is a convenience beside a
   * listing that already says what happened.
   */
  reloadParent(spaceId: string, path: string): void {
    const loadable = path === '/' || this.find(path)?.children != null;
    if (!loadable || spaceId !== this.loadedFor) return;
    this.filesApi.listFiles(spaceId, path).subscribe({
      next: ({ entries }) => {
        if (spaceId !== this.loadedFor) return;
        // Looked up again: the node the request was made for may have been replaced while it was in flight.
        const parent = path === '/' ? null : this.find(path);
        const current = parent ? parent.children : this.treeRoot();
        if (!current) return;
        const known = new Map(current.map(node => [node.path, node]));
        const merged = this.nodesFrom(entries, path).map(fresh => known.get(fresh.path) ?? fresh);
        if (parent) parent.children = merged;
        else this.treeRoot.set(merged);
        this.bump();
      },
    });
  }

  /**
   * Show or hide the sidebar, and load the tree the first time it is shown.
   *
   * The load condition is a REQUEST decision rather than a UI one: reopening a sidebar whose tree is already
   * loaded must not re-fetch the root. That is why it lives with the tree and not with the toolbar button.
   */
  toggleSidebar(spaceId: string): void {
    const open = !this.sidebarOpen();
    this.sidebarOpen.set(open);
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed');
    if (open && this.treeRoot().length === 0) this.loadRoot(spaceId);
  }
}
