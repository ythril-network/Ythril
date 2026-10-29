import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { TTL_DAYS_SCHEMA, filePathSchema, ttlDaysFromArgs, DELETION_REACH } from './shared.js';
import { UNKNOWN_ARGUMENT_RULE } from '../schema-warnings.js';
import { type InputFormat } from '../../files/converters/pipeline.js';
import { moveFileCascade } from '../../files/move-cascade.js';
import { readEditAudit } from '../../brain/edit-audit.js';
import { createDir, listDir, readFileWindow } from '../../files/files.js';
import { assertDestinationReachable } from '../../files/destination.js';
import { CONTENT_ENCODINGS, decodeContent } from '../../files/content-encoding.js';
import { storeFile, type StoreFileMeta } from '../../files/store-file.js';
import { deletePath } from '../../files/delete-cascade.js';
import { readSpacesOfCall } from '../../spaces/read-scope.js';
import { StoredFileUnreadable } from '../../files/stored-bytes.js';
import { readSpillByPath } from '../../brain/read-spill-act.js';
import { linkInputSchemasFor, linkInputError, linkFieldsFrom } from '../../brain/write-connections.js';
import { MAX_TAGS, MAX_DELETE_FIELDS } from '../../util/request-bounds.js';
import { resolveTextWindow, type MarkdownWindow } from '../../files/markdown-window.js';
import { carriagesFor, defaultBudgetChars } from '../../brain/result-budget.js';
import { budgetSizeSchema } from './_page-budget-schema.js';
import { extractListingAsked, extractListingRefusal, readExtractListing } from '../../files/extract-listing.js';
import { getFileMeta } from '../../files/file-meta.js';
import { writeWarningFields } from '../../brain/write-validation.js';
import { linkTargetRemovedWarnings } from '../../brain/gone-entity-references.js';
import { toDocId } from '../../util/paths.js';
import { NotFoundError } from '../../util/errors.js';

export const read_fileTool: ToolHandler = {
  name: 'read_file',
  description: 'Read the text contents of a file in the space file store, a window at a time. The window is whole paragraphs from `markdownSkip` (a character offset, default 0) that fit the answer budget (`maxChars` / `maxBytes` / `maxTokens`); `truncated` says more follows and `markdownNextSkip` is where — send it back as `markdownSkip`, and the windows joined are the file, character for character. A paragraph larger than the budget is split at a line break. The same two parameters page the converted Markdown on `GET /api/brain/spaces/:spaceId/files/extract`, which this tool is the twin of: `limit`, `skip`, `imagesLimit` and `imagesSkip` (all four, with the route\'s defaults and ceilings) add the file\'s chunk and extracted-image listing to the answer, and without them the answer is the text window alone. Prefer `recall` with `includeFileContent: false` to find WHICH file and WHICH passage first.\n\n'
    + 'It reads the STORED TEXT, which for an uploaded PDF or image is the extracted text rather than the original bytes. A file whose extraction has not finished, or whose type yields no text, reads as empty — that is a pending or unextractable document, not an empty file. `list_dir` shows what is present, and `list_embed_jobs` shows whether its indexing is still queued or failed.\n\n'
    + 'This is a path lookup, not a search: an unknown path is an error, not an empty result. A file held under another Unicode form of the path (a decomposed name) is found by the path as you spell it, as `GET /api/files/:space?path=` finds it.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('This is a LOOKUP, not a search: an unknown path is an error rather '
              + 'than an empty result, and nothing here matches a partial name.'),
            markdownSkip: {
              type: 'integer', minimum: 0,
              description: 'Character offset the window starts at (default 0). Send the previous answer\'s `markdownNextSkip`.',
            },
            ...budgetSizeSchema('character'),
            // NO `minimum`/`maximum` on these four, as on the route: the dispatcher enforces this schema before the handler, so a
            // bound here would refuse what `GET …/files/extract` clamps (`limit`, `skip`) or refuses in its own words (`images*`).
            limit: {
              type: 'integer',
              description: 'Chunks per page of the chunk listing (default 100, held to 500 and echoed as the `limit` that applied). Asking for ANY of `limit`, `skip`, `imagesLimit` or `imagesSkip` adds the listing to the answer: `chunks` (in document order), `chunkTotal`, `limit`, `skip`, `images`, `imagesTotal`, `imagesTruncated` and `imagesNextSkip` — the same fields as `GET /api/brain/spaces/:spaceId/files/extract`. Needs the file to have a metadata record.',
            },
            skip: { type: 'integer', description: 'Chunks to skip before the page (default 0). Part of the listing described on `limit`.' },
            imagesLimit: {
              type: 'integer',
              description: 'Extracted images per page (default and ceiling 200); a value that is not a positive integer is refused. Part of the listing described on `limit`. `imagesTruncated` and `imagesNextSkip` say where to go on.',
            },
            imagesSkip: { type: 'integer', description: 'Extracted images to skip before the page (default 0); a negative value is refused. Send `imagesNextSkip` back here.' },
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace , accessibleSpaceIds } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    // Resolved before anything is read, so a bad offset or budget is an error rather than a read that ran first.
    const window = resolveTextWindow(a as Record<string, unknown>, defaultBudgetChars(ctx.transport), carriagesFor(ctx.transport));
    if (!window.ok) throw new Error(window.error);
    // A spill's deprecated `path` (Q-92): read from the spill store under its own rule, as the files GET does.
    const spill = await readSpillByPath(filePath, {
      tokenId: ctx.actor?.tokenId, rights: ctx.rights, accessibleSpaceIds, transport: ctx.transport,
    });
    if (spill) {
      if (spill.status !== 200) throw new Error(String(spill.body['error']));
      return { content: [{ type: 'text' as const, text: JSON.stringify(spill.body) }],
        structuredContent: { path: filePath, content: spill.body } };
    }
    const memberIds = readSpacesOfCall(ctx, callSpace);
    // The chunk and image listing, only when one of its four parameters is stated (`Q-647`): a bad `imagesLimit`/`imagesSkip` is
    // refused here, before anything is read, in the words `GET …/files/extract` refuses it in.
    const listingRequest = { limit: a['limit'], skip: a['skip'], imagesLimit: a['imagesLimit'], imagesSkip: a['imagesSkip'] };
    const listingAsked = extractListingAsked(listingRequest);
    if (listingAsked) {
      const refusal = extractListingRefusal(listingRequest, defaultBudgetChars(ctx.transport));
      if (refusal) throw new Error(refusal);
    }
    let w: MarkdownWindow | null = null;
    for (const mid of memberIds) {
      try {
        // Only the window is held (`readFileWindow`), whatever the file's size; `markdownChars` is counted while it streams.
        w = await readFileWindow(mid, filePath, { skip: window.skip, maxChars: window.budget.chars, maxBytes: window.budget.bytes });
        break;
      } catch (err) {
        // A file that EXISTS but cannot be decoded is not "not found": the same refusal the REST download gives,
        // so the two doors agree on a foreign key or altered bytes (F-43). Anything else tries the next member.
        if (err instanceof StoredFileUnreadable) throw new Error(err.message);
      }
    }
    if (w === null) throw new NotFoundError(`File not found: ${filePath}`);
    let listing: Record<string, unknown> | null = null;
    if (listingAsked) {
      // Resolved per MEMBER and the member kept, as the route does: the derived records live beside their parent's record.
      const parentId = toDocId(filePath);
      let member: string | null = null;
      for (const mid of memberIds) { if (await getFileMeta(mid, parentId)) { member = mid; break; } }
      // A NotFoundError, so the generic REST door answers the 404 the extract route does, not a plain Error's 400.
      if (member === null) throw new NotFoundError('File metadata record not found');
      const read = await readExtractListing(member, parentId, listingRequest, defaultBudgetChars(ctx.transport), carriagesFor(ctx.transport));
      if (!read.ok) throw new Error(read.error);
      listing = read.fields;
    }
    /*
     * A WINDOW, held to the stated budget across both carriages (`Q-111`). The whole file went into `content` AND
     * `structuredContent`, unbudgeted: a 2 MB document crossed as 4.3 MB. A client reading only `content` must still
     * learn that there is more, so a cut window ends with one line saying where it continues.
     */
    const stated = window.budget.stated ?? window.budget;
    const more = w.truncated ? `\n\n[read_file: ${w.skip + w.markdown.length} of ${w.totalChars} characters; `
      + `continue with markdownSkip: ${w.nextSkip}]` : '';
    return {
      // The listing rides in BOTH carriages, as the text does: a client reading only `content` must not lose the half it asked for.
      content: [{ type: 'text' as const, text: w.markdown + more + (listing ? `\n\n${JSON.stringify(listing)}` : '') }],
      structuredContent: {
        path: filePath, content: w.markdown, truncated: w.truncated, markdownSkip: w.skip, markdownChars: w.totalChars,
        ...(w.nextSkip !== undefined ? { markdownNextSkip: w.nextSkip } : {}),
        budgetChars: stated.chars, budgetBytes: stated.bytes,
        ...(listing ?? {}),
      },
    };
  },
};

export const write_fileTool: ToolHandler = {
  name: 'write_file',
  description: 'Write a file in the space file store, as text or as bytes.\n\n'
    + 'BYTES GO THROUGH `encoding: "base64"`. Without it `content` is read as UTF-8 text, which is the '
    + 'default and is what you want for notes, markdown and code; an image, a PDF or anything else that is '
    + 'not text has to say `base64` or it is stored as mojibake. The two doors take the same two encodings '
    + 'and mean the same thing by them.\n\n'
    + 'IT REPLACES THE WHOLE FILE. There is no append and no patch: whatever you send becomes the entire content, so read first if you meant to add to it. Writing a path that already exists overwrites it without asking. A path that runs THROUGH a file (`a.txt/x` where `a.txt` is a file) is REFUSED with `409`, and nothing is written.\n\n'
    + 'The file is CHUNKED and each chunk is embedded separately, which is why `recall` returns a passage rather than a document and why `includeFileContent: false` is worth using — one long chunk can crowd out several one-line records. Structure the text with headings: a chunk that begins under a heading carries it, and that is what makes a recall hit locatable.\n\n'
    + 'Embedding is ASYNCHRONOUS, as with `saveFact`: the write returns once the bytes are stored and a queued job computes the vectors afterwards. `recall` always scans the newest records straight from the collection, so a chunk the vector index has not ingested yet is still found — but a chunk whose embedding job has not RUN yet has no vector to compare and stays invisible until it does; `list_embed_jobs` says whether the queue is behind. Rewriting a file resets its embedding: new content is new content, and a previous failure to embed it is not carried forward.'
    + '\n\nWHEN IT FAILS the result carries a `code` in `structuredContent`: `path_blocked` (`409`) when a file stands where a directory is needed or the name is not one the file system accepts, `file_system_fault` (`500`, `retryable: false`) when the server\'s own storage refused the write, and a plain refusal of your arguments (`400`) otherwise. A `500` names no path and no message of the runtime\'s.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('An existing file at this path is OVERWRITTEN without a warning, and '
              + 'missing parent directories are created for you. A path that runs through a file is REFUSED with `409`.'),
            content: {
              type: 'string',
              description: 'The ENTIRE new contents. There is no append and no patch — whatever you send '
                + 'replaces the whole file, so read it first if you meant to add to it. It is chunked and '
                + 'each chunk embedded separately, which is why structure matters: a chunk beginning under a '
                + 'heading carries that heading, and that is what makes a recall hit locatable. For a file '
                + 'that is not text, send base64 here and set `encoding`.',
            },
            encoding: {
              type: 'string',
              enum: [...CONTENT_ENCODINGS],
              default: 'utf8',
              description: 'How to read `content`. "utf8" (the default) stores it as text. "base64" decodes '
                + 'it first, which is the only way to write an image, a PDF or anything else that is not text '
                + 'through this tool. Base64 that is not base64 is REFUSED rather than decoded as far as it '
                + 'goes — the usual mistake is sending a whole `data:image/png;base64,…` URL instead of only '
                + 'the part after the comma. THE CEILING IS THE REQUEST, not the file store: a tool call '
                + 'arrives as one JSON body capped at 10 MB, and base64 costs a third more than the bytes it '
                + 'carries, so roughly 7 MB of file is the most that fits. Anything larger goes through '
                + '`POST /api/files/{path}`, which takes a raw body and supports chunked upload.',
            },
            description: { type: 'string', description: 'Optional human-readable summary stored as file metadata.' },
            tags: {
              type: 'array', maxItems: MAX_TAGS, items: { type: 'string' },
              description: 'Tags stored on the file\'s metadata record. REPLACES the stored list on a '
                + 'rewrite; `update_file_meta` replaces too, unlike the brain update tools, which merge. '
                + 'Filterable by `filter` on the `files` collection and by `recall`\'s own filter.',
            },
            properties: {
              type: 'object',
              description: 'Optional structured key-value metadata for this file.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            ttlDays: TTL_DAYS_SCHEMA,
            inputFormat: {
              type: 'string',
              enum: ['pdf', 'docx', 'epub', 'html', 'md', 'txt', 'text', 'auto'],
              default: 'auto',
              description: 'How to process the file. "auto" (default) detects from extension/MIME type. "text" bypasses conversion (single flat embedding). "md"/"txt" use the in-process normaliser+chunker. "pdf"/"docx"/"epub"/"html" use the full conversion pipeline.',
            },
          },
          required: ['space', 'path', 'content'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '');
    const content = String(a['content'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    /*
     * DECODED FIRST, and through the same module the REST upload uses.
     *
     * This tool had no `encoding` at all, so a session reached through MCP could create a text file and
     * could never create a byte file — reported by the canary operator on 2026-09-08 after one of their
     * coding sessions was asked to put a photograph of a whiteboard on a record. Everything past this line
     * was already shared with the REST door; only the door was narrower.
     *
     * Decoding through the module rather than a second `Buffer.from` is what keeps them honest: the base64
     * validation is the part a second copy drops, and `Buffer.from` answers a bad string with a SHORT
     * buffer rather than an error.
     */
    const bytes = decodeContent(content, a['encoding']);
    const meta: StoreFileMeta = { ttlDays: ttlDaysFromArgs(a) };
    if (typeof a['description'] === 'string') meta.description = a['description'];
    if (Array.isArray(a['tags'])) meta.tags = a['tags'] as string[];
    if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      meta.properties = a['properties'] as Record<string, string | number | boolean>;
    }
    // Quota, bytes, metadata, the processing queue and the webhook — one sequence for every door
    // (`files/store-file.ts`). MCP has no Content-Type; the dispatcher derives it from the extension.
    const ifFmt = typeof a['inputFormat'] === 'string' ? a['inputFormat'] as InputFormat : 'auto';
    await assertDestinationReachable(callSpace, filePath);
    const { sha256, sizeBytes, quota: wfQuota } = await storeFile(callSpace, filePath, bytes,
      { meta, inputFormat: ifFmt, ...(ctx.actor ? { actor: ctx.actor as Record<string, unknown> } : {}) });
    const wfText = `Written (sha256: ${sha256}).`
      + (wfQuota.softBreached ? `\n⚠️ Storage warning: ${wfQuota.warning}` : '');
    return {
      content: [{ type: 'text' as const, text: wfText }],
      structuredContent: { path: filePath, sha256, sizeBytes, ...(wfQuota.softBreached ? { warning: wfQuota.warning } : {}) },
    };
  },
};

export const list_dirTool: ToolHandler = {
  name: 'list_dir',
  description: 'List one directory in the space file store. NOT recursive: it returns the immediate children '
    + 'of `path` and nothing below them, so walking a tree means calling it per directory.\n\n'
    + 'IT IS THE SOURCE OF THE PATHS EVERY OTHER FILE TOOL WANTS. `read_file` and every write-side file tool '
    + 'your token can reach take a path relative to the space root, exactly as it is reported here. '
    + 'Constructing one by hand is where the mistakes come from.\n\n'
    + 'ON A PERSONAL VIEW THE MEMBERS ARE MERGED, AND A COLLISION IS RESOLVED SILENTLY. Every member the view '
    + 'reads for you is listed and the results are combined by NAME — so if two members both hold `notes.md`, you '
    + 'see one entry and the other is dropped, with nothing saying which member won or that a second existed. '
    + 'A member that has no such directory is skipped rather than erroring. When that ambiguity matters, list '
    + 'the member space directly instead of the view.\n\n'
    + 'A MISSING DIRECTORY IS AN EMPTY LISTING, not an error. So an empty result means "nothing here OR no '
    + 'such path" and the two are indistinguishable — check the parent if you expected content.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — relative to the space root. OMIT IT (or send `""`) for the root itself, which is the usual '
    + 'starting point.\n\n'
    + 'RESPONSE: one entry per child with its `name`, its `type` (`file` or `dir`) and, for a file, its `size` '
    + 'in bytes. Names only — not full paths — so join them onto `path` yourself when descending. There is no '
    + 'limit or paging here: a very large directory returns in full.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: {
              type: 'string',
              default: '',
              description: 'Directory path relative to space root (default: root).',
            },
          },
          required: ['space'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const dirPath = String(a['path'] ?? '');
    const memberIds = readSpacesOfCall(ctx, callSpace);
    const seen = new Set<string>();
    const allEntries: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
    for (const mid of memberIds) {
      try {
        const entries = await listDir(mid, dirPath || '.');
        for (const e of entries) {
          if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
        }
      } catch { /* dir may not exist in this member */ }
    }
    const text =
      allEntries.length === 0
        ? '(empty directory)'
        : allEntries
            .map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.name}${e.size != null ? `  (${e.size}B)` : ''}`)
            .join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
};

export const delete_fileTool: ToolHandler = {
  name: 'delete_file',
  description: 'Delete one file from the space file store, or a whole directory tree when `confirm` is `true`, '
    + 'and everything the instance derived from what it deleted. IRREVERSIBLE — there is no undelete and no trash.\n\n'
    + 'A DIRECTORY NEEDS `confirm`. Without `confirm` a directory is refused with `422` and `code: "confirm_required"`, and nothing is deleted; '
    + 'the space root is never deleted (`400`, `code: "space_root_refused"`). A directory delete removes every file under it and everything '
    + 'derived from each, writes a tombstone per file, and is completed by repeating the call with `confirm: true` if it was interrupted. '
    + '`confirm` has no effect on a file, and anything but a boolean is `400`.\n\n'
    + 'IT IS A CASCADE, not just an unlink. The blob goes, a sync tombstone is written, the metadata record is '
    + 'removed (or flagged deleted when the instance keeps them for audit), any queued media or text job is '
    + 'CANCELLED so it cannot outlive the file and retry for ever, the embedding jobs of the file and of everything derived '
    + 'from it are dropped, conversion artifacts such as extracted text and thumbnails are removed, the links this instance wrote from the file and from what was derived from it are '
    + 'removed with a tombstone each (a link another instance wrote stays with it), and the space\'s usage figure is invalidated. '
    + 'A `file.deleted` webhook fires for the file, and a directory delete fires one `file.deleted` per file it removed '
    + '(never for a conversion\'s derived record or a file an earlier delete flagged), each announced once even when an '
    + 'interrupted delete is repeated. Deleting the blob by other means leaves all of that behind.\n\n'
    + 'WHAT THE DELETE GUARANTEES: no peer restores the file or anything derived from it. Everything the instance '
    + 'derived from the file goes with it, however deep (a document\'s extracted text and images, and the captions '
    + 'and faces of those images), along with what a peer\'s copy of those left here; a peer that still holds a '
    + 'derived file is refused it, as it is refused the file.\n\n'
    + 'A PATH THAT IS NOT THERE IS AN ERROR, as it is for `delete_fact`, `delete_edge`, `delete_entity` and '
    + '`delete_chrono`: with neither bytes nor a metadata record at the path, this answers not found (an error '
    + 'result here, `404` on `DELETE /api/files/:spaceId` and `POST /api/delete_file`), and writes no tombstone. '
    + 'So a success means something was there. A path whose bytes are gone but whose metadata record remains is '
    + 'COMPLETED rather than refused: the tombstone is written and the record removed, so a peer does not push '
    + 'the file back. A record that is not a live file to delete does not count as "remains": one an earlier '
    + 'delete flagged deleted (the instance keeps those for audit) and a derived record (a chunk or a face of '
    + 'some other file) answer not found too, so a retried delete of a file already gone is never a second '
    + 'success, a second tombstone or a second `file.deleted` webhook.\n\n'
    + 'A FAILED DELETE IS SAFE TO RETRY. A store failure anywhere in the cascade is a retryable error, never a '
    + 'success. Before the bytes go it leaves the file exactly as it was (the tombstone is written first, but '
    + 'held back from every peer until the bytes are gone, and dropped if they do not go); after they go, the '
    + 'metadata record is still there, so the retry '
    + 'completes the delete as above. A retry after a delete that DID complete answers not found — read that as '
    + '"already gone". However many attempts it took, peers are sent ONE tombstone per deleted path: the '
    + 'successful attempt\'s replaces any a failed one left behind.\n\n'
    + 'WHO THE DELETION REACHES: ' + DELETION_REACH + ' A file this instance only relayed from above counts as '
    + 'downstream. A file ANOTHER instance wrote, deleted here, stays gone here until the instance that wrote it changes '
    + 'it, while the other mesh peers (a club, closed or democratic network) keep it. The tombstone names the version '
    + 'that was deleted, so uploading a file to the same path again afterwards is a newer version that a peer keeps.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — the file or directory path relative to the space root, as `list_dir` reports it.\n'
    + '- `confirm` — `true` to delete a directory; no effect on a file.\n'
    + '\n'
    + 'RESPONSE: one line naming the path that was deleted, with `{ path, deleted: true }` as structured content.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('IRREVERSIBLE — the bytes, the metadata record and every chunk '
              + 'embedding go together, and a tombstone under this path stops a peer restoring it. A directory '
              + 'path deletes everything under it and needs `confirm: true`. A path '
              + 'that does not exist is an error, not a silent success.'),
            confirm: { type: 'boolean', description: 'Required `true` to delete a directory. Ignored for a file.' },
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    // What the path is, and which cascade it gets (a file's, a directory's, or a refusal), is `deletePath`'s one decision —
    // shared with the REST DELETE route, so the doors cannot differ; the TTL sweep deletes through the file cascade itself.
    const deleted = await deletePath(callSpace, filePath, { confirm: a['confirm'], actor: ctx.actor });
    // The REST twin audits a directory delete with what it was; a single file records nothing, there as here.
    if (deleted === 'directory') ctx.recordChanges?.({}, { kind: 'directory' });
    return { content: [{ type: 'text' as const, text: `Deleted '${filePath}'.` }],
      structuredContent: { path: filePath, deleted: true } };
  },
};

export const create_dirTool: ToolHandler = {
  name: 'create_dir',
  description: 'Create a directory in the space file store, including any parent directories that do not yet '
    + 'exist — the equivalent of `mkdir -p`, so `a/b/c` in one call is fine. Creating a directory that is '
    + 'already there SUCCEEDS rather than erroring, so this is safe to call without checking first. A name that is a FILE, or a path that runs through one, is REFUSED with `409`, and nothing is created.\n\n'
    + 'YOU RARELY NEED THIS BEFORE A WRITE. `write_file` and `move_file` both create the parent directories of '
    + 'their destination on their own, so calling this first is a no-op step in most flows. It is for the case '
    + 'where the EMPTY directory is the point: laying out a structure a human or another agent will fill.\n\n'
    + 'A DIRECTORY IS NOT A SYNCED OBJECT. Only files sync between peers, so an empty directory created here '
    + 'exists on this instance alone and will not appear on a peer until something is written into it. It also '
    + 'carries no metadata: there is nothing to tag or describe until it holds a file.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — the directory path relative to the space root. Missing parents are created.\n'
    + '\n'
    + 'RESPONSE: one line confirming the path.'
    + '\n\nWHEN IT FAILS the result carries a `code` in `structuredContent`: `path_blocked` (`409`) for a name a file holds, `file_system_fault` (`500`, `retryable: false`) when the server\'s own storage refused it.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: { type: 'string', minLength: 1, description: 'Directory path relative to the space root.' },
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const dirPath = String(a['path'] ?? '');
    if (!dirPath.trim()) throw new Error('path must not be empty');
    await assertDestinationReachable(callSpace, dirPath);
    await createDir(callSpace, dirPath);
    return { content: [{ type: 'text' as const, text: `Directory '${dirPath}' created.` }],
      structuredContent: { path: dirPath, created: true } };
  },
};

export const move_fileTool: ToolHandler = {
  name: 'move_file',
  description: 'Move or rename a file OR a directory within the space file store. One tool for both: renaming '
    + 'is moving to a new name in the same place.\n\n'
    + 'A DIRECTORY MOVE CARRIES EVERY CHILD\'S METADATA WITH IT. Tags, descriptions and custom meta are keyed '
    + 'by path, so moving `a/` to `b/` re-roots the record of every file underneath. This tool used to rename '
    + 'only the single record it was given, which orphaned every child record on a directory move — the '
    + 'metadata still existed, at a path with no file.\n\n'
    + 'THE OLD PATHS ARE TOMBSTONED, and that is not bookkeeping. Sync has no rename detection: it sees a '
    + 'file gone from one path and present at another, so without a tombstone the peer\'s manifest pushes the '
    + 'ORIGINAL back and you end up with both. A move carries what belongs to the path: the metadata, the derived '
    + 'records, the conversion sidecars (`_converted/<id>.md` and `_extracted/<id>/`, a peer\'s copy of one included) '
    + 'and the queued jobs of all of them. A directory `<id>.md/` standing beside the file is not the file\'s: its '
    + 'converted tree (`_converted/<id>.md/`) is never touched by the file\'s move. '
    + 'For a directory move every child path is tombstoned, not just '
    + 'the directory. Who the tombstones reach is who a delete reaches: ' + DELETION_REACH + ' So a file ANOTHER '
    + 'instance wrote keeps its old path on a mesh peer, which then holds both paths.\n\n'
    + 'THE DESTINATION IS CHECKED BEFORE ANYTHING MOVES. A name blocked by a file is REFUSED with `409` and '
    + 'nothing is changed: that is `a.txt/x` where `a.txt` is a file, and a directory '
    + 'moved into itself or onto itself. A move never replaces anything. If a file, a folder or a file\'s record already '
    + 'stands at `dst`, the call is refused with `409` and `code: "destination_exists"` and nothing changes; to replace, delete '
    + 'the destination first (`delete_file`; that deletes it on every instance it is replicated to). A name that only a deleted '
    + 'file\'s audit record holds is free. Missing parent directories of `dst` ARE created for you.\n\n'
    + 'THE FILE IS NOT RE-READ. Moving does not re-extract text or re-run media analysis: the content did not change, '
    + 'only where it lives. The moved file IS re-embedded, because the text it is ranked by includes its path: it is '
    + 'queued for embedding at its new path once the move has finished, and a passage or caption that was waiting to be '
    + 'embedded keeps waiting under its new name. A file that failed extraction at the old path is still failed at the '
    + 'new one — use `retry_embed_file` for that, which is a different question from where the file sits.\n\n'
    + 'A MOVE THAT COULD NOT FINISH IS FINISHED ON ITS OWN, and a failed move is SAFE TO RETRY with the same `src` and '
    + '`dst`. A store failure is a retryable error, never a success. Before the bytes move nothing changes, and no peer is '
    + 'told of the tombstones it wrote (they are published only once the bytes each one names have moved — a conversion '
    + 'sidecar\'s after the sidecar\'s own move). Once they have moved, a move whose records could not all follow answers '
    + '`503` with `Retry-After`: it is not lost, the server completes it without being asked '
    + 'again, and repeating the call completes it too. Only a move begun with that same `src` and `dst` is '
    + 'completed: a `src` whose bytes are gone for any other reason is not found, and `dst` is left alone. '
    + 'A finish that finds the records of another file at a name the moved records need is refused with `409` and '
    + '`code: "destination_held_after_move"`: the bytes have moved and nothing is lost, and the move finishes once that '
    + 'other file is deleted. '
    + 'However many attempts it took, peers are sent ONE tombstone per path the move left: the successful '
    + 'attempt\'s replaces any a failed one left behind.\n\n'
    + 'PARAMETERS:\n'
    + '- `src` — the existing path, relative to the space root, exactly as `list_dir` reports it. A file or a '
    + 'directory.\n'
    + '- `dst` — where it should end up, relative to the space root. Its parent directories are created if '
    + 'missing.\n'
    + 'This tool moves WITHIN one space; it cannot move a file between spaces — read it and write it instead.\n\n'
    + 'RESPONSE: one line confirming the move.'
    + '\n\nWHEN IT FAILS the result carries a `code` in `structuredContent`: `path_blocked` (`409`) for a destination the tree refuses, `destination_exists` (`409`), `move_still_owed` (`503`, retry) or `file_system_fault` (`500`, `retryable: false`) when the server\'s own storage refused the act.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            src: filePathSchema('The existing file OR directory to move. Moving a directory carries '
              + 'everything under it, including each file\'s metadata record.'),
            dst: filePathSchema('Where it should end up. A name blocked by a file (`a.txt/x` where `a.txt` is a '
              + 'file, or a path inside the directory being moved) is REFUSED with `409` before anything changes, and so is a '
              + 'name where a file, a folder or a file\'s record already stands (`destination_exists`): a move never replaces '
              + 'anything, so delete the destination first. Missing parent directories are created. The file '
              + 'is not re-read, so a failed extraction stays failed; it is re-embedded at its new path, whose text includes the path.'),
          },
          required: ['space', 'src', 'dst'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const src = String(a['src'] ?? '');
    const dst = String(a['dst'] ?? '');
    if (!src.trim()) throw new Error('src must not be empty');
    if (!dst.trim()) throw new Error('dst must not be empty');
    // One cascade with the REST PATCH route: metadata, derived records, sidecars, jobs, tombstones, webhook.
    await moveFileCascade(callSpace, src, dst, ctx.actor);
    return { content: [{ type: 'text' as const, text: `Moved '${src}' → '${dst}'.` }],
      structuredContent: { from: src, to: dst } };
  },
};

/**
 * Re-queue a failed file embedding.
 *
 * ## Why this is a tool now
 *
 * The canary operator, 2026-08-11T1722Z, listed it among five capabilities a token could HOLD and not exercise:
 * *"The rights matrix decides what a token may do; the surface should not also decide whether it can."* This one
 * is the sharpest of the five, because it is the documented recovery path for a failed embedding — so the surface
 * that could see the failure was the surface that could not act on it.
 *
 * ## A wrapper, deliberately
 *
 * `retryJob` is the same function `POST /api/files/:spaceId/retry_embedding` calls. Reimplementing the reset
 * (status, attempts, lastError, claim fields) here would be a second copy of a state machine, and the copy that
 * drifts is the one nobody is watching. The three outcomes are reported verbatim rather than collapsed into
 * success/failure: `processing` means someone else already has it, which is not an error and not a retry.
 */
export const retry_embed_fileTool: ToolHandler = {
  name: 'retry_embed_file',
  description: 'Re-queue a file whose media embedding failed or was skipped, so the worker picks it up again. '
    + 'Resets the job to pending and clears its attempt count and last error. Returns `processing` unchanged if '
    + 'the worker already holds it — that is not a failure, and retrying it would take the job away from a run in '
    + 'progress. Use the file path as it appears in list_dir.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      path: filePathSchema('The file must already exist and its indexing must have FAILED — retrying '
        + 'one that succeeded, or one still queued, does nothing useful. `list_embed_jobs` is where the '
        + 'failures and their reasons are.'),
    },
    required: ['space', 'path'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');

    // Normalised the same way the REST route does it, so a path that works there works here. A raw path would
    // miss the job whose id is the normalised form, and report `not_found` for a file that exists.
    const { toDocId } = await import('../../util/paths.js');
    let docId: string;
    try {
      docId = toDocId(filePath);
    } catch (err: unknown) {
      throw new Error(err instanceof Error ? err.message : `Invalid path '${filePath}'`);
    }

    const { retryJob } = await import('../../files/media/job-queue.js');
    const result = await retryJob(callSpace, docId);

    const text = result === 'ok'
      ? `Re-queued '${filePath}' for embedding.`
      : result === 'processing'
        ? `'${filePath}' is being processed right now — left alone rather than reset, so the run in progress is not interrupted.`
        : `No embedding job exists for '${filePath}'. Either it was never queued, or the path does not match a stored file.`;

    // The outcome verbatim, so a caller can branch without reading English.
    return { content: [{ type: 'text' as const, text }], structuredContent: { result, path: filePath } };
  },
};

/**
 * Change a file's metadata WITHOUT resending the file.
 *
 * `write_file` accepts `description`, `tags` and `properties` — but only alongside `content`. The metadata-only
 * edit was `PATCH /api/brain/spaces/:spaceId/files`, which had no tool, so correcting a tag on a 40 MB PDF meant
 * re-uploading it, and correcting one on a file whose bytes you do not have was impossible.
 *
 * Every knowledge type has an `update_*` tool for exactly this reason. Files were the one that did not.
 *
 * Found by the capability matrix (`scripts/surface-matrix.mjs`). Filed as B-23.
 *
 * **The route's rules, not a second copy of them.** `updateFileMeta` performs the write and the same
 * strict-linkage check runs at the writer, because a file carries three link classes and storing an
 * unresolvable one is the widest silent hole this record type had.
 */
export const update_file_metaTool: ToolHandler = {
  name: 'update_file_meta',
  description: 'Change a file record\'s description, tags, properties or links WITHOUT resending the file. '
    + '`write_file` can set those fields, but only together with new content, so correcting one tag used to '
    + 'mean re-uploading the bytes. Only the fields you pass are touched; omit one to leave it alone.\n\n'
    + 'A FILE THIS INSTANCE HAS DELETED IS NOT A FILE TO EDIT. Where the operator keeps a record of deleted files, that record is refused here exactly as a path that never existed is — the same answer on the REST route — because an edit would put the file back into search and hang links off bytes that are gone.\n\n'
    + '`properties` MERGES, like every other record type: patch one key and the others survive. It REPLACED '
    + 'until 3.1, so a caller written against the old behaviour that resends the whole object is unaffected, '
    + 'while one that patches a single key now keeps what it did not name instead of destroying it.\n\n'
    + 'THE LISTS STILL REPLACE. `tags`, `linkEntities`, `linkFacts` and `linkChronos` are each overwritten by what '
    + 'you send, so sending one id drops the rest — send the full list you want. Only `properties` merges.\n\n'
    + 'REMOVING SOMETHING IS `deleteFields`, NEVER AN OMISSION. An omitted field means "leave alone", so there '
    + 'is no value that clears one; send its dot path instead, applied AFTER the merge and permanent. A path '
    + 'that cannot be honoured is refused by name rather than ignored.\n\n'
    + 'UNDER STRICT LINKAGE EVERY ID MUST RESOLVE. `linkEntities`, `linkFacts` and `linkChronos` are each checked '
    + 'against records that actually exist in the member space holding the file, and the call is refused '
    + 'rather than storing a dangling link. On a space without strict linkage they are stored as given.\n\n'
    + 'THE FILE CONTENT IS NOT RE-READ. This edits the record ABOUT the file, never the bytes: no '
    + 're-extraction, no media analysis, no new thumbnail. The record is re-embedded so the new description '
    + 'and tags are searchable, which is the only reason a metadata edit costs anything at all.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — the file path relative to the space root, exactly as `list_dir` reports it. Required.\n'
    + '- `description` — replaces the description. This is what `recall` ranks a file on, alongside its '
    + 'extracted text.\n'
    + '- `tags` — REPLACES the tag list. Send the full list you want.\n'
    + '- `properties` — MERGED key by key. Use `deleteFields` with `properties.<key>` to remove one.\n'
    + '- `linkEntities` / `linkFacts` / `linkChronos` — REPLACE those link lists. Sending one id drops the rest.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. Applied after the '
    + 'merge. The only way to unset anything.\n'
    + '\n'
    + 'RESPONSE: confirmation naming the path and which fields were changed. A path that does not exist is an '
    + 'error, so a successful reply means a record really was updated.\n\n'
    + UNKNOWN_ARGUMENT_RULE,
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      path: { type: 'string', minLength: 1, description: 'The file path within the space, as list_dir reports it.' },
      description: { type: 'string', description: 'Replaces the description. Omit to leave it unchanged.' },
      tags: {
        type: 'array', maxItems: MAX_TAGS, items: { type: 'string' },
        description: 'REPLACES the stored tag list — send the FULL list, because sending one tag drops the '
          + 'rest. This is the opposite of `update_entity` and `update_edge`, which MERGE the same field.',
      },
      properties: {
        type: 'object',
        /*
         * THE SAME DEFECT AS THE ENTITY PAIR, one record type over, and it survived that fix.
         *
         * `write_file` — the create door for these fields — declares `additionalProperties` and the
         * dispatcher enforces it, so a nested value is refused there. This declared `type: 'object'` and
         * nothing else, and `updateFileMeta` merges and stores whatever arrives. Refused on create, stored
         * on update: exactly what an integrator reported for entities on 2026-09-02, and exactly what the
         * shape of that report predicts you find next door.
         *
         * The rule is the product's, not this tool's — `docs/userguide/02-brain.md` states it for every
         * property bag, and the entity-only carve-out in `04-brain-api.md` names fact, edge and chrono,
         * not files. So the create door already agreed with the product and only this one did not.
         */
        additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        description: 'MERGES key by key, like every other record type: patch one key and the others survive. '
          + 'Removing one is `deleteFields`, never an omission. Values must be string, number, or boolean.',
      },
      deleteFields: {
        type: 'array', maxItems: MAX_DELETE_FIELDS, items: { type: 'string' },
        description: 'Dot-notation paths to REMOVE, applied after the merge — the only way to unset, since an '
          + 'omitted field means "leave alone" and `properties` merge. E.g. '
          + '`["properties.oldKey", "description"]`. Permanent, with no undo. Server-owned fields are REFUSED '
          + 'by name rather than ignored.',
      },
      // The three classes a FILE can link to, from the module both doors build their link fields with.
      // The description above promises these; declaring them anywhere but here would mean the dispatcher
      // refusing what the text tells a caller to send.
      ...linkInputSchemasFor('file'),
    },
    required: ['space', 'path'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '').trim();
    if (!filePath) throw new Error('path must not be empty');


    const { isStrictLinkage } = await import('../../spaces/space-lookup.js');
    const { updateFileMeta } = await import('../../files/file-meta.js');

    // Only the link classes a FILE holds are read out of the arguments: a link key it cannot hold (`linkFiles`) is an unknown argument,
    // answered by the judge, and neither refused here as a class nor audited as a link change.
    const linkErr = linkInputError(a, 'file', { strict: isStrictLinkage(callSpace) });
    if (linkErr) throw new Error(linkErr);

    const patch = {
      description: a['description'] as string | undefined,
      tags: a['tags'] as string[] | undefined,
      properties: a['properties'] as Record<string, string | number | boolean> | undefined,
      ...linkFieldsFrom(a, 'file'),
    };

    // The link classes are `linkEntities`, `linkFacts` and `linkChronos` now, and existence is asserted by
    // `reconcileLinks` at the writer rather than by each door — which is what `write-connections.ts` always
    // said, and what makes the check true of the newer spelling. It never had one.

    // X-6: same parameter, same helper, same refusals as the REST route — checked here rather than trusting
    // the writer, so a bad path is a refusal on both doors instead of a silent no-op on one.
    const { validateDeleteFields } = await import('../../brain/delete-fields.js');
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0
      ? a['deleteFields'] as string[]
      : undefined;

    // Q-50: the before, read ahead of the write, so the audit entry carries the change list its REST twin's does.
    const { getFileMeta } = await import('../../files/file-meta.js');
    const { toDocId } = await import('../../util/paths.js');
    const audit = await readEditAudit(callSpace, mid => getFileMeta(mid, filePath), toDocId(filePath), a, 'file');
    let linksTakenBack: readonly string[] = [];
    const updated = await updateFileMeta(callSpace, filePath, patch, dfPaths, ids => { linksTakenBack = ids; });
    if (!updated) throw new Error(`No file metadata record for '${filePath}' in '${callSpace}'.`);
    { const s = audit.snapshots(updated); ctx.recordChanges?.(s.before, s.after); }

    return {
      content: [{ type: 'text' as const, text: `Updated metadata for '${filePath}' in '${callSpace}'.` }],
      // A `linkEntities` link whose entity was deleted while the write ran was taken back and the file stays written: the answer says which (Q-305), as REST does.
      structuredContent: { ...updated, ...writeWarningFields(linkTargetRemovedWarnings(linksTakenBack)) } as unknown as Record<string, unknown>,
    };
  },
};
