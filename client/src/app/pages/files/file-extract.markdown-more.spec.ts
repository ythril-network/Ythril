/**
 * The converted Markdown reads on to the end (`Q-128`): "show more" asks for the next window at the offset the server
 * named and appends it, so the text on screen is always a prefix of the document.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { of } from 'rxjs';
import { FileExtractStore } from './file-extract.store';
import { FilesApi } from '../../core/files-api.service';

describe('FileExtractStore.moreMarkdown (Q-128)', () => {
  it('asks at the named offset and appends the next whole paragraphs', () => {
    const calls: number[] = [];
    const api = {
      getFileExtract: (_s: string, _p: string, _l: number, _sk: number, md = 0) => {
        calls.push(md);
        return of(md === 0
          ? { path: 'a.pdf', chunks: [], chunkTotal: 0, limit: 100, skip: 0, images: [], converted: { path: '_converted/a.md', markdown: 'one\n\n', truncated: true, sizeBytes: 9, markdownSkip: 0, markdownChars: 9, markdownNextSkip: 5 } }
          : { path: 'a.pdf', chunks: [], chunkTotal: 0, limit: 100, skip: 0, images: [], converted: { path: '_converted/a.md', markdown: 'two', truncated: false, sizeBytes: 9, markdownSkip: 5, markdownChars: 9 } });
      },
    };
    TestBed.configureTestingModule({ providers: [FileExtractStore, { provide: FilesApi, useValue: api }] });
    const store = TestBed.inject(FileExtractStore);
    store.load('work', 'a.pdf');
    store.moreMarkdown('work', 'a.pdf');
    expect(calls).toEqual([0, 5]);
    expect(store.extract()!.converted!.markdown).toBe('one\n\ntwo');
    expect(store.extract()!.converted!.markdownNextSkip, 'the end is reached').toBeUndefined();
  });
});
