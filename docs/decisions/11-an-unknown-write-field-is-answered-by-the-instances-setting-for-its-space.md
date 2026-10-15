# 11 — An unknown top-level field on a brain write is answered by this instance's setting for the space, never dropped silently and never shared

**Status:** accepted, 2026-10-15 · **Scope:** the top-level fields of a brain record write (create, update, merge, bulk item) on REST, MCP and `POST /api/<tool>`; the per-space `unknownWriteFields` setting that answers them; the MCP `update_space` argument that sets it

## Context

A brain write can carry a top-level field the write does not take. Before this decision the three doors answered it
three ways. REST warned on a create and an update. MCP refused the whole call through its input schema. Some routes
read a field the tool did not declare, and some declared fields no route read, so the same mistake got different
answers depending on the door, and a field a route silently dropped was indistinguishable from one it applied.

Two constraints make a single fixed answer wrong. A client written against an older release sends fields a newer one
no longer takes, and refusing it outright breaks a working integration the day the field is removed. An operator who
wants a typo refused, so that a write never lands with a misspelt key, has no way to ask for that if the answer is fixed.
And the answer is about **this** instance: a network member that refuses unknown keys does not change what a peer stores.

## Decision

- **An unknown top-level field is answered by one setting, read per space on this instance.** `unknownWriteFields` is
  `warn` (the default) or `refuse`. `warn` stores the record and names each field in `warnings`; `refuse` writes nothing
  and answers `400`. The same rule answers every door, after the target space is resolved.
- **A retired name is refused by name in either mode**, because a retired name is a field whose meaning changed, not one
  nobody has heard of.
- **The setting is a top-level field of the space configuration, not a `meta` key, and it is never replicated or voted
  on.** A `meta` key travels through networks and rounds; a top-level space field does not. A key outside `meta` never
  replicates, so each member decides its own answer.
- **The accepted keys are derived, not listed.** An operation's accepted set is read from the input schema of the MCP
  tool that writes it, so the REST route, the MCP tool and the client cannot keep three hand lists that disagree.
- **Every answer to a judged call names the unknown fields**, including a refusal for another reason and a record stored
  while its connections were not. A refusal row carries no received value.
- **The judgement is counted, not logged per key.** `ythril_unknown_write_fields_total` is labelled from fixed vocabularies
  (`door`, `operation`, `mode`, `outcome`), so a caller cannot mint a series by spelling a key.

## Consequences

- **The default changes what MCP does.** An unknown top-level argument to a brain write is stored with a warning, where it
  was refused. An operator who relies on refusal sets the space to `refuse`, on each instance that wants it.
- **Refuse is a per-instance choice that can differ between members of one network.** The setting is read back on
  `GET /api/spaces`, `space_meta` and `list_spaces`, and it is absent when the answer is `warn`.
- **Refuse makes some formerly accepted requests fail**: a shared option a route does not read, and a client that sends
  server-written keys back. Both are named in the upgrade note, and both are answered by name, so the fix is to send less.
- **This is the reversal to prevent:** a route that drops an unknown field without naming it, a second hand-written list of
  accepted keys beside the derived one, a judgement that a door makes on its own rather than the shared one, and a
  replicated copy of the setting, which would let one instance's answer decide what another stores.

## Where the detail lives

- `server/src/contract/write-accepts.ts` — the accepted-key derivation, the judge and the bounded rows.
- `server/src/api/decorate-json-answer.ts` — how a REST answer carries its rows, once per request.
- `server/src/spaces/spaces.ts` — `unknownWriteFieldsMode`, the one reader of the setting.
- `server/src/mcp/call-tool.ts` — the target, the judge and the single exit that carries the rows.
- `docs/integration-guide/04-brain-api.md` — the rows, their wording and their bounds, on REST.
- `docs/integration-guide/16-mcp.md` — the same rule on MCP, and the tool argument.
- `docs/userguide/04-settings.md` — the control on the Schema tab, labelled "This instance".
