/**
 * The server's TypeScript program, built once — the one definition of "the server's sources, type-checked".
 *
 * ## Why a module
 *
 * Two gates (`a-steerable-value-reaches-a-log-line-only-bounded`, `every-zod-refusal-answers-through-refusal-of-parse`) each wrote
 * the same five lines: read `server/tsconfig.json`, parse its file names, `createProgram`. The seq-ordering gate was the third
 * caller, and a program built per gate costs a full parse and bind of ~700 files each time. One definition also means one answer to
 * "which files are the server's": the ones `tsconfig.json` names, so a gate cannot look at a different set than the compiler does.
 *
 * ## The floor is INSIDE
 *
 * An empty or truncated file list passes every loop written over it, so a gate that read a broken program reports clean about
 * nothing. `serverProgram()` throws when the config yields fewer than {@link SERVER_SOURCE_FLOOR} files under `server/src`. The floor
 * is far below today's count (about 680) on purpose: it catches a broken `include` or a missing config, not growth or a cleanup.
 *
 * Cached per process: a gate that asks twice gets the same program, so its checker's work is shared too. The program is read-only for
 * every caller; one that needs a different host (a scratch fixture) builds its own with `program.getCompilerOptions()`.
 */
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from '../standalone/_sources.mjs';

/** Fewer `server/src` files than this and the tsconfig no longer says what the server is: `include` broke, or the config moved. */
export const SERVER_SOURCE_FLOOR = 300;

const posix = (p) => p.split(sep).join('/');

/** The repo-relative, forward-slash path of an absolute one. */
export const repoPath = (abs) => posix(relative(REPO_ROOT, abs));

let built = null;

/**
 * @returns {{ program: import('typescript').Program, checker: import('typescript').TypeChecker,
 *   sourceOf: Map<string, import('typescript').SourceFile>, repoPath: (abs: string) => string,
 *   serverSources: () => import('typescript').SourceFile[] }}
 *   `sourceOf` maps `server/src/...` repo paths to their source file; `serverSources()` is every non-declaration source under it.
 */
export function serverProgram() {
  if (built) return built;
  const dir = join(REPO_ROOT, 'server');
  const cfg = ts.readConfigFile(join(dir, 'tsconfig.json'), ts.sys.readFile);
  if (cfg.error) throw new Error(`server/tsconfig.json cannot be read: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir);
  const inSrc = parsed.fileNames.filter((f) => repoPath(f).startsWith('server/src/') && !f.endsWith('.d.ts'));
  if (inSrc.length < SERVER_SOURCE_FLOOR) {
    throw new Error(`server/tsconfig.json names only ${inSrc.length} source file(s) under server/src (floor ${SERVER_SOURCE_FLOOR}): `
      + 'a gate over this program would conclude about almost nothing');
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const sourceOf = new Map(program.getSourceFiles().map((sf) => [repoPath(sf.fileName), sf]));
  const serverSources = () => [...sourceOf].filter(([p, sf]) => p.startsWith('server/src/') && !sf.isDeclarationFile).map(([, sf]) => sf);
  built = { program, checker: program.getTypeChecker(), sourceOf, repoPath, serverSources };
  return built;
}
