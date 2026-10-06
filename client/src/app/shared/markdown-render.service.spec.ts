/**
 * MarkdownRenderService — heading ids and sanitization.
 *
 * The heading ids are not cosmetic. The user guide's table of contents carries 30 anchor links, all
 * authored against GitHub's slug rules; without matching ids every one of them points at nothing, and the
 * per-page help links have nowhere to scroll to. They address a chapter file since the guide was split,
 * but the Help page joins the chapters and strips the prefix, so the fragment still resolves here.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownRenderService, headingSlug } from './markdown-render.service';
import { NAMED_PROP_PREFIX, elementIdsFor, headingIdFor } from './heading-slug';

describe('headingIdFor / elementIdsFor — the id a heading gets, and the ids a fragment may be at', () => {
  it('an id that shadows nothing is the slug; one the predicate says shadows is in the namespace', () => {
    expect(headingIdFor('plain-words', () => false)).toBe('plain-words');
    expect(headingIdFor('links', (id) => id === 'links')).toBe(`${NAMED_PROP_PREFIX}links`);
  });

  it('by default the question is asked of this browser\'s own `document` and form element, as the sanitizer asks it', () => {
    expect(headingIdFor('links')).toBe('user-content-links');
    expect(headingIdFor('title')).toBe('user-content-title');
    expect(headingIdFor('hosting')).toBe('hosting');
  });

  it('a fragment may be at its own id or in the namespace', () => {
    expect(elementIdsFor('links')).toEqual(['links', 'user-content-links']);
  });
});

describe('headingSlug — GitHub-compatible, because the documents are', () => {
  it('lowercases and hyphenates', () => {
    expect(headingSlug('Logging in')).toBe('logging-in');
    expect(headingSlug('Schema Library')).toBe('schema-library');
  });

  it('drops punctuation but keeps the spaces around it — this is what makes the double hyphen', () => {
    // `## Settings — Spaces` is the form every settings heading uses, and it slugs with two hyphens.
    expect(headingSlug('Settings — Spaces')).toBe('settings--spaces');
    expect(headingSlug('Brain — Review tab')).toBe('brain--review-tab');
  });

  it('strips parentheses without eating the word inside', () => {
    expect(headingSlug('Multi-factor authentication (MFA)')).toBe('multi-factor-authentication-mfa');
  });

  it('keeps existing hyphens and digits', () => {
    expect(headingSlug('Form NMK-SI-11 in 2026')).toBe('form-nmk-si-11-in-2026');
  });
});

describe('MarkdownRenderService', () => {
  let svc: MarkdownRenderService;
  beforeEach(() => {
    TestBed.resetTestingModule();
    svc = TestBed.inject(MarkdownRenderService);
  });

  it('gives every heading an id, so a table of contents can reach it', async () => {
    const html = await svc.render('# Top\n\n## Settings — Spaces\n\n### Deep one\n');
    expect(html).toContain('id="top"');
    expect(html).toContain('id="settings--spaces"');
    expect(html).toContain('id="deep-one"');
  });

  it('an intra-document link and its heading agree', async () => {
    const html = await svc.render('[jump](#settings--tokens)\n\n## Settings — Tokens\n');
    expect(html).toContain('href="#settings--tokens"');
    expect(html).toContain('id="settings--tokens"');
  });

  it('keeps inline markup inside a heading while slugging the plain text', async () => {
    const html = await svc.render('## The `recall` tool\n');
    expect(html).toContain('id="the-recall-tool"');
    expect(html).toContain('<code>recall</code>');
  });

  it('slugs the heading as the reader sees it: an ampersand or an angle bracket is dropped like any punctuation, not spelled `amp`', async () => {
    // `## Duplicate Scanner & Action Rules` is `#duplicate-scanner--action-rules` on GitHub, which is where every link in the
    // guides was written. Slugged from the rendered HTML, the `&amp;` lost its `&` and `;` and left `amp`: the heading's id was
    // `duplicate-scanner-amp-action-rules`, and the link to it (and every Help control that names one) scrolled nowhere.
    const html = await svc.render('## Duplicate Scanner & Action Rules\n\n## 1 < 2 and "quoted" it\'s\n');
    expect(html).toContain('id="duplicate-scanner--action-rules"');
    expect(html).toContain('id="1--2-and-quoted-its"');
    expect(html).not.toContain('-amp-');
  });

  it('a heading whose slug names a property of `document` keeps an id (round W): the sanitizer strips such an id, so it is DOMPurify\'s own `user-content-` form', async () => {
    // `## Links` slugs to `links`, and `document.links` exists: DOMPurify removes an `id` that would shadow a property of
    // `document` or of a form (DOM clobbering) and leaves `id=""` — the joined integration guide had an h2 with an EMPTY id,
    // which no link could reach. The protection stays; the id takes the namespace that cannot shadow anything.
    const html = await svc.render('## Links\n\n## Images\n\n## Plain words\n');
    expect(html).not.toContain('id=""');
    expect(html).toContain('id="user-content-links"');
    expect(html).toContain('id="user-content-images"');
    expect(html).toContain('id="plain-words"');
    expect(html).not.toContain('id="links"');
  });

  it('a clobbering id stays out of the document even when the markdown itself asks for one', async () => {
    const html = await svc.render('<a id="cookie">x</a>\n\n<form name="forms"></form>\n');
    expect(html).not.toContain('id="cookie"');
    expect(html).not.toContain('name="forms"');
  });

  it('disambiguates repeated headings the way GitHub does', async () => {
    const html = await svc.render('## Notes\n\n## Notes\n\n## Notes\n');
    expect(html).toContain('id="notes"');
    expect(html).toContain('id="notes-1"');
    expect(html).toContain('id="notes-2"');
  });

  it('still strips scripts and event handlers', async () => {
    // The sanitization is a security boundary; adding heading ids must not have loosened it.
    const html = await svc.render('# T\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});
