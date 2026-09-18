import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { usesLinkRecords } from '../../brain/link-adjacency.js';
import { arrayWriteError } from '../../brain/array-write-refusal.js';
import { recall } from '../../brain/recall.js';
import { TTL_DAYS_SCHEMA, filePathSchema, ttlDaysFromArgs } from './shared.js';
import { type InputFormat } from '../../files/converters/pipeline.js';
import { renameFileMeta, renameFileMetaByPrefix, upsertFileMeta } from '../../files/file-meta.js';
import { createDir, listDir, listFilesRecursive, moveFile, readFile, writeFile } from '../../files/files.js';
import { dispatchFileProcessing } from '../../files/dispatch.js';
import { writeFileTombstones } from '../../files/tombstones.js';
import { deleteFileCascade } from '../../files/delete-cascade.js';
import { QuotaError, checkQuota } from '../../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget } from '../../spaces/proxy.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import { emitWebhookEvent } from '../../webhooks/dispatcher.js';
import { log } from '../../util/log.js';

export const read_fileTool: ToolHandler = {
  name: 'read_file',
  description: 'Read the text contents of a file in the space file store. Whole file, no paging — a large document arrives entire and is paid for in tokens, so prefer `recall` with `includeFileContent: false` to find WHICH file and WHICH passage first, then read only if you need the rest.\n\n'
    + 'It reads the STORED TEXT, which for an uploaded PDF or image is the extracted text rather than the original bytes. A file whose extraction has not finished, or whose type yields no text, reads as empty — that is a pending or unextractable document, not an empty file. `list_dir` shows what is present, and `list_embed_jobs` shows whether its indexing is still queued or failed.\n\n'
    + 'This is a path lookup, not a search: an unknown path is an error, not an empty result.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('This is a LOOKUP, not a search: an unknown path is an error rather '
              + 'than an empty result, and nothing here matches a partial name.'),
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace , accessibleSpaceIds } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    let content: string | null = null;
    for (const mid of memberIds) {
      try { content = await readFile(mid, filePath); break; } catch { /* try next */ }
    }
    if (content === null) throw new Error(`File not found: ${filePath}`);
    return { content: [{ type: 'text' as const, text: content }],
      structuredContent: { path: filePath, content } };
  },
};

export const write_fileTool: ToolHandler = {
  name: 'write_file',
  description: 'Write text content to a file in the space file store.\n\n'
    + 'IT REPLACES THE WHOLE FILE. There is no append and no patch: whatever you send becomes the entire content, so read first if you meant to add to it. Writing a path that already exists overwrites it without asking.\n\n'
    + 'The file is CHUNKED and each chunk is embedded separately, which is why `recall` returns a passage rather than a document and why `includeFileContent: false` is worth using — one long chunk can crowd out several one-line records. Structure the text with headings: a chunk that begins under a heading carries it, and that is what makes a recall hit locatable.\n\n'
    + 'Embedding is ASYNCHRONOUS, as with `saveFact`: the write returns once the bytes are stored and a queued job computes the vectors afterwards. `recall` always scans the newest records straight from the collection, so a chunk the vector index has not ingested yet is still found — but a chunk whose embedding job has not RUN yet has no vector to compare and stays invisible until it does; `list_embed_jobs` says whether the queue is behind. Rewriting a file resets its embedding: new content is new content, and a previous failure to embed it is not carried forward.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('An existing file at this path is OVERWRITTEN without a warning, and '
              + 'missing parent directories are created for you.'),
            content: {
              type: 'string',
              description: 'The ENTIRE new contents. There is no append and no patch — whatever you send '
                + 'replaces the whole file, so read it first if you meant to add to it. It is chunked and '
                + 'each chunk embedded separately, which is why structure matters: a chunk beginning under a '
                + 'heading carries that heading, and that is what makes a recall hit locatable.',
            },
            description: { type: 'string', description: 'Optional human-readable summary stored as file metadata.' },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'Tags stored on the file\'s metadata record. REPLACES the stored list on a '
                + 'rewrite; `update_file_meta` replaces too, unlike the brain update tools, which merge. '
                + 'Filterable by `query` on the `files` collection and by `recall`\'s own filter.',
            },
            properties: {
              type: 'object',
              description: 'Optional structured key-value metadata for this file.',
              additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
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
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // Quota check — project the incoming size so a write that would exceed the hard limit is
    // rejected up-front (parity with the REST upload), throwing QuotaError (caught below).
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const wfQuota = await checkQuota('files', sizeBytes);
    const { sha256 } = await writeFile(wt.target, filePath, content);
    const metaOpts: { description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; ttlDays?: number | null; sha256?: string } = {};
    if (typeof a['description'] === 'string') metaOpts.description = a['description'];
    if (Array.isArray(a['tags'])) metaOpts.tags = a['tags'] as string[];
    if (a['properties'] != null && typeof a['properties'] === 'object' && !Array.isArray(a['properties'])) {
      metaOpts.properties = a['properties'] as Record<string, string | number | boolean>;
    }
    metaOpts.ttlDays = ttlDaysFromArgs(a);
    metaOpts.sha256 = sha256;
    await upsertFileMeta(wt.target, filePath, sizeBytes, metaOpts);
    // Resolve format, record media state, and enqueue the async embedding job — one shared policy
    // with the REST upload path. Documents are converted by the background worker (not inline), so
    // the tool returns immediately with `embeddingStatus: 'pending'`; the worker produces chunks and
    // sets `chunkCount`/`convertedFileId` shortly after. MCP has no Content-Type; the dispatcher
    // derives the type from the file extension, so an image written here reaches the vision provider
    // as `image/png` rather than the byte-blob type this comment used to describe as intended.
    const ifFmt = typeof a['inputFormat'] === 'string' ? a['inputFormat'] as InputFormat : 'auto';
    await dispatchFileProcessing(wt.target, filePath, { bytes: sizeBytes, inputFormat: ifFmt, sha256 });
    emitWebhookEvent({ event: 'file.created', spaceId: wt.target, entry: { path: filePath, sha256 }, ...(ctx.actor ?? {}) });
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
    + 'ON A PROXY SPACE THE MEMBERS ARE MERGED, AND A COLLISION IS RESOLVED SILENTLY. Every member the token '
    + 'reaches is listed and the results are combined by NAME — so if two members both hold `notes.md`, you '
    + 'see one entry and the other is dropped, with nothing saying which member won or that a second existed. '
    + 'A member that has no such directory is skipped rather than erroring. When that ambiguity matters, list '
    + 'the member space directly instead of the proxy.\n\n'
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
    const { args: a, callSpace, name , accessibleSpaceIds } = ctx;
    const dirPath = String(a['path'] ?? '');
    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
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
  description: 'Delete one file from the space file store, and everything the instance derived from it. '
    + 'IRREVERSIBLE — there is no undelete and no trash.\n\n'
    + 'IT IS A CASCADE, not just an unlink. The blob goes, a sync tombstone is written, the metadata record is '
    + 'removed (or flagged deleted when the instance keeps them for audit), any queued media or text job is '
    + 'CANCELLED so it cannot outlive the file and retry for ever, conversion artifacts such as extracted text '
    + 'and thumbnails are removed, the space\'s usage figure is invalidated, and a `file.deleted` webhook '
    + 'fires. Deleting the blob by other means leaves all of that behind.\n\n'
    + 'IT IS IDEMPOTENT, AND THAT DIFFERS FROM THE BRAIN DELETES. Deleting a path that is not there succeeds '
    + 'quietly; `delete_fact`, `delete_edge`, `delete_entity` and `delete_chrono` all ERROR on an id that '
    + 'does not exist. So a success here does not prove a file was there — check `list_dir` first if that '
    + 'distinction matters to you. The tradeoff is deliberate: a retried delete after a dropped connection '
    + 'must not report failure for having worked the first time.\n\n'
    + 'THE TOMBSTONE IS WHY RE-UPLOADING TO THE SAME PATH DOES NOT UNDO THIS cleanly on a synced space — the '
    + 'tombstone propagates and outranks the old copy on peers. Upload the file again by all means; just do '
    + 'not expect the deletion to be forgotten.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — the file path relative to the space root, as `list_dir` reports it. One FILE: this is not '
    + 'the tool for removing a directory tree.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the file.\n\n'
    + 'RESPONSE: one line naming the path that was deleted.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: filePathSchema('IRREVERSIBLE — the bytes, the metadata record and every chunk '
              + 'embedding go together, and a tombstone under this path stops a peer restoring it. A path '
              + 'that does not exist is an error, not a silent success.'),
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // Full cascade (blob + tombstone + meta + job + artifacts + usage + webhook) — shared with the REST
    // DELETE route and the TTL sweep so every delete path cleans up identically.
    await deleteFileCascade(wt.target, filePath, ctx.actor);
    return { content: [{ type: 'text' as const, text: `Deleted '${filePath}'.` }],
      structuredContent: { path: filePath, deleted: true } };
  },
};

export const create_dirTool: ToolHandler = {
  name: 'create_dir',
  description: 'Create a directory in the space file store, including any parent directories that do not yet '
    + 'exist — the equivalent of `mkdir -p`, so `a/b/c` in one call is fine. Creating a directory that is '
    + 'already there SUCCEEDS rather than erroring, so this is safe to call without checking first.\n\n'
    + 'YOU RARELY NEED THIS BEFORE A WRITE. `write_file` and `move_file` both create the parent directories of '
    + 'their destination on their own, so calling this first is a no-op step in most flows. It is for the case '
    + 'where the EMPTY directory is the point: laying out a structure a human or another agent will fill.\n\n'
    + 'A DIRECTORY IS NOT A SYNCED OBJECT. Only files sync between peers, so an empty directory created here '
    + 'exists on this instance alone and will not appear on a peer until something is written into it. It also '
    + 'carries no metadata: there is nothing to tag or describe until it holds a file.\n\n'
    + 'PARAMETERS:\n'
    + '- `path` — the directory path relative to the space root. Missing parents are created.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space to create it in.\n\n'
    + 'RESPONSE: one line confirming the path.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            path: { type: 'string', minLength: 1, description: 'Directory path relative to the space root.' },
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
          },
          required: ['space', 'path'],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const dirPath = String(a['path'] ?? '');
    if (!dirPath.trim()) throw new Error('path must not be empty');
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    await createDir(wt.target, dirPath);
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
    + 'ORIGINAL back and you end up with both. For a directory move every child path is tombstoned, not just '
    + 'the directory.\n\n'
    + 'NOTHING CHECKS THE DESTINATION FIRST. There is no "already exists" refusal here — the move is a '
    + 'filesystem rename, and a rename onto an existing file replaces it. Read `list_dir` first if that would '
    + 'lose something. Missing parent directories of `dst` ARE created for you.\n\n'
    + 'THE FILE IS NOT RE-READ. Moving does not re-extract text, re-run media analysis or re-embed: the '
    + 'content did not change, only where it lives. A file that failed extraction at the old path is still '
    + 'failed at the new one — use `retry_embed_file` for that, which is a different question from where the '
    + 'file sits.\n\n'
    + 'PARAMETERS:\n'
    + '- `src` — the existing path, relative to the space root, exactly as `list_dir` reports it. A file or a '
    + 'directory.\n'
    + '- `dst` — where it should end up, relative to the space root. Its parent directories are created if '
    + 'missing.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the file. This tool moves '
    + 'WITHIN one space; it cannot move a file between spaces, and naming a different member does not do that '
    + '— read it and write it instead.\n\n'
    + 'RESPONSE: one line confirming the move.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            space: s.requiredSpace,
            src: filePathSchema('The existing file OR directory to move. Moving a directory carries '
              + 'everything under it, including each file\'s metadata record.'),
            dst: filePathSchema('Where it should end up. NOTHING CHECKS THIS FIRST — the move is a '
              + 'rename, so an existing file here is REPLACED with no refusal and no warning. Missing parent '
              + 'directories are created. The file is not re-read, so a failed extraction stays failed.'),
            targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
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
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // Tombstone the OLD path(s) before moving (sync has no rename detection, so the source
    // would otherwise resurrect from a peer's manifest). Children for a dir move, else src.
    const movedChildren = await listFilesRecursive(wt.target, src);
    const oldPaths = movedChildren.length > 0 ? movedChildren : [src];

    await moveFile(wt.target, src, dst);
    // Re-root metadata: the file record at `src` AND, for a directory move, every child
    // record under `src/` (renameFileMetaByPrefix). The HTTP PATCH route does both; MCP
    // previously did only the single-file rename, orphaning child records on a dir move.
    await Promise.all([
      renameFileMeta(wt.target, src, dst),
      renameFileMetaByPrefix(wt.target, src, dst),
    ]).catch(err => {
      log.warn(`move_file renameFileMeta error for ${wt.target}, ${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}`);
    });
    await writeFileTombstones(wt.target, oldPaths);
    emitWebhookEvent({ event: 'file.updated', spaceId: wt.target, entry: { path: dst, previousPath: src }, ...(ctx.actor ?? {}) });
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
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
    },
    required: ['space', 'path'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '');
    if (!filePath.trim()) throw new Error('path must not be empty');
    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);

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
    const result = await retryJob(wt.target, docId);

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
 * strict-linkage check runs first, because a file carries three reference fields (`entityIds`, `memoryIds`,
 * `chronoIds`) and storing an unresolvable one is the widest silent hole this record type had.
 */
export const update_file_metaTool: ToolHandler = {
  name: 'update_file_meta',
  description: 'Change a file record\'s description, tags, properties or links WITHOUT resending the file. '
    + '`write_file` can set those fields, but only together with new content, so correcting one tag used to '
    + 'mean re-uploading the bytes. Only the fields you pass are touched; omit one to leave it alone.\n\n'
    + '`properties` MERGES, like every other record type: patch one key and the others survive. It REPLACED '
    + 'until 3.1, so a caller written against the old behaviour that resends the whole object is unaffected, '
    + 'while one that patches a single key now keeps what it did not name instead of destroying it.\n\n'
    + 'THE LISTS STILL REPLACE. `tags`, `entityIds`, `memoryIds` and `chronoIds` are each overwritten by what '
    + 'you send, so sending one id drops the rest — send the full list you want. Only `properties` merges.\n\n'
    + 'REMOVING SOMETHING IS `deleteFields`, NEVER AN OMISSION. An omitted field means "leave alone", so there '
    + 'is no value that clears one; send its dot path instead, applied AFTER the merge and permanent. A path '
    + 'that cannot be honoured is refused by name rather than ignored.\n\n'
    + 'UNDER STRICT LINKAGE EVERY ID MUST RESOLVE. `entityIds`, `memoryIds` and `chronoIds` are each checked '
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
    + '- `entityIds` / `memoryIds` / `chronoIds` — REPLACE those link lists. Sending one id drops the rest.\n'
    + '- `deleteFields` — dot-notation paths to remove, permanently and with no undo. Applied after the '
    + 'merge. The only way to unset anything.\n'
    + '- `targetSpace` — required when `space` is a proxy: the member space holding the file.\n\n'
    + 'RESPONSE: confirmation naming the path and which fields were changed. A path that does not exist is an '
    + 'error, so a successful reply means a record really was updated.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      path: { type: 'string', minLength: 1, description: 'The file path within the space, as list_dir reports it.' },
      description: { type: 'string', description: 'Replaces the description. Omit to leave it unchanged.' },
      tags: {
        type: 'array', items: { type: 'string' },
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
      entityIds: {
        type: 'array', items: { type: 'string' },
        description: 'REPLACES the stored entity links. These are what let `traverse` reach the file from '
          + 'an entity; they are not edges, so a file with an empty list is reachable only by path or by '
          + 'search.',
      },
      memoryIds: {
        type: 'array', items: { type: 'string' },
        description: 'REPLACES the stored fact links — send the full list, because sending one drops the '
          + 'rest.',
      },
      chronoIds: {
        type: 'array', items: { type: 'string' },
        description: 'REPLACES the stored chrono links — send the full list, because sending one drops the '
          + 'rest.',
      },
      deleteFields: {
        type: 'array', items: { type: 'string' },
        description: 'Dot-notation paths to REMOVE, applied after the merge — the only way to unset, since an '
          + 'omitted field means "leave alone" and `properties` merge. E.g. '
          + '`["properties.oldKey", "description"]`. Permanent, with no undo. Server-owned fields are REFUSED '
          + 'by name rather than ignored.',
      },
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space holding the file.' },
    },
    required: ['space', 'path'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const filePath = String(a['path'] ?? '').trim();
    if (!filePath) throw new Error('path must not be empty');

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);
    // `M-2`: on a converted space the six arrays are no longer a write surface — see `arrayWriteError`.
    // Against the WRITE TARGET, because a proxy holds no records of its own and its marker would answer
    // for a space it never writes to.
    const linkArrErr = arrayWriteError({ converted: usesLinkRecords(wt.target), spaceId: wt.target, body: a, actor: ctx.actor });
    if (linkArrErr) throw new Error(linkArrErr);

    const { isStrictLinkage } = await import('../../spaces/proxy.js');
    const { assertRefsResolve } = await import('../../brain/entity-refs.js');
    const { updateFileMeta } = await import('../../files/file-meta.js');

    const patch = {
      description: a['description'] as string | undefined,
      tags: a['tags'] as string[] | undefined,
      properties: a['properties'] as Record<string, string | number | boolean> | undefined,
      entityIds: a['entityIds'] as string[] | undefined,
      memoryIds: a['memoryIds'] as string[] | undefined,
      chronoIds: a['chronoIds'] as string[] | undefined,
    };

    // The same check the route runs, in the same order: refuse an unresolvable reference rather than store it.
    if (isStrictLinkage(wt.target)) {
      await assertRefsResolve(wt.target, 'entityIds', 'entity', patch.entityIds);
      await assertRefsResolve(wt.target, 'memoryIds', 'fact', patch.memoryIds);
      await assertRefsResolve(wt.target, 'chronoIds', 'chrono', patch.chronoIds);
    }

    // X-6: same parameter, same helper, same refusals as the REST route — checked here rather than trusting
    // the writer, so a bad path is a refusal on both doors instead of a silent no-op on one.
    const { validateDeleteFields } = await import('../../brain/delete-fields.js');
    const dfResult = validateDeleteFields(a['deleteFields']);
    if (!dfResult.ok) throw new Error(dfResult.error);
    const dfPaths: string[] | undefined = Array.isArray(a['deleteFields']) && (a['deleteFields'] as string[]).length > 0
      ? a['deleteFields'] as string[]
      : undefined;

    const updated = await updateFileMeta(wt.target, filePath, patch, dfPaths);
    if (!updated) throw new Error(`No file metadata record for '${filePath}' in '${wt.target}'.`);

    return {
      content: [{ type: 'text' as const, text: `Updated metadata for '${filePath}' in '${wt.target}'.` }],
      structuredContent: updated as unknown as Record<string, unknown>,
    };
  },
};
