/**
 * What a door says about a file-system failure that is the SERVER's — in words that name no path.
 *
 * ## What it prevents
 *
 * The runtime puts the server's absolute data path in the message of every file-system error. A door that answered
 * `err.message` handed that path to a caller (a space rename's directory move did, in a `500` body; a move onto a blocked
 * name did on MCP). The sentence a caller reads is built here from the error's CODE alone, and the message goes to the log.
 *
 * ## The question it answers
 *
 * "Is this a file-system error, and what do we say about it?" Asked by the store-failure module for the acts that decide a
 * refusal from what a lookup threw (`refusalText`) and by the file acts' own fault (`FileSystemFault`,
 * `files/act-answers.ts`). Two modules ask it for two kinds of act, so the sentence lives in neither.
 */

/** Node's file-system error: an `Error` with a string `syscall` and `code` (`ENOENT`, `EACCES`, …). */
export function isFileSystemError(e: unknown): e is Error & { code: string; syscall: string } {
  return e instanceof Error && typeof (e as { syscall?: unknown }).syscall === 'string' && typeof (e as { code?: unknown }).code === 'string';
}

/**
 * Our sentence for a file-system failure: its code (it names no path) and where the detail is. A code that is not an
 * upper-case token, or no code at all, is `unknown`, so nothing but a token ever reaches the sentence.
 */
export function fileSystemRefusalMessage(code: unknown): string {
  return `The file system refused this step (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'}); the reason is in the server log.`;
}
