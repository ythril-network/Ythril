/**
 * How this instance recognises faces: the switch, the match threshold, the face-size floor, an optional external model, where the
 * in-process model lives, which entity types are people and whether images that arrived by sync are analysed.
 *
 * Split out of `types.ts` (bundle-236) when `FileMetaDoc.sourceSha256` would have taken it past its size limit, the way `types-embedding.ts`
 * and `types-scanners.ts` (`Q-390`) were: the record moved WHOLE with every field and docblock it carried, and is re-exported from `types.ts`, so
 * no importer changes. It imports nothing, so it cannot become half of a module cycle.
 */

/**
 * Configuration for the face recognition pipeline.
 * Uses @vladmandic/human with the WASM backend (CPU-only, no Python/CUDA).
 * Models: BlazeFace (detect, ~0.5 MB) + FaceRes (embed, 128d, ~6.7 MB).
 *
 * Face embeddings are stored in a separate Atlas vector index (path: faceEmbedding)
 * on the {spaceId}_files collection. When a new image is processed:
 *   1. All faces are detected and embedded.
 *   2. Each face embedding is searched against the gallery (face-chunk records
 *      that have a faceEntityId) via $vectorSearch.
 *   3. If the top match exceeds `confidenceThreshold`, the file is auto-labeled
 *      with that entity (updateFileMeta({ entityIds })).
 *   4. Face-chunk records (one per detected face) are stored as
 *      `{fileId}#face-chunk{N}` with parentFileId, faceEmbedding, and optionally
 *      faceEntityId when auto-labeled or manually labeled.
 */
export interface FaceRecognitionConfig {
  /**
   * **Infra pin, not a user switch. Defaults to TRUE.**
   *
   * Whether faces run is decided by the image LEVEL (`recognition`, or `auto` resolving to it) — this
   * field only lets an operator hard-disable the pipeline regardless of any level, via
   * `FACE_RECOGNITION_ENABLED=false`, for deployments where biometric processing must be impossible
   * rather than merely switched off. Setting it `true` enables nothing by itself.
   *
   * It used to be the opt-in master switch with a checkbox and a `false` default. That was removed
   * because two controls meant an image level of `recognition` could silently do nothing; the ladder is
   * now the single gate, and images default to `caption` so faces stay off until a level is raised.
   */
  enabled?: boolean;
  /**
   * Cosine similarity threshold (0–1) above which an auto-label is applied.
   * Below this threshold the face is embedded but left unlabeled.
   * Default: 0.6 (conservative — tune up as gallery grows).
   */
  confidenceThreshold?: number;
  /**
   * Minimum face bounding box size as a fraction of the image's shorter side (0–1).
   * Faces smaller than this are skipped (avoids noise from crowd shots).
   * Default: 0.05 (5% of shorter side).
   */
  minFaceSizeFraction?: number;
  /**
   * OPTIONAL external face-recognition endpoint.
   *
   * Detection/embedding normally runs IN-PROCESS (BlazeFace + FaceRes from `modelPath`), which is why
   * this is absent by default and why the pipeline never had an endpoint to configure. Setting one lets
   * an operator point at a stronger model; in-process remains the FALLBACK, so an unreachable endpoint
   * degrades rather than failing the pipeline.
   *
   * **This egresses biometric data.** Face crops leave the instance, which is more sensitive than the
   * document text the assist model sends. `acknowledgedHost` records the operator's explicit consent for
   * a specific host and is enforced exactly as `documentProcessing.assistModel` enforces it: the consent
   * must match the host whenever the endpoint can actually be reached. `apiKey` is split into
   * `secrets.json` like every other provider key and is never echoed back.
   */
  externalModel?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    /** Host the operator acknowledged for biometric egress. Must match `baseUrl`'s host to be usable. */
    acknowledgedHost?: string;
    /**
     * Whether a configured-but-failing external provider may fall back to the bundled in-process model.
     *
     * **Defaults to `false`, and that is a deliberate behaviour change** (owner decision 2026-08-08:
     * *"disable by default and enable consciously. its a silent pollution."*). The fallback used to be
     * unconditional, so an unreachable or malformed endpoint quietly wrote a DIFFERENT embedder's vectors
     * into the same gallery. Both models emit the same width today, so nothing detects the mixture — the
     * vectors are simply wrong, and every similarity score computed against them is wrong with them.
     *
     * Skipping is the better failure: the media job retries later and the faces get embedded by the model
     * the operator chose, instead of being permanently embedded by one they did not.
     *
     * **This only applies when an external provider is configured AND consented.** An instance with no
     * external provider is not falling back to anything — in-process is its only path — and it keeps
     * running exactly as before regardless of this flag.
     */
    allowInProcessFallback?: boolean;
  };
  /**
   * Directory (relative to DATA_ROOT) where the @vladmandic/human WASM model
   * files are stored. Defaults to "human-models".
   */
  modelPath?: string;
  /**
   * Entity type names that represent people. Only entities whose `type` is in
   * this list are eligible to be stored in the face gallery.
   *
   * Linking a "location" or "object" entity to a photo will never poison the
   * gallery regardless of how many faces are in the image.
   *
   * Default: ["person"]. Add your own type names if you use a different
   * convention (e.g. ["person", "contact", "employee"]).
   */
  personEntityTypes?: string[];
  /**
   * When true, image files downloaded during a sync cycle (or any image whose
   * entity links are manually updated) are automatically re-enqueued for media
   * embedding if they have not yet been processed by the face recognizer.
   *
   * This allows a secondary instance to build its own face gallery from images
   * that arrived via sync rather than direct upload.
   *
   * Default: true (opt-out with false to keep gallery processing local-origin only).
   */
  reprocessSyncedImages?: boolean;
}
