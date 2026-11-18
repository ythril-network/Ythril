/**
 * Ythril's licence forbids passing the software on, lets small firms (under 50 people) use it free, and every place that
 * names the licence names this one.
 *
 * ## The failure this prevents (Q-907)
 *
 * The licence was PolyForm Small Business 1.0.0 plus a hosting clause. Its "Distribution License" section let anyone pass
 * on the source, changed versions and images, and its small-business line was 100 people. The owner decided the
 * licence permits private self-hosting and own changes only, with the free tier at fewer than 50 people, and that the
 * edit is a removal of the grant plus renames, with nothing else added or reworded. A grant that creeps back in, a
 * headcount edited apart from the text, or one package.json still naming the old SPDX id would leave the product
 * claiming two licences at once.
 *
 * ## The rule
 *
 * LICENSE grants no distribution and says 50; its title is the new name; the three package.json fields, the image label
 * and the README name that same licence; no other tracked text outside LICENSE and the changelogs names PolyForm as
 * Ythril's licence; `schema/` stays Apache-2.0. Every file is enumerated with git, so a new document is covered without
 * editing this test.
 *
 * Run: node --test testing/standalone/licence-grants-no-distribution.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), 'utf8').replace(/^\u{FEFF}/u, '').replace(/\r\n/g, '\n');
const PACKAGE_JSONS = ['package.json', 'server/package.json', 'client/package.json'];

/** Collapse whitespace so a phrase broken over a line end still matches. */
const flat = text => text.replace(/\s+/g, ' ');

describe('LICENSE grants no distribution and sets the small-business line at 50', () => {
  const text = read('LICENSE');

  it('has no Distribution License section and no grant to distribute', () => {
    assert.doesNotMatch(text, /^## Distribution License/m, 'the Distribution License section is gone');
    assert.doesNotMatch(flat(text), /distribute copies/i, 'no licence to distribute copies');
    assert.doesNotMatch(flat(text), /license to distribute/i, 'no licence to distribute');
    assert.doesNotMatch(flat(text), /you may only distribute/i, 'the copyright grant does not point at a distribution grant');
    assert.doesNotMatch(text, /\(#distribution-license\)/, 'nothing links to the removed section');
  });

  it('forbids distributing in the words of PolyForm Internal Use and still routes changes to their own licence', () => {
    const copyright = flat(text.slice(text.indexOf('## Copyright License'), text.indexOf('\n## ', text.indexOf('## Copyright License') + 5)));
    assert.match(copyright, /you may not distribute the software/);
    assert.match(copyright, /make changes or new works based on the software according to \[Changes and New Works License\]\(#changes-and-new-works-license\)/);
    assert.match(text, /^## Changes and New Works License$/m, 'the section the grant routes to exists');
  });

  it('puts the small-business headcount at fewer than 50', () => {
    const m = flat(text).match(/has fewer than (\d+) total individuals/);
    assert.ok(m, 'the Small Business section states a headcount');
    assert.equal(m[1], '50');
  });

  it('is titled Ythril License 1.0.0 and says what it is based on', () => {
    assert.match(text, /^# Ythril License 1\.0\.0$/m);
    assert.doesNotMatch(text, /^# PolyForm/m, 'the title no longer claims to be PolyForm');
    assert.match(
      flat(text),
      /Based on the PolyForm Small Business License 1\.0\.0 \(https:\/\/polyformproject\.org\/licenses\/small-business\/1\.0\.0\): its distribution grant is removed, distribution is excluded in the words of PolyForm Internal Use 1\.0\.0, and its employee limit is 50\./,
    );
  });

  it('keeps the hosting-as-a-service clause', () => {
    assert.match(text, /^## Hosting as a Service$/m);
  });
});

describe('every place that names the licence names the same one', () => {
  it('the three package.json license fields say SEE LICENSE IN LICENSE', () => {
    for (const file of PACKAGE_JSONS) {
      assert.equal(JSON.parse(read(file)).license, 'SEE LICENSE IN LICENSE', file);
    }
  });

  it('the image label names LicenseRef-Ythril-1.0.0', () => {
    const label = read('Dockerfile').match(/^LABEL org\.opencontainers\.image\.licenses="([^"]*)"/m);
    assert.ok(label, 'the Dockerfile carries an image licence label');
    assert.equal(label[1], 'LicenseRef-Ythril-1.0.0');
  });

  it('the README badge and terms name the Ythril License, 50 people, and no passing on', () => {
    const readme = read('README.md');
    assert.match(readme, /\[!\[License: Ythril License\]/);
    const terms = flat(readme.slice(readme.indexOf('\n## License\n')));
    assert.match(terms, /\[Ythril License 1\.0\.0\]\(LICENSE\)/);
    assert.match(terms, /under 50 people/);
    assert.match(terms, /not allowed/);
  });

  it('no tracked text outside LICENSE and the changelogs names PolyForm', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
    const skip = f => f === 'LICENSE' || f === 'CHANGELOG.md' || f.startsWith('changelog/')
      || f === 'testing/standalone/licence-grants-no-distribution.test.js';
    const hits = [];
    for (const file of tracked) {
      if (skip(file) || !/\.(md|json|js|mjs|ts|yml|yaml|txt)$|^(Dockerfile|NOTICE)$/.test(file)) continue;
      let body;
      try { body = readFileSync(new URL(file, ROOT), 'utf8'); } catch { continue; }
      if (/polyform/i.test(body)) hits.push(file);
    }
    assert.deepEqual(hits, [], 'files still naming PolyForm');
  });

  it('schema/ stays Apache-2.0', () => {
    assert.equal(JSON.parse(read('schema/package.json')).license, 'Apache-2.0');
  });
});
