/**
 * Every component template the client has: the inline `template:` strings of tracked, non-spec `.ts` sources and every tracked `.html`
 * file under `src/app`, each with its comments removed and the line of the file it starts on.
 *
 * ## Why this exists
 *
 * A gate about what a template SAYS (a placeholder, a label, a binding) needs the template text and a line to report, and each one
 * had its own hand-written pull of `template: \`...\``. Written once here, with the part a hand copy drops inside it: a floor, so that
 * a changed spelling of `template:` (or a move to `.html` files that the listing missed) yields a throw and not an empty list that every
 * loop passes over.
 *
 * Comments are stripped by the stripper every source gate uses, which keeps every newline, so a line computed on a template's text
 * plus `startLine` is the line in the original file. Sources come from `git ls-files` (`trackedAppSources`), never readdir.
 *
 * `declaresRequiredInput` says the component's class has an input NAMED `required` (the properties editor's list of required keys): a
 * field inside such a template may be required without a `required` attribute on its element.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

export interface ComponentTemplate {
  /** Relative to `client/`, forward slashes. */
  file: string;
  /** The template's text, comments blanked. */
  text: string;
  /** The line of `file` the text begins on (1-based). */
  startLine: number;
  declaresRequiredInput: boolean;
}

/** Far below the real count; it tells "none found" from "found". */
const FLOOR = 40;

const lineAt = (src: string, index: number): number => src.slice(0, index).split('\n').length;

export function componentTemplates(): ComponentTemplate[] {
  const out: ComponentTemplate[] = [];
  for (const file of trackedAppSources()) {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    const declaresRequiredInput = /@Input\(\)\s+required\b|\brequired\s*=\s*input\b|\brequired\s*=\s*input\.required\b/.test(src);
    for (const m of src.matchAll(/\btemplate:\s*`/g)) {
      const from = m.index! + m[0].length;
      let end = from;
      while (end < src.length && !(src[end] === '`' && src[end - 1] !== '\\')) end++;
      out.push({ file, text: src.slice(from, end), startLine: lineAt(src, from), declaresRequiredInput });
    }
  }
  const html = execFileSync('git', ['ls-files', 'src/app'], { cwd: CLIENT_ROOT, encoding: 'utf8' })
    .split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(p => p.endsWith('.html'));
  for (const file of html) {
    out.push({ file, text: stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8')), startLine: 1, declaresRequiredInput: false });
  }
  if (out.length < FLOOR) {
    throw new Error(`found ${out.length} component templates - fewer than ${FLOOR}, so the spelling of \`template:\` changed or the listing failed, and a gate over them would report clean about nothing.`);
  }
  return out;
}

/** One opening tag of a template: its name, its attribute text (quoted values kept), and the line it is on. */
export interface TemplateElement { name: string; attrs: string; line: number }

/**
 * The opening tags of `input`, `textarea`, `select` and every custom element (`app-*`) in a template. A `>` inside a quoted binding
 * does not end the tag.
 */
export function formElements(t: ComponentTemplate): TemplateElement[] {
  const tag = /<(input|textarea|select|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  return [...t.text.matchAll(tag)].map(m => ({ name: m[1]!, attrs: m[2]!, line: t.startLine + lineAt(t.text, m.index!) - 1 }));
}
