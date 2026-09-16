/**
 * Shared file-processing dispatch — the single decision point for what happens to a freshly
 * written file's embedding pipeline.
 *
 * The REST single-request upload (`api/files.ts`), the REST chunked-complete finaliser, and the
 * MCP `write_file` tool were three inline copies of the same
 * `resolveInputFormat → media-branch | document-branch` sequence, and they had drifted:
 *   - the chunked path only recorded `pending` for media, never `disabled`/`skipped`;
 *   - MCP `write_file` converted documents **synchronously inline** (`runConversionPipeline` +
 *     `storeConversionResults`) while REST enqueued an async worker job — same work, two mechanisms;
 *   - the 500 MiB media size cap was a magic `524_288_000` literal in three places.
 *
 * All three now call {@link dispatchFileProcessing}. One policy: documents are always converted by
 * the background worker (never inline), so REST and MCP behave identically and every write inherits
 * the worker's retry/backoff/404-flagging/restart-survival. The file must already be on disk before
 * calling this (the worker reads it back).
 */

import { col, asFilter } from '../db/mongo.js';
import type { FileMetaDoc } from '../config/types.js';
import { getMediaEmbeddingConfig, DEFAULT_MEDIA_MAX_FILE_SIZE_BYTES } from '../config/loader.js';
import { resolveInputFormat, deleteConversionArtifacts, isMediaFormat, type ResolvedFormat } from './converters/pipeline.js';
import { enqueueMediaJob, enqueueTextJob } from './media/job-queue.js';
import { documentsAreOff } from './converters/extraction-level.js';
import { mediaIsOff } from './converters/media-level.js';
import { mimeTypeForPath } from './mime.js';
import { toDocId } from '../util/paths.js';
import { log } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';

/** Embedding-pipeline state surfaced to the HTTP/MCP response after a write. */
/**
 * The statuses this dispatcher can put a media file into — plus `complete`, which it REPORTS without
 * setting: identical bytes that already embedded are left exactly as they are, and the caller is told the
 * truth about the file rather than a status describing work that did not happen.
 */
export type FileEmbeddingStatus = 'disabled' | 'skipped' | 'pending' | 'complete';

export interface DispatchInput {
  /** File size in bytes (used for the media size cap). */
  bytes: number;
  /**
   * SHA-256 of the bytes just written, when the caller has it.
   *
   * Absent means "unknown" and the file is processed, which is the safe direction: the alternative — assuming
   * unchanged — would leave a file silently unembedded, and that is invisible until someone searches for it.
   */
  sha256?: string;
  /**
   * Raw `Content-Type` header, if any — used to resolve the format and as the enqueue MIME type.
   * Generic values (`application/octet-stream` and friends) are treated as "not stated" and the
   * file extension decides instead; see {@link mimeTypeForPath}.
   */
  contentType?: string;
  /** Caller-declared `inputFormat` hint (`auto` when omitted). */
  inputFormat?: string;
}

export interface DispatchResult {
  resolvedFormat: ResolvedFormat;
  /** Present for media (all cases) and documents (`pending`); undefined for plain text. */
  embeddingStatus?: FileEmbeddingStatus;
}

/**
 * Decide and enqueue the embedding work for a just-written file, and record media state on its
 * metadata record. Returns the resolved format (so the caller can pick a 202/201 status code) and
 * the embedding status (for the response body). Never throws for enqueue/DB hiccups — those are
 * logged and swallowed so a transient worker/queue error can't fail the write itself.
 */
export async function dispatchFileProcessing(
  spaceId: string,
  filePath: string,
  input: DispatchInput,
): Promise<DispatchResult> {
  const resolvedFormat = resolveInputFormat(filePath, input.contentType, input.inputFormat ?? 'auto');
  const normId = toDocId(filePath);
  // Derive from the name when the caller gave nothing usable. The previous `?? 'application/octet-stream'`
  // never consulted the extension — on the line directly above, `resolveInputFormat` classifies the same
  // file BY that extension, so the pipeline knew it was a PNG while telling every provider it was a byte
  // blob. That is what made external vision fail 100% of the time (`Invalid uri format:
  // data:application/octet-stream;base64`). Not a vision bug: the web UI sent octet-stream for every
  // upload and MCP `write_file` sends no Content-Type at all, so this line was the whole answer.
  const mimeType = mimeTypeForPath(filePath, input.contentType);

  if (isMediaFormat(resolvedFormat)) {
    // Media (image/audio/video): enqueue an async embedding job, or record why we didn't.
    // `mediaType` is the guard-narrowed format so it satisfies FileMetaDoc's media subset.
    const mediaType = resolvedFormat;
    const setMediaStatus = (status: Exclude<FileEmbeddingStatus, 'complete'>): Promise<unknown> =>
      col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
        asFilter<FileMetaDoc>({ _id: normId }),
        { $set: { mediaType, embeddingStatus: status } },
      );
    // Identical bytes that already completed: nothing to do, and this is the most expensive thing on the
    // instance to redo. `enqueueMediaJob` deliberately resets a terminal job "so re-upload triggers
    // re-processing" — right when the bytes are new, waste when they are not, and it could not tell the
    // difference because no hash was stored.
    //
    // The three conditions are a conjunction on purpose, and each is the safe direction on its own:
    //   - a hash from the CALLER, so an unknown hash processes rather than assumes;
    //   - the SAME hash on the record, which is the identity — same bytes through the same pipeline;
    //   - `embeddingStatus: 'complete'`, so a file that failed, was skipped, or is still pending is retried.
    //
    // Getting this wrong in the other direction is invisible: a file silently never embedded, discovered only
    // when someone searches for it and it is not there. So the guard refuses to guess.
    if (input.sha256) {
      const prior = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).findOne(
        asFilter<FileMetaDoc>({ _id: normId }),
      ) as FileMetaDoc | null;
      if (prior?.sha256 === input.sha256 && prior?.embeddingStatus === 'complete') {
        log.debug(`Media file ${spaceId}/${filePath}: identical bytes already embedded — pipeline skipped`);
        return { resolvedFormat, embeddingStatus: 'complete' };
      }
    }

    const mediaCfg = getMediaEmbeddingConfig();
    const maxBytes = mediaCfg.maxFileSizeBytes ?? DEFAULT_MEDIA_MAX_FILE_SIZE_BYTES;
    // No master switch any more: whether this class runs is decided entirely by its per-class level
    // below (`mediaIsOff`). A whole-instance "off" is now `levels.<class> = off`, which lands as
    // 'skipped' with a reason — not the old blanket 'disabled'. (Existing 'disabled' records still
    // render; that status just has no producer now.)
    if (input.bytes > maxBytes) {
      await setMediaStatus('skipped');
      log.info(`Media file ${spaceId}/${filePath} skipped: ${input.bytes} bytes exceeds maxFileSizeBytes (${maxBytes})`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    // This class is off for this space: store the file, analyse nothing, and say so terminally.
    // Enqueuing a job that will do nothing leaves the file at `pending` forever — indistinguishable
    // from a stuck queue, and the reason recall comes back empty would be nowhere to be found.
    if (mediaIsOff(spaceId, mediaType)) {
      await setMediaStatus('skipped');
      log.info(`Media file ${spaceId}/${filePath} not analysed: ${mediaType} analysis is off for this space`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    await setMediaStatus('pending');
    await enqueueMediaJob(spaceId, filePath, mimeType, mediaType).catch(err => {
      log.warn(`enqueueMediaJob error for ${spaceId}/${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { resolvedFormat, embeddingStatus: 'pending' };
  }

  if (resolvedFormat !== 'text') {
    // Documents are off for this space: the file is stored but never analysed. Record a terminal
    // state instead of queueing work that will do nothing — a job that is enqueued and then produces
    // no chunks leaves the file at `pending` forever, which is indistinguishable from a stuck queue.
    // That is precisely the silent-failure shape the vector-index work was about: the UI shows a
    // spinner, recall returns nothing, and neither says why.
    if (documentsAreOff(spaceId)) {
      await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
        asFilter<FileMetaDoc>({ _id: normId }),
        { $set: { embeddingStatus: 'skipped' } },
      );
      log.info(`Document ${spaceId}/${filePath} not analysed: document extraction is off for this space`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    // Document (md/txt/html/pdf/docx/epub): always converted by the background worker.
    // Clear stale conversion artifacts first so overwriting a document does not leave
    // duplicate chunk records behind.
    await deleteConversionArtifacts(spaceId, filePath).catch(err => {
      log.warn(`deleteConversionArtifacts error for ${spaceId}/${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
    await enqueueTextJob(spaceId, filePath, resolvedFormat, mimeType).catch(err => {
      log.warn(`enqueueTextJob error for ${spaceId}/${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { resolvedFormat, embeddingStatus: 'pending' };
  }

  // Plain text ('text'): stored as-is, no embedding pipeline.
  return { resolvedFormat };
}
