/**
 * Which environment variables a script READS, found in its source — and which are the machine's rather than ours.
 *
 * ## The question it answers
 *
 * *"What does a person have to know to run this?"* A maintainer script or a test runner that reads
 * `YTHRIL_TEST_MONGO_PORT` has a setting nobody can find unless a page names it, and nothing reports the one that
 * is missing: the script just takes its default, and the person who needed another value concludes the script cannot
 * do it. `env-var-docs-coverage` asks the same question of the SERVER and the sidecars; this answers it for the
 * tooling around them (`scripts/`, `testing/_init/`), which that gate never scans.
 *
 * ## What counts as a read
 *
 * `process.env.NAME`, `process.env['NAME']`, a destructuring (`const { A, B: b = 1 } = process.env`) and, in
 * PowerShell, `$env:NAME` and `[Environment]::GetEnvironmentVariable('NAME')`. An ASSIGNMENT is not a read
 * (`process.env['CONFIG_PATH'] = …` configures code this script imports; it asks nothing of the person), and a
 * name that only appears in a comment is not either — comments are removed first, so the prose that documents a
 * variable is never mistaken for the script using it.
 *
 * ## What is ambient, and why a prefix is in the list
 *
 * The runtime's and the OS's variables (`PATH`, `APPDATA`, …) are nobody's setting to document. Everything
 * GitHub's runner provides starts `GITHUB_` and is set by the platform, never by a person, so the PREFIX is the
 * rule, not a list that would lag the platform. Anything else a script reads is documented or it is a defect —
 * the polarity is the same denylist the server gate uses, so a variable nobody anticipated is in scope.
 *
 * `env-var-docs-coverage.test.js` takes its ambient list from here ({@link AMBIENT}), so a variable one gate calls the
 * machine's is the machine's for the other. It keeps its own JavaScript read patterns (it needs the line of each
 * read and the `process.env` reads of server code this module's `envVarsRead` does not report by line).
 */
import { stripComments } from '../standalone/_strip-comments.mjs';

/** Variables that belong to the runtime, the shell or the OS. Upper-cased: PowerShell reads them case-insensitively. */
export const AMBIENT = new Set([
  'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'HOSTNAME', 'TZ', 'LANG', 'SHELL', 'PWD',
  'COMSPEC', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'USERNAME',
  'USERDOMAIN', 'CI', 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24',
]);

/** The platform's own namespace: `GITHUB_TOKEN`, `GITHUB_STEP_SUMMARY`, `GITHUB_RUN_ID` and whatever it adds next. */
export const AMBIENT_PREFIXES = ['GITHUB_', 'RUNNER_'];

export const isAmbient = (name) => AMBIENT.has(name.toUpperCase()) || AMBIENT_PREFIXES.some((p) => name.toUpperCase().startsWith(p));

const NAME = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * Comments out. JavaScript goes through the suite's one stripper (`_strip-comments.mjs`, line comments before block
 * comments, trailing comments too — a name mentioned in `// reads FOO_BAR` is prose, not a read); the PowerShell half
 * is this module's own, because no other gate reads `#` comments and `<# #>` blocks.
 */
function withoutComments(source, kind) {
  if (kind === 'powershell') {
    return source.replace(/<#[\s\S]*?#>/g, '').replace(/^[ \t]*#.*$/gm, '');
  }
  return stripComments(source);
}

/** The kind of source a path is, by extension; null for anything this module does not read. */
export function sourceKind(path) {
  if (/\.(?:m?js|cjs|ts)$/.test(path)) return 'javascript';
  if (/\.ps1$/.test(path)) return 'powershell';
  return null;
}

/**
 * The names a source reads, sorted and unique.
 *
 * @param {string} source the file's text
 * @param {'javascript'|'powershell'} kind
 */
export function envVarsRead(source, kind) {
  const text = withoutComments(source, kind);
  const found = new Set();
  const add = (n) => { if (n) found.add(n); };

  if (kind === 'javascript') {
    // process.env.NAME / process.env['NAME'] — not when it is the target of `=` (a write), but `==`/`===` is a read.
    // The name must END where it ends: without the boundary the engine backtracks `OTHER_ONE =` into `OTHER_ON`.
    const notAssigned = '(?![A-Za-z0-9_])(?!\\s*=(?!=))';
    for (const m of text.matchAll(new RegExp(`process\\.env\\.(${NAME})${notAssigned}`, 'g'))) add(m[1]);
    for (const m of text.matchAll(new RegExp(`process\\.env\\[\\s*['"](${NAME})['"]\\s*\\]${notAssigned}`, 'g'))) add(m[1]);
    // const { A, B: b, C = 1 } = process.env
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',')) {
        const key = part.trim().split(/[:=]/)[0].trim();
        if (new RegExp(`^${NAME}$`).test(key)) add(key);
      }
    }
  } else {
    for (const m of text.matchAll(new RegExp(`\\$env:(${NAME})(?![A-Za-z0-9_])(?!\\s*=(?!=))`, 'gi'))) add(m[1]);
    for (const m of text.matchAll(new RegExp(`GetEnvironmentVariable\\(\\s*['"](${NAME})['"]`, 'gi'))) add(m[1]);
  }
  return [...found].sort();
}
