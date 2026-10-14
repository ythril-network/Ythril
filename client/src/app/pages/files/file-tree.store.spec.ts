/**
 * The directory tree's state (`FileTreeStore`), which had no spec of its own: what removing a folder from it does.
 *
 * The tree is mutated in place and re-set through `bump()`, so a removal that edits the array and forgets the new reference is
 * a tree that is right in memory and frozen on screen. The other half of the rule: a removal is a LOCAL edit, never a request
 * and never a collapse of anything that was open.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { FilesApi } from '../../core/files-api.service';
import { FileTreeStore } from './file-tree.store';

const FS: Record<string, string[]> = {
  '/': ['docs', 'other'],
  '/docs': ['sub', 'old'],
  '/docs/sub': ['deep'],
  '/docs/sub/deep': [],
  '/other': ['kid'],
};

function mount() {
  const listed: string[] = [];
  const api = {
    listFiles: (_space: string, path: string) => {
      listed.push(path);
      return of({ entries: (FS[path] ?? []).map(name => ({ name, isDirectory: true, isFile: false, size: 0, modified: '' })) });
    },
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [FileTreeStore, { provide: FilesApi, useValue: api }] });
  const store = TestBed.inject(FileTreeStore);
  store.loadRoot('work');
  const node = (path: string): any => {
    const walk = (nodes: any[]): any => { for (const n of nodes) { if (n.path === path) return n; const hit = n.children && walk(n.children); if (hit) return hit; } };
    return walk(store.treeRoot());
  };
  for (const path of ['/docs', '/docs/sub', '/other']) store.toggle(node(path), 'work');
  listed.length = 0;
  return { store, node, listed };
}

beforeEach(() => TestBed.resetTestingModule());

describe('FileTreeStore.removeByPath', () => {
  it('removes the node and everything under it at any depth, and nothing else', () => {
    const { store, node } = mount();
    store.removeByPath('/docs/sub');
    expect(node('/docs/sub')).toBeUndefined();
    expect(node('/docs/sub/deep')).toBeUndefined();
    expect(node('/docs').children.map((n: any) => n.path)).toEqual(['/docs/old']);
    expect(store.treeRoot().map(n => n.path)).toEqual(['/docs', '/other']);

    store.removeByPath('/other');
    expect(store.treeRoot().map(n => n.path), 'a top-level folder too').toEqual(['/docs']);
  });

  it('keeps every other node as it was: the expanded ones stay expanded and keep their children', () => {
    const { store, node } = mount();
    store.removeByPath('/docs/sub/deep');
    for (const path of ['/docs', '/docs/sub', '/other']) expect(node(path).expanded, `${path} stays expanded`).toBe(true);
    expect(node('/other').children.map((n: any) => n.path)).toEqual(['/other/kid']);
    expect(node('/docs/sub').children).toEqual([]);
  });

  it('asks the server for nothing', () => {
    const { store, listed } = mount();
    store.removeByPath('/docs/sub');
    store.removeByPath('/other');
    expect(listed).toEqual([]);
  });

  it('hands the view a NEW array, because the page is OnPush and a mutation alone redraws nothing', () => {
    const { store } = mount();
    const before = store.treeRoot();
    store.removeByPath('/docs/old');
    expect(store.treeRoot()).not.toBe(before);
  });

  it('a path that is not in the tree is a no-op: no throw, nothing removed', () => {
    const { store } = mount();
    const before = JSON.stringify(store.treeRoot().map(n => [n.path, n.expanded, (n.children ?? []).length]));
    expect(() => store.removeByPath('/nope/nowhere')).not.toThrow();
    expect(() => store.removeByPath('/docs/sub/deep/not-loaded')).not.toThrow();
    expect(JSON.stringify(store.treeRoot().map(n => [n.path, n.expanded, (n.children ?? []).length]))).toBe(before);
  });

  it('a path that only SHARES A PREFIX with another is a different folder: /docs does not remove /docs-archive', () => {
    const { store, node } = mount();
    store.treeRoot.update(nodes => [...nodes, { name: 'docs-archive', path: '/docs-archive', expanded: false, loading: false, children: null, error: null }]);
    store.removeByPath('/docs');
    expect(node('/docs')).toBeUndefined();
    expect(node('/docs-archive'), 'the sibling with a longer name stays').toBeDefined();
  });
});
