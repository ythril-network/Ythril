/**
 * The text of a tool's error, built in one place: `Error: <sentence>`, or `Error (<status>): <sentence>` where a tool names its status.
 *
 * ## What it prevents
 *
 * The prefix was written by hand at every site that answers a refusal or a failure of a tool (`callTool`, the rights guard, a dozen tool
 * modules), and the one kind of answer that was written last (a store failure) went without it. A client that tells an error from a result
 * by the first word of the text (MCP's `isError` and the text are all of a refusal an agent reads, and `POST /api/<tool>` puts the same
 * text in `error`) then met two grammars for one door, and a site added next month had only its author's memory to spell the prefix.
 * Here the prefix is one string; `a-tool-error-text-is-built-by-one-module` refuses a hand-written one anywhere else in `server/src`.
 *
 * ## What it is not
 *
 * Not the body a REST classic route answers: those routes (`sendCaughtFailure`, the record routes) carry the sentence alone in `error`.
 * The prefix belongs to a TOOL's text, which both `/api/<tool>` and MCP carry unchanged. A sentence that is already complete on its own
 * (a retired space id's, which answers with its code) is not given a prefix by this module: its sites do not call it.
 *
 * Imports nothing of the app, so any module may reach for it without joining an import cycle.
 */

/** A tool's error as a result: the text and `isError`; a caller adds `structuredContent` beside it. */
export interface ToolErrorResult {
  content: [{ type: 'text'; text: string }];
  isError: true;
}

/**
 * `message` as the text of a tool's error: `Error: <message>`, or `Error (<status>): <message>` when the tool states the status it
 * answers. The message is passed through whole: bounding what a caller chose is the site's, through `peerText`.
 */
export function toolErrorText(message: string, status?: number): string {
  if (status === undefined) return `Error: ${message}`;
  return `Error (${status}): ${message}`;
}

/** A whole error result for `message` (see {@link toolErrorText}): the shape every tool's refusal has, built once. */
export function toolErrorResult(message: string, status?: number): ToolErrorResult {
  return { content: [{ type: 'text' as const, text: toolErrorText(message, status) }], isError: true };
}
