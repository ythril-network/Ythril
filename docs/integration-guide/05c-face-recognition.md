# Face Recognition Pipeline

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Face Recognition Pipeline

### Face Recognition Pipeline

The face recognition pipeline detects and embeds faces in uploaded images, builds a per-space face gallery, and automatically links images to person entities when a match exceeds a configurable confidence threshold. **By default** it runs entirely in-process on the CPU — no GPU, no sidecar, no Python — using `@vladmandic/human` (TF.js CPU backend).

It can instead call an **external face-embedding endpoint** (`faceRecognition.externalModel`, env var `FACE_RECOGNITION_EXTERNAL_MODEL`), which is how you use a recogniser we do not bundle — ArcFace, AdaFace, FaceNet, buffalo_l. **When that is configured, face crops leave the Ythril process**, so the egress policy marks it guarded ALWAYS with an operator acknowledgement REQUIRED regardless of locality — unlike the `nli` and `rerank` slots, which exempt local URLs. A biometric payload is treated as biometric whether the endpoint is on the same cluster or not.

> This page previously described the pipeline as in-process only while documenting behaviour that exists for the external path — reported by the canary operator on 2026-08-12, who could not find `FACE_RECOGNITION_EXTERNAL_MODEL` because it was absent from THIS page. It was documented in [02-hosting.md](02-hosting.md)'s egress matrix, which is not where anyone configuring face recognition would look. Both are corrected below.

**Faces are governed by the image LEVEL, not by a switch of their own.** They run only where the effective
image level is `recognition` (or `auto`, which resolves to the most the instance allows). The instance
default is `caption`, so **no face detection happens until someone raises a level** — on
**Settings → Media Processing** for the instance ceiling, or per space in that space's media settings.

There is no longer a face-recognition checkbox: it was redundant with the ladder, and having two controls
meant an image level of `recognition` could still silently do nothing. `mediaEmbedding.faceRecognition.enabled`
survives as an **infra pin only** — it defaults to `true` and exists so `FACE_RECOGNITION_ENABLED=false`
can hard-disable the pipeline regardless of any level, for deployments where biometric processing must be
impossible rather than merely off. Setting it to `true` does not enable anything by itself.

**Turning it off stops new detection; it does not erase what was collected.** Existing face vectors and person labels stay stored and searchable until the files they came from are deleted. The admin UI states this in a confirmation before saving, because switching this off is usually a privacy decision and the two are easy to confuse.

#### Prerequisites: Model Files

The model files are not bundled with Ythril. Download and place them in `DATA_ROOT/<modelPath>/` (default: `human-models/`):

| File | Size | Purpose |
|---|---|---|
| `blazeface-back.json` + `.bin` | ~0.5 MB | Face detector (BlazeFace Back) |
| `faceres.json` + `.bin` | ~6.7 MB | Face descriptor (FaceRes). The model outputs 1024 dimensions; `@vladmandic/human` reduces them to the 128 the gallery stores |

Download from `https://vladmandic.github.io/human/models/` — use the exact filenames listed above.

Also create the Atlas vector index for face embeddings (per space, 128 dimensions, cosine similarity, field path `faceEmbedding`, index name `{spaceId}_files_faceEmbedding`) on the `{spaceId}_files` collection. This is done automatically when a space is initialised.

#### How It Works

When a media-embedding job processes an image whose effective level permits faces (`recognition` or `auto`,
and the infra pin not turned off):

1. **Decode** — image bytes decoded to raw RGBA via `sharp`.
2. **Detect** — `@vladmandic/human` runs BlazeFace Back detection. Faces below `minFaceSizeFraction` (default: 5% of the shorter image side) are skipped.
3. **Embed** — FaceRes produces a descriptor per face, which the library reduces to 128 dimensions. That reduction, not the model weights, is where the 128 comes from — worth knowing because the gallery is built on it.
   - **The width is read from the space's own face index**, not from an instance-wide constant, so a space
     is judged against the vectors it actually holds. Every space is still created at 128 today; what
     changed is that nothing downstream assumes it. A gallery built at one width keeps rejecting another
     even if the default changes later — its stored vectors have not moved.
   - **A descriptor of any other width is skipped, and the first one is logged as a warning** naming the width received and which path produced it (in-process or external). One odd descriptor must not fail a whole media job, so the skip itself is not an error; the log is once per process, because a changed width means every face is affected and a per-face log would bury the message. If face recognition appears to find nothing, check for this warning before concluding the images have no faces — that is the symptom a width mismatch produces.
4. **Gallery search** — each descriptor is searched against the space's face gallery (all face-chunk records that have a `faceEntityId`) using an exact `$vectorSearch`. The top-1 result is examined.
5. **Auto-label** — if the top match's cosine similarity score ≥ `confidenceThreshold` (default: `0.6`), the parent image is linked to that entity (a `file` → `entity` link record is written). The first successful match wins.
6. **Persist face-chunks** — one `{fileId}#face-chunk{N}` filemeta record per detected face is written (or replaced on reprocess) with:
   - `faceEmbedding` — the 128d descriptor
   - `faceBbox` — normalised `[x, y, w, h]` bounding box
   - `faceEntityId` — populated if auto-labeled or manually labeled
   - `faceScore` — cosine similarity of the gallery match (when auto-labeled)
   - `parentFileId` — the original image's filemeta `_id`

#### Gallery Poisoning Guard

Only entities whose `type` is listed in `personEntityTypes` (default `["person"]`) are eligible for the face gallery. When a user manually links an image to an entity via `updateFileMeta`:

- If the file links to exactly one `personEntityTypes` entity, all face-chunks of that file are immediately updated with `faceEntityId` — the labeled face enters the gallery at once.
- If zero or more than one person-type entity is present, no gallery entry is made. This prevents a "group photo" from poisoning the gallery with an ambiguous identity.

#### Manual Label Propagation

When a user manually changes which entities an image links to (`linkEntities`, e.g. correcting a mis-label via the Files UI or REST API), Ythril calls `propagateFaceLabel` — which sets `faceEntityId` on every face-chunk record belonging to that file. This immediately improves future auto-labeling for that person's identity.

#### What happens to a label when the person record changes

A `faceEntityId` names an entity, so the two have to move together. **A label that points at an entity which no
longer exists stops resolving, and a face whose label does not resolve is silently absent from the gallery** —
it is not an error anywhere, so the only symptom is a person's gallery quietly emptying.

Both ways a person record can go away are handled, and they are handled **differently on purpose**:

| what happened | what happens to the labels | why |
|---|---|---|
| the person entity is **deleted** — directly, by a bulk wipe, or by TTL expiry | `faceEntityId` and `faceScore` are **cleared**. The descriptor, bounding box and the file itself are untouched | the person is gone, so the label is wrong. The face is still a face and stays available to match against a future person |
| two person entities are **merged** | the absorbed entity's labels are **moved to the survivor**, keeping `faceScore` | a merge asserts the two records were always the same person, so the faces belong to the survivor. Clearing them would discard correct labels |

A face that was detected but never labelled is untouched by either.

#### Synced Image Reprocessing

When `reprocessSyncedImages: true` (default), images received through a network sync are automatically enqueued for face processing if they have not yet been processed (`faceChunkCount` is `0`). This lets secondary instances build a full face gallery from synced images without requiring separate re-uploads.

Set `reprocessSyncedImages: false` to restrict gallery building to images uploaded directly to each instance.

#### MongoDB Atlas Vector Index

Face recognition requires a dedicated Atlas vector search index per space. Name: `{spaceId}_files_faceEmbedding`, field: `faceEmbedding`, similarity: `cosine`. This is distinct from the text embedding index used by `recall`.

#### Choosing the gallery width: `faceDescriptorDims` at space creation

The index is created at **128 dimensions by default**, which is what the bundled in-process model produces. A different recogniser produces a different width, and **a descriptor of the wrong width is skipped** — the symptom is indistinguishable from *"these photographs contain no faces"*, with one warning per process as the only signal.

So the width is chosen **when the space is created**, with `faceDescriptorDims`:

```http
POST /api/spaces
{ "id": "photos", "label": "Photos", "faceDescriptorDims": 512 }
```

Also available as `faceDescriptorDims` on the `save_space` MCP tool. Use **128** for MobileFaceNet-class models (including the bundled one) and **512** for ArcFace / AdaFace / FaceNet / EdgeFace / buffalo_l.

**Every space has a width from the moment it exists, whether or not a face index was ever built.** An unset `faceDescriptorDims` is not "undecided" — it resolves to **128**, the built-in default, and nothing derives it from the endpoint you configure. So a space created without it, pointed at a 512-d recogniser, builds a 128-wide index and skips every descriptor it is handed. This sentence exists because that resolution was invisible: an operator with fourteen spaces read the rule below and could not tell whether their empty ones carried a width at all.

**It can be changed afterwards, but only while the space has never held a face descriptor.**

```http
PATCH /api/spaces/photos
{ "faceDescriptorDims": 512 }
```

Also `faceDescriptorDims` on the `update_space` MCP tool, with the same refusals.

Two states refuse it, both with **409** and both naming the number they found:

| State | Why |
| --- | --- |
| The space holds face descriptors | Nothing re-derives a stored face vector, so re-declaring the width would leave every one of them unmatchable while reporting success |
| Its face index is built at a different width | The gallery is empty, so nothing would be stranded — but an existing index is not re-dimensioned in place, and a width recorded here that the index disagrees with is worse than either number alone |

Sending the width it already has is always accepted and changes nothing, so a client that re-sends its whole config can still save an unrelated edit.

**This used to be refused categorically, and that was too broad.** The reason for the rule is about STORED VECTORS — and a space that has never held a face has none to strand. An operator asked the question on 2026-08-20 with fourteen spaces, three images between them and not one descriptor at any width; their only remedy was to re-create every space, which for spaces holding real data is not a remedy. The safety guard was always index-and-descriptor based; it was the API surface that was absolute.

**The supported order for bringing your own recogniser** is still: create the space with the right `faceDescriptorDims` **first**, then point `FACE_RECOGNITION_EXTERNAL_MODEL` at your endpoint. It is the reliable path because it is the only one that cannot be refused. Doing it the other way round embeds at your width against a 128-wide gallery, and every descriptor is skipped.

The matcher reads the width from **the space's own index**, not from an instance-wide constant, so a space is judged against the vectors it actually holds and a later change of default cannot invalidate an existing gallery.

**This index is never re-dimensioned automatically, and that is deliberate.** Ythril rebuilds other vector indexes when their definition changes, because re-embedding the records makes the vectors catch up. Face vectors live on already-stored face-chunk records and nothing re-derives them, so a rebuild at a new width would leave the stored vectors indexed as if they were the new width — every similarity score wrong, with no error reported. If the configured width ever differs from an existing space's index, Ythril **refuses the change, keeps the existing width, and logs both numbers**. A filter-field change still applies, at the existing width.

**There is still no supported way to move a POPULATED gallery to a new width.** An earlier version of this page said to re-embed its faces at the new width first, which described a path that was never built: having re-embedded, there was no call that set the new number. There is one now — see above — but it refuses precisely the populated case, because the refusal protects vectors that already exist. Re-create the space at the width you want.

When the face recognition feature is first enabled, any existing `initSpace` call will create the required index. If you add the feature after spaces already exist, re-run `initSpace` for each space or create the index manually via the Atlas UI / MongoDB admin API.

#### An unacknowledged endpoint is stored and UNUSED — it does not block anything else

`faceRecognition.externalModel` sends face crops off the instance, so it needs an explicit acknowledgement:
`acknowledgedHost` must equal the endpoint's host **including its port**. Until it does, the endpoint is
**stored and not used** — faces fall back to the in-process model exactly as they do for an unreachable one —
and `GET /api/admin/media-config` reports `faceEndpointAwaitingAcknowledgment: true` so a UI can say so.

**The acknowledgement is demanded when a patch ACTIVATES the endpoint**, which is two things:

| This patch… | Consent demanded |
| --- | --- |
| sets or repoints `faceRecognition.externalModel` | yes — you are configuring the destination |
| raises `levels.images` to `recognition` or `auto` | yes — `auto` resolves to the recognition rung, so this switches faces on |
| anything else, while an unacknowledged endpoint happens to be stored | **no** |

That last row is the one that changed. The gate used to fire whenever an unacknowledged endpoint *existed*, so
one stored endpoint refused **every** subsequent write to this route — including raising an image level, which
has nothing to do with face egress. An operator reported it on 2026-08-20 after an afternoon behind it.

**Nothing about what may leave the instance changed.** `detectFacesExternal` refuses an unconsented endpoint
before it opens a connection, and did so before this — which is why relaxing the write was safe. The guarantee
lives at the send site, where it also covers a `config.json` edited by hand.

`documentProcessing.assistModel` follows the identical rule, with `repair`/`auto` as its activating rung.

#### Reading the gallery's readiness log

At boot, each space's face index is polled and its outcome logged by name. The line to know:

```text
Vector search index photos_files_faceEmbedding: gave up after 600s — probe did not serve: ...
```

**This line used to mean nothing.** The readiness probe queried the field `embedding` at the text
embedding width, against an index that indexes `faceEmbedding` at 128 — so it could never succeed, on any
instance, and the message appeared for galleries that were READY and serving. An operator reported it, in good
faith, as evidence that no face index had ever been built. It was not evidence of anything.

It now asks about the field the index indexes, at the width it was built at, so the line means
what it says: this space's gallery did not become queryable inside the window.

**It never affects the space's `indexStatus`.** The face gallery is optional — recall, traversal and text
search all work with it absent — so it is polled and logged but does not vote. A space with five ready text
indexes and no gallery is `ready`, not `failed`.

#### Configuration Reference

All settings live under `mediaEmbedding.faceRecognition` in `config.json`. `confidenceThreshold`, `minFaceSizeFraction`, `personEntityTypes` and `externalModel` are also settable through `PATCH /api/admin/media-config` (merged per field, so a patch naming one leaves the rest alone).

**`enabled` is NOT among them**, and this sentence used to say it was. It became an infra pin when the face switch was removed — whether faces run is decided by the image pipeline's `recognition` rung, and this field only lets an operator hard-disable the pipeline regardless of any level, via `FACE_RECOGNITION_ENABLED`. An operator quoted this line back to us on 2026-08-20 as the third leg of a three-way disagreement: the UI sent the field, the API refused it, and this page said it was accepted. They were right on all three counts.

**`modelPath` and `reprocessSyncedImages` are deliberately NOT on that route either** and stay config/env-only. `modelPath` selects which files the process loads from disk, and a field that chooses what gets loaded has no business being settable from the admin API — the same reasoning that keeps `allowPrivateModelEndpoints` and the document model endpoints off it. `reprocessSyncedImages` decides whether a network peer’s images are re-analysed locally, which is an infra-shaped call.

**Reading the config and sending it back is a supported way to make a partial edit.** `GET` returns the RESOLVED config, so it carries fields this route cannot accept — `enabled`, `modelPath` and `reprocessSyncedImages` among them. Echoing them back unchanged is fine: the server strips them before validating, so a round trip does not fail over a field the server itself emitted. Sending a DIFFERENT value for one is refused with a **403** naming the field and how it actually is set — never a silent 200 for a change that did not happen.

Each field can also be **pinned by an infra admin** through the env var below, with the same precedence as every other media setting: **env → `config.json` → default**. A pinned field is reported in `lockedByInfra` on `GET /api/admin/media-config`, so the Settings UI renders it read-only rather than offering a control that silently does nothing. This is why the env vars exist at all: every other model in the pipeline (vision, speech-to-text, embedding, the assist model, both sidecars) could already be pinned, so an infra-managed deployment could fix every model *except* whether faces are detected and embedded — the setting with the clearest privacy weight of the lot.

| Field | Env var | Default | Description |
|---|---|---|---|
| `enabled` | `FACE_RECOGNITION_ENABLED` | `false` | Master switch. When false, face detection is completely skipped. |
| `externalModel` | `FACE_RECOGNITION_EXTERNAL_MODEL` | *(unset)* | External face-embedding endpoint. **Unset means all inference is in-process and no face data leaves the machine.** Set it to use a recogniser we do not bundle; face crops are then sent there per image, and the egress policy requires an acknowledged host. Pin it when instance admins must not be able to point face processing at an endpoint of their own. |
| `confidenceThreshold` | `FACE_RECOGNITION_CONFIDENCE_THRESHOLD` | `0.6` | Cosine similarity score (0–1) required for auto-labeling. Lower values label more aggressively; higher values require a closer match. Tune upward as your gallery grows. |
| `minFaceSizeFraction` | `FACE_RECOGNITION_MIN_FACE_SIZE_FRACTION` | `0.05` | Minimum face bounding-box size as a fraction of the image's shorter side. Faces smaller than this are skipped (avoids noise from crowd shots or background faces). |
| `modelPath` | `FACE_RECOGNITION_MODEL_PATH` | `"human-models"` | Path relative to `DATA_ROOT` where the BlazeFace and FaceRes model files are located. |
| `personEntityTypes` | `FACE_RECOGNITION_PERSON_ENTITY_TYPES` | `["person"]` | Entity type names that qualify as people. Only entities with a `type` in this list are eligible to enter the face gallery. Extend this list if you use custom type names like `"contact"` or `"employee"`. **Comma-separated** as an env var: `FACE_RECOGNITION_PERSON_ENTITY_TYPES=person,employee`. |
| `reprocessSyncedImages` | `FACE_RECOGNITION_REPROCESS_SYNCED_IMAGES` | `true` | When true, images received via network sync are automatically re-enqueued for face processing if they haven't been processed yet. Set to false to keep gallery building local-origin only. |

> Booleans accept `true` or `1`; anything else reads as false. Pinning `FACE_RECOGNITION_ENABLED=false` is the way to guarantee no face processing happens on an instance regardless of what is in `config.json` — including after a restore from a backup taken on an instance where it was on.
>
> **An env var set to the EMPTY STRING is not a pin.** `docker compose` passes variables as `FACE_RECOGNITION_ENABLED: ${FACE_RECOGNITION_ENABLED:-}`, which leaves them *defined but empty* when the operator set nothing — so reading "defined" as "pinned" would lock all six fields on every Compose deployment and render controls read-only that nobody had chosen to fix. Pin the **value** you want enforced instead: `FACE_RECOGNITION_ENABLED=false`, not `FACE_RECOGNITION_EXTERNAL_MODEL=`. There is currently no way to express *"fixed, and fixed at nothing"* for a field whose empty value is itself meaningful.

**Example `config.json` excerpt:**

```json
{
  "mediaEmbedding": {
    "enabled": true,
    "faceRecognition": {
      "enabled": true,
      "confidenceThreshold": 0.65,
      "minFaceSizeFraction": 0.05,
      "modelPath": "human-models",
      "personEntityTypes": ["person", "contact"],
      "reprocessSyncedImages": true
    }
  }
}
```

#### ISO 27001 Note

Face embeddings (128d float vectors by default) are stored in MongoDB. They are not reversible to images; they cannot reconstruct a face.

**Whether face data leaves the process depends on one setting.** With `faceRecognition.externalModel` **unset** — the default — all inference is in-process and no face data is transmitted anywhere. With it **configured**, face crops are sent to that endpoint on every image processed. That is a deliberate operator choice, gated behind an egress acknowledgement, and it is the one setting on this page with biometric consequences: pin it with `FACE_RECOGNITION_EXTERNAL_MODEL` if an instance's admins must not be able to change it. To guarantee no face processing at all, pin `FACE_RECOGNITION_ENABLED=false` — an **empty** env var is deliberately not a pin (see the env-var note below). If your data residency policy classifies biometric-derived data, ensure your MongoDB instance and backup destinations comply.

---
