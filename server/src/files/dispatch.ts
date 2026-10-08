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
import { setFileProcessingState } from './processing-state.js';
import { documentsAreOff } from './converters/extraction-level.js';
import { mediaIsOff } from './converters/media-level.js';
import { mimeTypeForPath } from './mime.js';
import { toDocId } from '../util/paths.js';
import { log, peerText } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from './live-file-row.js';

/** Embedding-pipeline state surfaced to the HTTP/MCP response after a write. */
/**
 * The statuses this dispatcher can put a file into — plus `complete`, which it REPORTS without setting: identical bytes that
 * already embedded are left exactly as they are, and the caller is told the truth about the file rather than a status
 * describing work that did not happen.
 */
export type FileEmbeddingStatus = 'disabled' | 'skipped' | 'pending' | 'complete';

/**
 * What a file's row said about its processing BEFORE the write that brought these bytes: the hash it held and the status the
 * pipeline had left. Never read here: it is handed over by the caller that wrote the row ({@link readPriorProcessing}),
 * because by the time the dispatcher runs the row already holds the ARRIVING hash, and a comparison against it compares the
 * arriving bytes with themselves.
 */
export interface PriorProcessing {
  sha256?: string | undefined;
  embeddingStatus?: string | undefined;
}

/**
 * Read a file's processing state as it is NOW, for {@link DispatchInput.prior}. Private on purpose: it is read by
 * {@link recordAndDispatchFile} and nowhere else, so no door can write a row first and read the prior one after. Called BEFORE
 * the write that records the new
 * bytes — the one guard a hand-written sequence drops, and the cause of the defect it prevents: the dispatcher used to read the
 * row itself, after the write, and a changed file on a `complete` row was skipped and left `complete` under the new hash
 * with the old analysis (bundle-48, Q-260; probe A ran it). `null` when there is no row.
 */
async function readPriorProcessing(spaceId: string, filePath: string): Promise<PriorProcessing | null> {
  return await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).findOne(
    // NOT a flagged row: a file flagged by a release before the strip can still hold `sha256` and `complete`, and
    // "the same bytes are already processed" is then answered from the audit record of a DELETED file. No row means
    // "unknown, so process", which is the direction this read already fails in.
    asFilter<FileMetaDoc>({ _id: toDocId(filePath), ...NOT_A_FLAGGED_ROW }), { projection: { sha256: 1, embeddingStatus: 1 } },
  ) as PriorProcessing | null;
}

/** The statuses under which identical bytes are left exactly as they are: the work is done, or is under way. */
const SETTLED = new Set<string>(['complete', 'pending', 'processing']);

/**
 * Do these bytes need no processing because the same bytes already have it?
 *
 * The three conditions are a conjunction on purpose, and each is the safe direction on its own:
 *   - a hash from the CALLER, so an unknown hash processes rather than assumes;
 *   - the SAME hash on the prior row, which is the identity — same bytes through the same pipeline;
 *   - a status in {complete, pending, processing}: the work is done, or a job is under way and a second arrival must not reset it
 *     (`enqueueTextJob` does, and half a conversion is thrown away). A file that failed, was skipped, or finished only
 *     partly (`failed`, `skipped`, `partial`) is retried: those are exactly the states a retry exists for.
 *
 * Getting this wrong in the other direction is invisible: a file silently never processed, discovered only when someone
 * searches for it and it is not there. So the rule refuses to guess, and one function holds it for EVERY branch of the dispatcher.
 */
function settledAndIdentical(prior: PriorProcessing | null | undefined, sha256: string | undefined): prior is PriorProcessing {
  return sha256 !== undefined && sha256 !== '' && prior?.sha256 === sha256 && SETTLED.has(prior.embeddingStatus ?? '');
}

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
   * The row as it was before this write ({@link readPriorProcessing}). With the hash above it decides whether identical bytes
   * are left alone. Absent or `null` means "unknown" and the file is processed, for the same reason.
   */
  prior?: PriorProcessing | null;
  /**
   * Raw `Content-Type` header, if any — used to resolve the format and as the enqueue MIME type.
   * Generic values (`application/octet-stream` and friends) are treated as "not stated" and the
   * file extension decides instead; see {@link mimeTypeForPath}.
   */
  contentType?: string;
  /** Caller-declared `inputFormat` hint (`auto` when omitted). */
  inputFormat?: string;
  /**
   * The bytes ARRIVED from a peer (only `files/bytes-arrived.ts` says so). Carried on the media job, where it decides whether an
   * image is analysed for faces (`MediaJobDoc.arrival`); nothing else in the dispatch changes with it.
   */
  arrival?: boolean;
}

export interface DispatchResult {
  resolvedFormat: ResolvedFormat;
  /** Present for media (all cases) and documents (`pending`); undefined for plain text. */
  embeddingStatus?: FileEmbeddingStatus;
}

/**
 * Decide and enqueue the embedding work for a just-written file, and record media state on its
 * metadata record. Returns the resolved format (so the caller can pick a 202/201 status code) and
 * the embedding status (for the response body).
 *
 * **What throws and what does not.** A failure to ENQUEUE the job (`enqueueMediaJob`, `enqueueTextJob`) and to clear a document's
 * stale conversion artifacts is logged and swallowed, so a transient worker or queue error cannot fail the write itself. The
 * processing STATE of the file's row is written with an awaited write (`setFileProcessingState`: `pending`, or the terminal
 * `skipped` of every class this function declines, plain text included) and is NOT guarded: a store failure there throws out of
 * this function. That is deliberate — a row left with no state is one the pull's lazy repair would offer for ever — and the caller
 * is the door's record step (`recordAndDispatchFile`), whose failure takes the bytes back (`removeUnrecordedBytes`) and is
 * answered or retried by that door.
 *
 * Every class it declines is left in a terminal state (`skipped`: an unknown extension, a media file over the size cap, a media
 * class or the documents turned off for the space), and identical bytes whose processing settled are not processed again
 * ({@link DispatchInput.prior}).
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
    // Through the one writer of a file's processing state (`files/processing-state.ts`): it stamps no `updatedAt` and no `seq`.
    const setMediaStatus = (status: Exclude<FileEmbeddingStatus, 'complete'>): Promise<unknown> =>
      setFileProcessingState(spaceId, normId, { mediaType, embeddingStatus: status });
    // Identical bytes that already completed, or whose job is under way: nothing to do, and this is the most expensive thing
    // on the instance to redo. `enqueueMediaJob` deliberately resets a terminal job "so re-upload triggers
    // re-processing" — right when the bytes are new, waste when they are not. The rule is `settledAndIdentical`'s.
    if (settledAndIdentical(input.prior, input.sha256)) {
      log.debug(`Media file ${peerText(spaceId)}/${peerText(filePath)}: identical bytes already ${peerText(input.prior.embeddingStatus)} — pipeline skipped`);
      return { resolvedFormat, embeddingStatus: input.prior.embeddingStatus === 'complete' ? 'complete' : 'pending' };
    }

    const mediaCfg = getMediaEmbeddingConfig();
    const maxBytes = mediaCfg.maxFileSizeBytes ?? DEFAULT_MEDIA_MAX_FILE_SIZE_BYTES;
    // No master switch any more: whether this class runs is decided entirely by its per-class level
    // below (`mediaIsOff`). A whole-instance "off" is now `levels.<class> = off`, which lands as
    // 'skipped' with a reason — not the old blanket 'disabled'. (Existing 'disabled' records still
    // render; that status just has no producer now.)
    if (input.bytes > maxBytes) {
      await setMediaStatus('skipped');
      log.info(`Media file ${peerText(spaceId)}/${peerText(filePath)} skipped: ${input.bytes} bytes exceeds maxFileSizeBytes (${maxBytes})`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    // This class is off for this space: store the file, analyse nothing, and say so terminally.
    // Enqueuing a job that will do nothing leaves the file at `pending` forever — indistinguishable
    // from a stuck queue, and the reason recall comes back empty would be nowhere to be found.
    if (mediaIsOff(spaceId, mediaType)) {
      await setMediaStatus('skipped');
      log.info(`Media file ${peerText(spaceId)}/${peerText(filePath)} not analysed: ${mediaType} analysis is off for this space`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    await setMediaStatus('pending');
    await enqueueMediaJob(spaceId, filePath, mimeType, mediaType, { arrival: input.arrival === true }).catch(err => {
      log.warn(`enqueueMediaJob error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`);
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
      await setFileProcessingState(spaceId, normId, { embeddingStatus: 'skipped' });
      log.info(`Document ${peerText(spaceId)}/${peerText(filePath)} not analysed: document extraction is off for this space`);
      return { resolvedFormat, embeddingStatus: 'skipped' };
    }
    // The same rule as the media branch (`settledAndIdentical`): the same bytes on a document that converted, or whose job is
    // under way, are not converted again. Before it, the document branch had no skip at all: a repeat arrival deleted the
    // conversion the file held and `enqueueTextJob` RESET a job that was `pending` or `processing`, throwing away a
    // conversion that was half done every time the same bytes came again.
    if (settledAndIdentical(input.prior, input.sha256)) {
      log.debug(`Document ${peerText(spaceId)}/${peerText(filePath)}: identical bytes already ${peerText(input.prior.embeddingStatus)} — conversion skipped`);
      return { resolvedFormat, embeddingStatus: input.prior.embeddingStatus === 'complete' ? 'complete' : 'pending' };
    }
    // Document (md/txt/html/pdf/docx/epub): always converted by the background worker.
    // Clear stale conversion artifacts first so overwriting a document does not leave
    // duplicate chunk records behind.
    await deleteConversionArtifacts(spaceId, filePath).catch(err => {
      log.warn(`deleteConversionArtifacts error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`);
    });
    await enqueueTextJob(spaceId, filePath, resolvedFormat, mimeType).catch(err => {
      log.warn(`enqueueTextJob error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`);
    });
    return { resolvedFormat, embeddingStatus: 'pending' };
  }

  // Plain text ('text': an extension the pipeline does not convert): stored as-is, no embedding pipeline — and SAID so. Every
  // class this function declines is left in a terminal state, because the lazy repair of a pulled file asks "did processing
  // run on a class that processes" and cannot tell a file nothing will ever process from one whose processing never ran;
  // an unstamped row would be offered to it for ever (bundle-48, P9). The ANSWER is unchanged (no status for plain text: the
  // write responses and the tools have never carried one for it); the row says it.
  await setFileProcessingState(spaceId, normId, { embeddingStatus: 'skipped' });
  return { resolvedFormat };
}

/**
 * Write a file's row for bytes that are on disk, then dispatch their processing — with the row read FIRST. The one sequence
 * every door that records bytes goes through: a person's upload (`files/store-file.ts`) and a peer's arrival
 * (`files/bytes-arrived.ts`), which differ only in HOW the row is written, and that is the one parameter.
 *
 * ## What it prevents
 *
 * The prior read. By the time the dispatcher runs, the row already holds the ARRIVING hash, so a dispatcher (or a caller) that
 * reads it afterwards compares the new bytes with themselves: a changed file on a `complete` row was skipped and left `complete`
 * under the new hash, with the old analysis (bundle-48, Q-260). The read was written out by hand at each door beside the row
 * write, and the second door was the one that forgot it. Here it cannot be forgotten, because it is not a thing a caller does:
 * `readPriorProcessing` is private to this module, and a caller cannot hand a `prior` of its own.
 *
 * `writeRow` is awaited between the read and the dispatch and its failure propagates, so a row that was not written is never
 * dispatched. `input.sha256` is required: an unknown hash means "process" and the skip never fires.
 */
export async function recordAndDispatchFile(
  spaceId: string,
  filePath: string,
  input: Omit<DispatchInput, 'prior' | 'sha256'> & { sha256: string },
  writeRow: () => Promise<unknown>,
): Promise<DispatchResult> {
  const prior = await readPriorProcessing(spaceId, filePath);
  await writeRow();
  return await dispatchFileProcessing(spaceId, filePath, { ...input, sha256: input.sha256, prior });
}
