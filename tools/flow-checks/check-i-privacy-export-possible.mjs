#!/usr/bin/env node
/**
 * check-i-privacy-export-possible: an operator can export their data.
 *
 * Rule (the flow node's stated assertion): an export route or tool exists, and the user guide has a section that documents export.
 *
 *   - Routes: a route registered in `server/src` (comments stripped) under a path that names `export` (`router.get('/:spaceId/export', ...)`).
 *   - User guide: a heading in a tracked `docs/userguide/*.md` page whose text names export, with a body of at least one non-blank line before
 *     the next heading.
 *   Both lists come from `git ls-files` through `testing/standalone/_sources.mjs` (its floor is inside, so an empty listing throws and the
 *   probe answers `cannot answer:`, never `holds:` about nothing). Nothing in this file lists a route or a page.
 *
 * The failure that bought it (Q-875): the check was named by the verify phases and answered "cannot answer" from a placeholder, so each
 * bundle judged by reading whether an operator could still export.
 *
 *     node tools/flow-checks/check-i-privacy-export-possible.mjs
 */
import { readTrackedSources } from '../../testing/standalone/_sources.mjs';
import { stripSourceComments } from './_axe.mjs';
import { holds, violated, answer, isMain } from './_verdict.mjs';

/** A route registration whose path names export. Built fresh per use: a shared global regex keeps its position between files. */
const exportRouteRe = () => /\b\w+\.(?:get|post|put|patch)\(\s*(['"`])([^'"`]*export[^'"`]*)\1/gi;

/** `[{ file, line, path }]` for every route registered under an export path. */
export function exportRoutes(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const code = stripSourceComments(text);
    for (const m of code.matchAll(exportRouteRe())) out.push({ file, line: code.slice(0, m.index).split('\n').length, path: m[2] });
  }
  return out;
}

/** `[{ file, line, heading }]` for every guide heading naming export that has a body. */
export function exportSections(pages) {
  const out = [];
  for (const { file, text } of pages) {
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/^#{1,6}\s.*export/i.test(l)) return;
      const rest = lines.slice(i + 1);
      const end = rest.findIndex(x => /^#{1,6}\s/.test(x));
      if ((end < 0 ? rest : rest.slice(0, end)).some(x => x.trim())) out.push({ file, line: i + 1, heading: l.replace(/^#+\s*/, '').trim() });
    });
  }
  return out;
}

export function decide(routes, sections) {
  if (!routes.length) return violated('no route is registered under an export path in server/src');
  if (!sections.length) return violated(`${routes.length} export route(s) exist but no user guide page under docs/userguide has a heading about export with a body`);
  return holds(`${routes.length} export route(s) (${routes.slice(0, 3).map(r => `${r.file}:${r.line} ${r.path}`).join(', ')}) and ${sections.length} user guide section(s) (${sections.slice(0, 2).map(s => `${s.file}:${s.line}`).join(', ')})`);
}

if (isMain(import.meta.url)) {
  await answer(() => decide(
    exportRoutes(readTrackedSources(['server/src'], { ext: ['.ts'], specs: false })),
    exportSections(readTrackedSources(['docs/userguide'], { ext: ['.md'], floor: 3 })),
  ));
}
