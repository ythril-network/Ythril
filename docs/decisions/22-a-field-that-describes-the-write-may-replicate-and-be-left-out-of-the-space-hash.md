# 22 — A field that describes the write, not the record, may replicate and still be left out of the space hash

**Status:** accepted, 2026-11-12 · **Scope:** the space hash (Merkle leaf) of every replicated record kind, the set `REPLICATED_UNHASHED_FIELDS` in `server/src/brain/merkle.ts`, and the first field in it, `schemaFingerprint` (bundle-265, D-76)

## Context

Until now a record field was in one of three places for the space hash: hashed (it replicates, and two members agree only when it is equal), local-only (it never leaves the instance, so it is not hashed), or retagged (it replicates and every arrival rewrites it to this instance's own value, as `spaceId` under a `spaceMap` alias). The hash is how two members decide they hold the same data: a leaf that differs sends the cycle looking for a record to exchange, and `MERKLE_DIVERGENCE` is the operator's signal that something does not converge.

`schemaFingerprint` fits none of the three. It is the fingerprint of the schema a record was held to when it was written, and a record keeps it only while it conforms. It must travel: a receiver uses it to know which schema version the writer meant, and fetches that version on demand from the sender when it lacks it. But hashed, it splits members that hold the same record:

- **A member below 6.6.0 drops it on arrival**: its `Incoming*` schemas strip a key they do not declare. The newer member holds the stamp, the older one does not, and an equal-seq copy is never stored over the held one (`sync/upsert-plan.ts` answers `skipped`), so nothing ever brings them back together.
- **Two members may stamp the same version differently**: each holds a record to its own variation of the schema (own types plus network layers), so the same content can carry two honest stamps.

In both cases the records are equal; only the metadata about the write differs. A hashed stamp would report `MERKLE_DIVERGENCE` on every cycle where nothing is wrong, and an operator taught to ignore it would miss the real one.

## Decision

- **A fourth place: replicated and not hashed.** A field that describes the write rather than the record may travel with the record and be left out of the leaf. It is named in `REPLICATED_UNHASHED_FIELDS` in `merkle.ts`, with its reason beside it, and nowhere else; the derived-field set the leaf drops is built from that list together with the local-only and retagged ones.
- **Its first member is `schemaFingerprint`.** It travels on push, pull and import as the writer sent it (a malformed value is read as absent on every arrival door), and the leaf never sees it.
- **A field in this set is not local-only and not retagged**: the arrival writer must keep it (a stamp stripped on arrival is no stamp) and must not rewrite it.
- **The gate `a-replicated-field-reaches-its-incoming-schema` reads the set**: a field that replicates and is not hashed must be named there, and a hashed field must be declared by its `Incoming*` schema.

## Consequences

- **Two members can agree while their stamps differ.** The hash cannot tell which member holds a stamp; a member that needs to know asks the record, not the hash. A stamp that went missing on one member returns only when that record is next written there or arrives with a higher seq.
- **Changing only a stamp is not a change the network will exchange.** That is the intent: a stamp changes when content or conformance changes, and those writes move the seq.
- **The set must stay small and each entry must be metadata about the write.** A content field put here to silence a divergence would let two members hold different data and report them equal, which is the reversal this record exists to prevent.
- **This is the reversal to prevent:** adding `schemaFingerprint` back into the leaf "for completeness", which brings back divergence on every cycle with an older member or a different variation; moving it to the local-only list, which strips it on arrival; or putting a content field into this set to quiet a `MERKLE_DIVERGENCE`.

## Where the detail lives

- `server/src/brain/merkle.ts` — `REPLICATED_UNHASHED_FIELDS` and its reason, beside the local-only and retagged lists.
- `server/src/sync/incoming-schemas.ts` — the `Incoming*` schemas that declare the stamp and read a malformed one as absent.
- `testing/standalone/a-replicated-field-reaches-its-incoming-schema.test.js` — the gate over the set; `testing/standalone/a-schema-fingerprint-travels-on-the-wire.test.js` — the stamp on push, pull and import, and a root that does not move with it.
