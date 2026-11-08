/**
 * `file_changes` — the client file change feed's MCP door (bundle-255, Q-724). The read is `files/file-changes.ts`, shared with
 * `GET /api/files/:spaceId/changes`: the same parameters and bounds, the same refusals by
 * status and `code` (the feed's own refusals, a cursor or a view, in the same words; a bounds or unknown-parameter refusal is
 * worded by each door's own validator), the same page.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { peerBoundTo } from '../../auth/peer-bound.js';
import { refusalOfParse } from '../../util/log.js';
import {
  FILE_CHANGES_MAX_LIMIT, FILE_CHANGES_DEFAULT_LIMIT, FILE_CHANGES_MAX_CURSOR, FILE_CHANGES_MAX_PREFIX,
  FileChangesQuery, fileChangesSpaceRefusal, readFileChanges,
} from '../../files/file-changes.js';

/** A refusal as a tool result: the sentence in the text (with the door's `Error: ` prefix) and the body, `code` included, as structured content. */
const refused = (body: { error: string; code?: string }): ToolResult => ({
  content: [{ type: 'text' as const, text: `Error: ${body.error}${body.code ? ` (code: ${body.code})` : ''}` }],
  isError: true,
  structuredContent: { ...body },
});

/**
 * The `code` values a refusal of the feed carries and the description names (`cursor_expired`, `invalid_cursor`), as data: the MCP text gate
 * (mcp-text-names-only-real-tools) reads them from here, so a code named in the text is known to be an answer value and never a tool name.
 */
export const FILE_CHANGES_REFUSAL_CODES = ['cursor_expired', 'invalid_cursor'] as const;
const [CURSOR_EXPIRED, INVALID_CURSOR] = FILE_CHANGES_REFUSAL_CODES;

export const file_changesTool: ToolHandler = {
  name: 'file_changes',
  description: 'What changed in a space\'s files since a cursor, in the order the changes happened: the change feed a client that mirrors a '
    + 'space\'s files pages instead of re-listing every folder.\n\n'
    + 'WITH NO CURSOR IT LISTS EVERY FILE: page it to the end (until a page answers no items) and you hold the whole listing AND the cursor to '
    + 'resume from. Keep the last `nextCursor` (every page carries one, the last included) and send it next time: you get exactly what changed '
    + 'since, each path once, at its latest change.\n\n'
    + 'EACH ITEM: a live file is `{ path, sha256, sizeBytes, updatedAt, deleted: false }`; a deleted one is `{ path, deleted: true, updatedAt }` '
    + '(the deletion time; no hash or size). A file can be listed again with the same `sha256` (its processing finished, or its bytes arrived '
    + 'from a peer): compare the hash before fetching the bytes.\n\n'
    + `REFUSALS: a cursor older than the history the space keeps is refused with \`code: "${CURSOR_EXPIRED}"\` (deleted-file records are kept for a `
    + 'window, `fileChangeFeedWindowDays`, default 30 days, and a wipe or restore starts the history again): start again with no cursor. A cursor '
    + `this space did not hand out is \`${INVALID_CURSOR}\`. Treat any other \`code\` as a failure. A personal view is not accepted (one cursor is one `
    + 'space\'s history): name a space.\n\n'
    + 'PARAMETERS: `cursor` (from a previous answer), `prefix` (only paths starting with it, as plain text, e.g. `docs/`), `limit` (items per '
    + `page, 1-${FILE_CHANGES_MAX_LIMIT}, default ${FILE_CHANGES_DEFAULT_LIMIT}).\n\n`
    + 'RESPONSE: `{ items, nextCursor, through, head }`; `through` is the position the answer is complete through and `head` the latest one the feed holds.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      cursor: { type: 'string', minLength: 1, maxLength: FILE_CHANGES_MAX_CURSOR, description: 'The `nextCursor` of a previous answer. Omit to start from the beginning.' },
      prefix: { type: 'string', maxLength: FILE_CHANGES_MAX_PREFIX, description: 'Only paths that start with this text (e.g. `docs/`). Plain text, not a pattern.' },
      limit: { type: 'integer', minimum: 1, maximum: FILE_CHANGES_MAX_LIMIT, description: `Items per page (default ${FILE_CHANGES_DEFAULT_LIMIT}); a page can hold fewer and still not be the last: page until one answers no items.` },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const refusal = fileChangesSpaceRefusal(callSpace, peerBoundTo(ctx.callerRecord));
    if (refusal) return refused(refusal.body);
    const parsed = FileChangesQuery.safeParse({ cursor: a['cursor'], prefix: a['prefix'], limit: a['limit'] });
    if (!parsed.success) return refused(refusalOfParse(parsed.error));
    const outcome = await readFileChanges(callSpace, parsed.data);
    if (!outcome.ok) return refused(outcome.body);
    const body = outcome.body;
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: { ...body } };
  },
};
