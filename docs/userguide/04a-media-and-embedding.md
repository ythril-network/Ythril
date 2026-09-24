# Settings — Media Processing and Embedding

> Part of the [Ythril User Guide](../userguide.md).

## Settings — Media Processing

**Settings → Media Processing** (admin only, MFA-protected) controls how Ythril turns image, audio, video, and document uploads into searchable content.

The page has **no heading of its own** — the left-hand navigation and the tab strip already tell you where you are, so there is nothing to look for at the top. This guide used to say the page was titled *Models & Media*, which was wrong twice over: there is no title, and the name it gave was not the one in the navigation.

By default, Ythril ships with a bundled vision service (Ollama running `moondream`) and a bundled speech-to-text service (faster-whisper-server). When you upload a picture, Ythril writes a short caption of what's in it; when you upload audio or video, it transcribes the words. The result is added to the same search index as your facts, so you can find an attachment by what's *inside* it, not just its filename.

### The three tabs, and where each control lives

The page is split into **Models**, **Pipelines** and **Tools**, and knowing which is which saves
hunting:

| Tab | What is on it |
|---|---|
| **Models** | Which model answers for vision and speech — provider, endpoint, model name, API key, and each slot's call budget |
| **Pipelines** | **The per-class ceilings.** How far Ythril may go with an image, audio, video or text file — the highest level any space is allowed to ask for |
| **Tools** | The vector-index table and the per-space index rebuild |

**The image ceiling has four settings, not two**, and only the third is worth explaining:

| Setting | What happens to an uploaded image |
|---|---|
| **Off** | Stored as-is; nothing is read out of it |
| **Caption** | A short description of what is in the picture, added to search |
| **Recognition** | Caption **plus face recognition** — this is the one that identifies people, so it is the rung to think about before raising |
| **Auto** | As much as the instance can do |

A space can never ask for more than the ceiling set here. Raise a space's own level under its Settings
tab and the picker simply does not offer anything above this line, with a note saying why.

### When to change this

- **Turn a class off.** There is no single on/off switch — each media class has its own **level**, and
  there are **four**: images, audio, video and **text**. Set a class to **Off** if you don't upload that
  kind of media or your machine is tight on fact; its provider card then reads **off** and new uploads
  of that class are stored as-is (existing files keep their captions). **All four have to be Off** to
  turn media embedding off entirely — this said three, so following it left Text running.
- **Use an external provider.** Switch the **Provider** on the **Vision** or **Speech** card to *External* if you'd rather call OpenAI, Azure, or any other OpenAI-compatible service. Fill in the **Endpoint**, **Model**, and **API key (external only)** for that provider. API keys are stored in the encrypted secrets file, never alongside the rest of the configuration.
- **Use a different local model.** Keep the provider on *Local* but change the **Model** field — for example, switch the vision model from `moondream` to `llava` if you've pulled it into Ollama.

### How long a model may take

Each model slot has its own call budget — how long **one** request to that model may run before Ythril gives up on it. The defaults suit the bundled models: 2 minutes for image captioning, 5 minutes for transcription, 20–30 seconds for the smaller text models, 1 minute for the document models.

Raise one when a model is slower than the default allows — a large vision model on a busy GPU, or a host that loads a model from disk before it can answer the first request. The symptom is a job that reports a timeout while the model itself was working fine.

Two things happen automatically when you raise a budget, and both matter:

- **The stall detector follows it.** Ythril re-queues a job that has reported no progress for a while, and a single long call reports nothing while it runs. So the stall timeout is raised above the longest budget you set — otherwise a job would be re-queued in the middle of a call it was allowed to make, throw the work away, and reach the same call again. You do not have to adjust it yourself.
- **Nothing else changes.** The budget bounds one call. It is not a retry count, not a queue setting, and it does not affect how many jobs run at once.

**The three document cards — Document VLM, Document repair and Document verify — show a budget too, and it is the one setting on those cards that is yours.** Their model and endpoint really are fixed by your infrastructure administrator; the budget and the reasoning effort are not, and there is no environment variable for them at all, so this screen is the only place they can be set.

**How the document page budget and a document slot budget fit together.** The DOCUMENTS pipeline has a **per-page time limit** that applies to every model call made while reading a page. A budget you set on one of the three document cards **replaces it for that model** — leave the card blank and the page limit is what that model gets. So the page limit is still the one number to change when the whole document path is too slow, and a card budget is for the one model that needs longer than the rest.

Your infrastructure administrator can fix a slot's budget so it cannot be changed here — it will show the **env** badge described below.

### Asking a model to think less

Some models reason before they answer, and reason at length: a 27-billion-parameter model measured on a
partner platform takes **3 minutes 32 seconds** at its own default. Nothing is wrong when that happens — it is
thinking — but if your call budget is three minutes, every one of those calls fails and the log says timeout.

Raising the budget is one answer; asking for less thinking is usually the better one. Each slot has a
**Reasoning effort** setting for it: leave it blank and nothing is sent, which is what every installation did
before this existed. `none` turns thinking off outright and works on any model; `low`, `medium`, `high`,
`xhigh`, `minimal` and `max` are passed to the model itself.

**Check which values YOUR model accepts, because a wrong one fails every call** — the server starts normally
and then rejects each request. Qwen3.8, for example, takes `low`, `medium` and `xhigh` and errors on the other
three; on it, `medium` cuts the wait by about a third.

If you have a second model, pointing the slot at one that does not think is better still. This setting is for
when you have one model and need it to answer faster.

### Locked fields

Fields shown with an **env** badge cannot be changed from the UI — they are pinned by an environment variable set by your infrastructure administrator. This is normal in managed deployments where credentials are injected by Kubernetes secrets or similar.

### When a provider won't connect

*New in 2.1.*

**Test connection** reports what the server actually gets back, and the failure text names the reason
rather than just saying it failed. Two cases account for almost all of them:

- **"Blocked SSRF target … resolves to blocked address 10.x / 192.168.x / 172.16-31.x"** — the endpoint
  is on a private network address. Ythril refuses those by default, because an admin-settable URL that
  the server will call is the classic way to make a server fetch things it should not. If the endpoint is
  a model server you run yourself, that refusal is wrong for your case and an administrator can permit it
  — for that one endpoint alone, or instance-wide — see
  [Diagnosing a Misconfiguration](../integration-guide/02-hosting.md#diagnosing-a-misconfiguration). The message names
  the exact setting for the endpoint you were testing. It cannot be enabled from this page, on purpose.
- **"Blocked SSRF target … 169.254.x" or a loopback address** — these stay blocked whatever the setting.
  Point the endpoint at a real service address.

And one result that looks like a problem and is not:

- **"Reachable · no model list"** — the endpoint answered, and it has no page listing its models. That is
  the normal shape of a single-purpose inference server: a Whisper service serves only its transcription
  route, so asking it for a model list can only ever come back "not found". Test connection says what it
  found and leaves the card green, because a missing *list* is not a missing *service*. Use **Verify** to
  confirm the model itself answers — it sends a real request down the real path. If Verify fails too,
  hover the result: the detail names the exact URL that was tried, which is usually a base URL with a
  wrong path.

Every refusal is also written to the server log with the same detail, so an administrator can find it
without you having to reproduce the click.

### Verify — does the model actually answer?

*New in 2.2.*

**Test connection** asks "is something there". It cannot answer *does my model work* — an endpoint can be
reachable, list your model, and still fail on every real request. **Verify** sends one real request and
tells you what came back. There is a button on the **Vision**, **Speech-to-text**, **Embedding** and
**Assist** cards.

**It never sends your data.** The payload is always generated: a 1×1 transparent image, a few
milliseconds of synthesised silence, or the word `ping`. It goes through the same code path the worker
uses, so a transport problem shows up here instead of on someone's first upload.

Four outcomes:

| Result | Meaning |
|---|---|
| **OK** | The model answered. A short sample of what it returned is shown. |
| **Still loading** | It did not answer within 3 minutes. Not a failure — a backend that swaps models onto a shared GPU can legitimately take 30 seconds or more on the first call. Try again. |
| **Failed** | It answered, but wrongly — or the call errored. The detail names what happened. |
| **Not configured** | No model is set for that card. |

Silence transcribing to no text is a **pass** for speech-to-text: the payload is silent, so reaching a
proper response *is* the result.

Verify costs a real request, so on a metered endpoint it costs money. It is recorded in the audit log for
that reason; Test connection, which only lists models, is not.

### Privacy note

When both providers are set to *Local*, no file content ever leaves your instance. Switching to *External* sends image frames or audio segments to the configured endpoint — review your data residency policy before doing so.

### External assist model (documents)

The **External assist model** card lets you point a bigger, hosted model at the **document repair pass** — the one used by the `repair` extraction level (and by `auto` when a repair model is configured). It does two jobs: the document repair pass, switched on by the **extraction level**, and — when a conversation is **ingested** — writing its claims and entity descriptions, which sends the conversation's turns to the same host. Ingest refuses a raw conversation when this card is empty, and names it. Fill in an **Endpoint** + **Model**, then raise **Document extraction** to **Repair** (or **Auto**) to route repairs through it. At that point you are asked to **acknowledge the egress** — document content (OCR text, and page images) is sent to that host. The acknowledgement is recorded against the host and re-checked at run time, so an endpoint you have not acknowledged is never contacted: repairs fall back to the local model instead.

This is the one document setting that sends content off your instance: the model receives OCR-extracted text and draft transcriptions (and, for future image tasks, rendered page images). Because of that, configuring a host pops an **acknowledgment dialog** naming exactly what data goes where — you must confirm before it is used, and Ythril records that consent against the host and re-checks it at run time, so content is never sent somewhere you did not acknowledge. Endpoints are checked to be public addresses, and the API key is stored in the encrypted secrets file. Leave it unconfigured — or keep **Document extraction** below **Repair** — to keep document processing fully local.

### Decision model (extractors)

The **Decision model** card sets the model Ythril's extractors ask their judgement questions: who *"she"* is
in a conversation, whether a message is something the speaker pasted in, whether a statement is already
stored. Everything else an extractor does is ordinary code; these are the few calls that need a model.

It is set up for **TypeSafe** (`https://api.typesafe.ai`, model `jev-latest`) — add your key and save. Like
the assist model, it sends content off your instance — conversation text, and the questions asked about it —
so saving asks you to **acknowledge the egress** to that host first. An endpoint you have not acknowledged is
never contacted: the extractors use the **assist model** instead, and if neither is set up they refuse to run
rather than guess. Saving only the card's call budget asks nothing.

When the card is read-only, the endpoint is pinned by the `DECISION_URL`, `DECISION_MODEL` or
`DECISION_API_KEY` environment variables.

---

### Face Recognition

Face recognition lets Ythril automatically detect faces in uploaded images and link them to person entities in your space. Once you label a few photos, new uploads containing the same person are tagged automatically.

**This feature is opt-in and disabled by default.** It requires local model files to be placed on disk (not bundled). See the [integration guide](../integration-guide.md) for download links and setup.

#### How to use it

1. **Place the model files** — Download `blazeface-back.json`, `blazeface-back.bin`, `faceres.json`, and `faceres.bin` from `https://vladmandic.github.io/human/models/` and place them in the `human-models/` folder inside your data directory.
2. **Raise the Images pipeline to `recognition`** — face recognition has no switch of its own: it is the top rung of the **Images** pipeline. Set the instance ceiling under **Settings → Media Processing → Images** to **Caption + face recognition** (or `auto`), then, if you want it only in certain spaces, leave the others on **Caption**. Images deliberately default to **Caption** — face embeddings are biometric data, so an instance never acquires them just by being installed. `FACE_RECOGNITION_ENABLED=false` in the environment remains available as an infra-level hard-off that overrides every ladder.
3. **Upload images** — Any image that goes through the media pipeline is automatically processed. Faces are detected, embedded, and stored. If no gallery exists yet, faces are stored unlabeled.
4. **Label a face** — Open the file in the Files view and link it to a person entity (via the entity tag in the file metadata panel). The face embedding is immediately added to the gallery.
5. **Auto-labeling kicks in** — From this point on, new images containing that person's face are automatically linked to their entity, as long as the match score exceeds the confidence threshold.

#### Deleting a person

Deleting a person entity **removes their label from every face linked to it**, and stops those faces from auto-labeling anyone in future. This happens on every path a person can disappear by: deleting them from the Brain, wiping all entities in the space, or the entity expiring through its TTL.

The face records themselves are kept, with their label cleared. That is deliberate: the face belongs to the *photo*, which you did not delete — after removing the person, Ythril simply no longer claims to know whose face it is. If you want the face data itself gone, delete the image; that removes its face records along with every other derived artifact.

> Under `strictLinkage`, face labels do **not** block deleting a person. Other references (edges, facts, chrono entries) still do. Faces are written automatically by the recogniser rather than created by you, and they are cleared safely by the deletion itself — so blocking on them would only make the person impossible to remove.

#### Settings

These are set in `config.json` under `mediaEmbedding.faceRecognition`, or pinned by your infrastructure through the matching environment variable (`FACE_RECOGNITION_ENABLED`, `_CONFIDENCE_THRESHOLD`, `_MIN_FACE_SIZE_FRACTION`, `_MODEL_PATH`, `_PERSON_ENTITY_TYPES`, `_REPROCESS_SYNCED_IMAGES`). An environment value wins over `config.json`, so `FACE_RECOGNITION_ENABLED=false` guarantees no faces are processed on that instance — including after restoring a backup taken where it was on. Neither is editable from the UI:

>
> **If a save on Media Processing is refused, the page now tells you which field the API objected to.** The
> outcome of every save on that page — the refusal with its reason, or the confirmation that it was stored —
> appears below the tabs. It previously appeared nowhere, so a refused save looked exactly like a button that
> did nothing, and so did a successful one.
>
> **If Save on Models or Media Processing did nothing at all, that was a bug and it is fixed.** On 3.2.0 both pages sent one field the API had stopped accepting — the face-recognition master switch, which is now set only by your infrastructure — and because the whole request is checked at once, the API refused *everything* on the page rather than that one field. The symptom was a Save that appeared to work and changed nothing, on either page, whatever you had edited. Nothing was lost; nothing was ever written.
>
> **Any field your infrastructure pins is refused by the API too, not just greyed out in the interface** — and from 3.2.0 that holds for every pinnable field rather than only the face-recognition ones. Before then, a pinned model or key elsewhere in Media Processing could be saved without complaint: the value that actually ran was still the pinned one, but the save reported success and left the stored settings disagreeing with the running ones. If you saw a setting that would not stay changed, that was this.
>
> **And a field can now be fixed at NOTHING**, which was previously impossible. Setting a variable to empty does
> not pin it — your orchestrator cannot tell "the operator left this blank" from "the operator wants it blank",
> so treating an empty value as a lock would freeze every field on every deployment. Instead list the fields:
> `YTHRIL_PINNED_FIELDS=rerank.apiKey,nli.apiKey`. Each one becomes read-only here and is refused by the API, at
> whatever it currently resolves to. That is the answer for a key field pointing at an endpoint inside your
> cluster that needs no key: empty is the correct value, and now it can be the fixed one.
>
> **If you misspell a name, the page tells you.** A notice at the top of **Settings → Media Processing → Models**
> lists any entry that matched no field, because a pin you believe is in force and is not would be worse than no
> pin at all. Names have to be fields this page can save; anything the API never accepts is already fixed and
> needs no pin.

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `false` | Master switch — must be set to `true` to activate the feature |
| `confidenceThreshold` | `0.6` | How similar a face must be to a gallery entry to be auto-labeled (0–1). Start conservative; increase as your gallery grows. |
| `minFaceSizeFraction` | `0.05` | Minimum face size (as a fraction of the image's shorter side). Smaller faces in crowd shots are ignored. |
| `personEntityTypes` | `["person"]` | Entity types considered as people. Only entities of these types can enter the face gallery. In the admin UI (**Settings → Media Processing → Face recognition**) these are **picked from your Schema Library's entity types**, shown as removable chips; any value already stored stays selectable even if it's no longer in the library. |
| `reprocessSyncedImages` | `true` | When true, images received from other instances via sync are queued for face recognition automatically. |

#### Configuring an external face service asks you to confirm it — once, at the right moment

Pointing Ythril at your own face-recognition service means face crops leave this machine, so it asks you to
confirm the exact destination before using it. Two moments raise that question, and they are the two moments
you are actually deciding:

- **Setting or changing the endpoint**, on **Settings → Media Processing → Models**.
- **Raising the image level to “Caption + face recognition”**, on **Settings → Media Processing** — because
  that is equally an act of switching faces on.

Until you confirm, the endpoint is **saved and not used**: faces are handled by the built-in model instead,
exactly as they would be if your service were unreachable. Nothing is lost and nothing leaves.

**What changed, in case you met the old behaviour.** An unconfirmed endpoint used to make the whole page
refuse to save — any setting, on either page, whether or not it had anything to do with faces. If you have
seen a Save fail with a message about acknowledging a host while you were editing something unrelated, that
was this.

#### If face recognition finds nobody, check the descriptor width first

**This is the one failure here that is silent and, until it is fixed, permanent.** A face gallery is built at
a fixed vector width, and a face measured at any other width is skipped — logged once per restart and never
again. So the symptom is not an error: it is photographs that plainly contain people being recorded as
containing none.

The default width is **128**, which is what the bundled recogniser produces. If you point Ythril at your own
recogniser — the `externalModel` setting above — and it is one of the 512-wide families (ArcFace, AdaFace,
FaceNet, EdgeFace, buffalo_l), the space needs to be told. **Nothing derives the width from the endpoint you
configure**, so an untold space stays at 128 and skips everything your model sends it.

There is no control for this on the Settings page; it is a per-space number set through the API
(`faceDescriptorDims`). What matters at this level is knowing to ask:

- **A space that has never held a face can be moved to a new width.** Ask whoever administers the instance
  to set it; the change is accepted.
- **A space that already holds faces cannot.** Its stored vectors were measured at the old width and nothing
  re-measures them, so re-declaring it would break every face already labelled rather than fix the new ones.
  Those photographs have to be re-processed in a space created at the right width.

The practical order, if you are bringing your own recogniser: get the width right **before** the first
photograph is uploaded. Everything after that is recoverable only by re-processing.

---

### Document Processing (OCR & Image Extraction)

When you upload a PDF, DOCX, or EPUB, Ythril converts it to text using the `unstructured-api` sidecar, which includes Tesseract OCR. The conversion strategy controls the trade-off between speed and quality.

These settings live in `config.json` under `mediaEmbedding.documentProcessing`:

| Setting | Default | What it does |
|---|---|---|
| `strategy` | `"hi_res"` | `"hi_res"`: full OCR + layout analysis — accurate on scanned documents, extracts embedded images and tables. `"auto"`: sidecar decides. `"fast"`: text layer only, no OCR, fastest. `"ocr_only"`: forces OCR even on born-digital PDFs. |
| `extractImages` | `true` | When using `hi_res`, images embedded in the document are extracted, saved, and queued for the media pipeline (captioning + face recognition). |

**Default behaviour (no configuration needed):** every uploaded PDF is OCR'd with full layout detection, embedded images are extracted and independently captioned, and tables are converted to structured HTML. For text-heavy documents without scanned content or images, `"fast"` is significantly quicker.

---

## Settings — Embedding

**Who may show Ythril inside their own page.** By default, nobody: Ythril can only be framed by itself, and a
portal that tries gets nothing. Adding an origin here is how you say yes.

The case this is for: somebody runs a portal and wants your brain to appear inside it as a panel rather than
opening in a new browser tab. They cannot grant that themselves — only the brain's operator can, and until 3.2.0
that meant editing `config.json` on the server.

### Adding an origin

Enter one exact origin per row — scheme, host and port, nothing else:

```text
https://portal.example.com
https://intranet.example.com:8443
```

Then **Save**. The change is active on the next request; nothing needs restarting.

What is refused, and why the form tells you rather than tidying up:

| Entry | Result |
|---|---|
| `https://portal.example.com` | accepted |
| `https://portal.example.com/app` | refused — an origin has no path |
| `http://portal.example.com` | refused — `https` is required (except on `localhost`) |
| `*` or `https://*.example.com` | refused — there is no "allow everything" mode, by design |

A refused row is marked and named back to you. An entry that was silently dropped would look like a save that
worked, and you would go looking at the portal for a fault that was here.

If the list looks right and a portal still opens in a tab, the row to check is any one marked red on load: an
invalid entry written directly into `config.json` is skipped by the server and shown as refused here.

### What you are agreeing to

**A listed origin gets two permissions together, and they cannot be separated:**

1. it may display Ythril inside a frame on its own page; and
2. it may restyle Ythril at runtime — colours, surfaces, the whole palette.

They share one list deliberately: an origin you trust to render Ythril inside its own chrome is exactly the origin
you trust to change how it looks. Both are also ways to impersonate this interface — a frame can be positioned
under something else, and a restyle can make a real page look like a different one. So the practical rule is the
same as for any credential: list only origins you operate, or trust to the degree you would trust yourself.

Removing an origin takes effect immediately too. There is no per-user version of this list and no API that lets a
non-admin token extend it; changing it requires an instance admin and a second factor.
