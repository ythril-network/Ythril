# 08 — A file row an old receiver stamped is reported, and never repaired by this software

**Status:** accepted, 2026-10-09 · **Scope:** the file rows that a 4.0–5.5 receiver wrote under its own author and a
fresh local seq after pulling a peer's file bytes ("a stamp"); the capability `file_stamp_report` (REST and MCP)

## Context

Between 4.0 and 5.5 an instance that pulled a peer's file bytes stored the file row under **its own** author and its
own next seq, not the peer's. That path is closed; the rows it wrote are still on disk. The stamping instance then
refuses the real author's later edits (they lose the seq compare), a deletion the author issues is judged against the
wrong author, and a network with `merkle: true` reports `MERKLE_DIVERGENCE` every cycle for a space where nothing is
wrong — a warning that teaches an operator to ignore the one signal that means data really is missing.

The owner's first ruling (D-22, 2026-10-08) was *"Build nothing automatic. Add a command you run per space, which
reports what it would change before changing it."* Designing that command found that its second half cannot be built
safely:

- **A stamp and an own upload are the same row.** An instance writes `syncBase.<peer>` after pushing its own bytes to a
  peer as well, so a stamp and an own pushed upload are equal in every stored field except path, seq and timestamps.
  Only a peer can say whose the file is.
- **The peer's answer is not safe to act on.** A peer that is itself a stamping receiver claims this instance's own
  upload as its own, and adopting that answer hands it authorship and, with the delivery stamp, the right to delete the
  file. On a network where both sides push, the wrong stamp already travelled and the peer says the file is ours.
- **A repair does not hold.** It lies below every watermark, so downstream copies never receive it; on a `merkle: true`
  network the peer re-delivers the old stamp within a few cycles; and a stale copy of the stamp arriving afterwards is
  accepted and puts the wrong author back.
- **A report is safe**: it can show each suspect row with the evidence and say "cannot tell" where the evidence is not
  decisive.

The owner's second ruling (D-26, 2026-10-09), asked with four options and a fifth open: **A — report only.**

## Decision

- **This software repairs no stamped file row, on any network type, on request or automatically.** The capability is a
  report: `file_stamp_report` (`POST /api/spaces/:id/file-stamp-report`, `POST /api/file_stamp_report` and the MCP
  tool), per space, instance-admin. The repair stays a manual act on the **real author's instance**: an edit there
  arrives here as a newer version and replaces the stamp.
- **The report says "likely" only on a peer's evidence, and nothing stronger.** Each peer's own file feed
  (`GET /api/sync/filemeta`) must report an author that is that peer, a creation time more than a fixed two minutes
  earlier, the same `sha256`, and nothing edited here; otherwise the row says "cannot tell" with a fixed reason. No path
  is sent to a peer.
- **It writes nothing but one audit entry** (`file.stamps.reported`, an act, not a read): no file row, counter or space
  collection, and it advances no sync watermark.
- **It is priced as what it is**: instance-admin (it names peers and spends the instance's peer credentials, as the
  manual network sync routes do), the shared five-a-minute heavy-call budget, and one run per space at a time.
- **Rows it cannot judge are not listed**: a row a peer authored (a legitimate local edit has the same shape), a row with
  no `syncBase` (every moved file), and a deleted row. The answer states each rule in one sentence and never a count.

## Consequences

- **The false divergence warning stays until an operator acts file by file.** Nothing is automated, and an instance
  nobody runs the report on keeps its stamps. That is the accepted cost of the owner's answer.
- **A `likely` row is a lead.** The peer is the only witness and could claim this instance's own file; a relay that
  stamped the file reports itself as the author; a clock off by more than two minutes can turn a genuine own file into
  `likely`. The operator verifies on the named peer before editing anything.
- **Downstream copies are not reached.** An edit on the real author's instance replaces the stamp on the instances that
  pull from it, and on no instance that does not.
- **The tolerance is a constant of the report**, not the stamp-skew warning setting, and no space or token changes it.
- **This is the reversal to prevent:** adding a `repair: true` option, a boot migration or an arrival rule "because the
  report already knows which rows are stamped". It knows which rows are *likely* stamped, on the word of a peer, and
  every repair built on that word hands a peer authorship and deletion rights over a file that may be this instance's
  own, or is undone by the next delivery of the old stamp. A second form: calling a row "stamped" rather than "likely",
  or dropping a piece of evidence (the author check, the creation margin, the hash) to list more rows.

## Where the detail lives

- `server/src/files/file-stamp-report.ts` — the report, the pure verdict (`stampVerdict`) and the fixed reasons.
- `server/src/sync/peer-for-space.ts` — the one resolver of a peer through the networks that carry the space.
- `docs/integration-guide/06-spaces-api.md` — the contract: parameters, answer, bounds and refusals.
- `docs/userguide/05-storage-data-and-audit.md` — what an operator does with the report, under the `MERKLE_DIVERGENCE`
  section.
- `testing/standalone/a-file-stamp-verdict-says-likely-only-on-every-piece-of-evidence.test.js` — the verdict, one
  condition at a time, and `testing/standalone/a-file-stamp-report-writes-nothing-db.test.js` — the report writes nothing.
