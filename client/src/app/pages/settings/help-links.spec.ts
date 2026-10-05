/**
 * `help-links` — which page of the Help view a relative link in a guide points at.
 *
 * The rule is read by the view and by the gate over every guide's links, so these rows pin it on its own: a link is
 * resolved against its guide's directory first, then against the docs root, and one that names no page the view holds is
 * `page: null` (a tab on the raw document), not a different page.
 */
import { describe, it, expect } from 'vitest';
import { guideDir, joinHelpParts, landingOf, partAnchorId, renderedPagesOf, resolveHelpLink } from './help-links';
import { headingSlug } from '../../shared/heading-slug';

const PAGES = new Set([
  'userguide.md', 'userguide/02-brain.md', 'integration-guide.md', 'integration-guide/02-hosting.md',
  'integration-guide/04-brain-api.md', 'integration-guide/04a-recall-api.md', 'dependencies.md',
]);
const holds = (p: string) => PAGES.has(p);

describe('resolveHelpLink', () => {
  it('a sibling part with no fragment is read against the guide\'s directory', () => {
    expect(resolveHelpLink('02-hosting.md', 'integration-guide', holds)).toEqual({ page: 'integration-guide/02-hosting.md', bare: '02-hosting.md', fragment: undefined });
  });

  it('keeps the fragment, up and over, and a docs-root spelling', () => {
    expect(resolveHelpLink('04a-recall-api.md#recall', 'integration-guide', holds)?.fragment).toBe('recall');
    expect(resolveHelpLink('../userguide/02-brain.md#facts', 'integration-guide', holds)?.page).toBe('userguide/02-brain.md');
    expect(resolveHelpLink('integration-guide/04-brain-api.md', 'userguide', holds)?.page).toBe('integration-guide/04-brain-api.md');
    expect(resolveHelpLink('./userguide.md', '', holds)?.page).toBe('userguide.md');
  });

  it('a `..` above the docs root stays at the root', () => {
    expect(resolveHelpLink('../userguide.md', '', holds)?.page).toBe('userguide.md');
    expect(resolveHelpLink('../../../userguide.md', 'integration-guide', holds)?.page).toBe('userguide.md');
  });

  it('a markdown link to no page the view holds is a link with no page; anything that is not a markdown link is not one', () => {
    expect(resolveHelpLink('unlisted.md', 'integration-guide', holds)).toEqual({ page: null, bare: 'unlisted.md', fragment: undefined });
    for (const href of ['https://example.com/a.md', 'mailto:a@b.c', '#anchor', '../LICENSE', '../server/package.json', '/docker-compose.yml', 'NOTICE']) {
      expect(resolveHelpLink(href, 'integration-guide', holds)).toBeNull();
    }
  });
});

describe('guideDir and renderedPagesOf', () => {
  it('a split guide renders its parts and lives in their directory; its index file is not rendered', () => {
    const g = { file: 'integration-guide.md', parts: ['integration-guide/01-a.md', 'integration-guide/02-b.md'] };
    expect(renderedPagesOf(g)).toEqual(g.parts);
    expect(guideDir(g)).toBe('integration-guide');
  });

  it('a guide that is one file lives where the file does', () => {
    expect(renderedPagesOf({ file: 'dependencies.md' })).toEqual(['dependencies.md']);
    expect(guideDir({ file: 'dependencies.md' })).toBe('');
  });
});

describe('joinHelpParts', () => {
  const files = ['g/01-a.md', 'g/02-b.md'];
  const a = '# A\n\n> Part of the [guide](../g.md).\n\nSee [b](02-b.md#thing) and [c](02-b.md).\n';
  const b = '# B\n\n## Thing\n';

  it('drops each part\'s H1 and backlink, and folds a link to a part\'s heading into an anchor, leaving a page link alone', () => {
    const joined = joinHelpParts([a, b], files);
    expect(joined).not.toMatch(/^# /m);
    expect(joined).not.toContain('Part of the');
    expect(joined).toContain('[b](#thing)');
    expect(joined).toContain('[c](02-b.md)');
  });

  it('one file is returned as it is', () => {
    expect(joinHelpParts([a], ['g/01-a.md'])).toBe(a);
  });

  it('every part starts at an anchor of its own (round W, V2): what a link to a part with no fragment scrolls to', () => {
    const joined = joinHelpParts([a, b], files);
    const first = joined.indexOf(`id="${partAnchorId('g/01-a.md')}"`);
    const second = joined.indexOf(`id="${partAnchorId('g/02-b.md')}"`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    // each anchor sits BEFORE the part's content, so the scroll lands at its start
    expect(first).toBeLessThan(joined.indexOf('See [b]'));
    expect(second).toBeLessThan(joined.indexOf('## Thing'));
  });
});

describe('partAnchorId', () => {
  it('is derived from the part\'s file name, and differs for every part of a guide', () => {
    expect(partAnchorId('integration-guide/02-hosting.md')).toBe('part:02-hosting');
    const names = ['01-a.md', '02-b.md', '04a-x.md', '04b-x.md'].map(n => partAnchorId(`g/${n}`));
    expect(new Set(names).size).toBe(names.length);
  });

  it('can never be a heading id: the slug rule emits no `:`, so no heading text collides with it', () => {
    for (const text of ['Part 02 hosting', 'part: 02-hosting', 'part:02-hosting', 'Part - 02 - hosting', ':', 'a:b']) {
      expect(headingSlug(text)).not.toBe(partAnchorId('g/02-hosting.md'));
      expect(headingSlug(text)).not.toContain(':');
    }
  });
});

describe('landingOf — where, inside its guide, a link lands', () => {
  const split = { file: 'g.md', parts: ['g/01-a.md', 'g/02-b.md'] };
  const link = (page: string | null, fragment?: string) => ({ page, bare: 'x.md', fragment });

  it('a fragment is the landing', () => {
    expect(landingOf(link('g/02-b.md', 'thing'), split)).toEqual({ anchor: 'thing' });
  });

  it('a part with no fragment lands at the start of that part', () => {
    expect(landingOf(link('g/02-b.md'), split)).toEqual({ anchor: partAnchorId('g/02-b.md') });
  });

  it('the guide itself (its index file, which is not rendered) lands at the top: no anchor', () => {
    expect(landingOf(link('g.md'), split)).toEqual({ anchor: undefined });
  });

  it('a guide that is one file lands at the top of it', () => {
    expect(landingOf(link('d.md'), { file: 'd.md' })).toEqual({ anchor: undefined });
  });
});
