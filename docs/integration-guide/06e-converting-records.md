# Converting Records

> Part of the [Ythril Integration Guide](../integration-guide.md).

A schema change decides what a record may look like from then on. It does not touch the records already stored: they were written under the old schema, and a rename or a split can leave them in a shape the new schema does not accept. **Converting** brings the records of the types a change reaches to the new schema: the ones that already fit are marked as fitting, the ones that need a rewrite are rewritten by steps you declare, and the ones that cannot be converted are left as they are and listed for a person to settle.

This page is for an integrator who changes schemas by API. What a schema is, and how a record is checked against it, is in [Space Schemas and Validation](06a-schema-api.md). The words are the same on every door: **convert**, **stamped**, **rewritten** and **unconverted**.

## When you need it

Every record carries a **stamp**, its `schemaFingerprint`: the schema it conformed to as stored (see [Schema versions](06a-schema-api.md#schema-versions)). After a schema change the stored records still carry the old stamp.

- A change that only **adds** (a type, an optional property) needs nothing rewritten. Convert it anyway with `{}` and the records that conform get the new stamp, so a filter on the schema version they carry finds them.
- A change that **renames a property, changes an enum's values, renames a type or splits one** leaves old records in a shape the new schema refuses. Declare the **steps** that say how an old record becomes a new one, in the same request as the change.
- A change that was saved earlier, by another door or by someone else, is converted afterwards with the **Convert** act, with or without steps.

A conversion starts from exactly two requests:

| Start | Door | Runs |
|---|---|---|
| A schema save with `convertRecords` | `PATCH /api/spaces/:id`, MCP `schema_update` | on a space in no network, when the save lands; on a networked space, when the vote passes on each member (at once on the proposer when its own yes passes it) |
| The Convert act | `POST /api/spaces/:id/schema-convert`, MCP `space_schema_convert` | at once, toward the schema the space has now |

**Every other door that changes a schema converts nothing**: `PUT /api/spaces/:id/schema`, the single-type `PUT` and `DELETE`, applying or editing a schema-library entry, a network precedence change, a layer arriving from a network, and leaving a network. A run that is going when one of them changes the schema is not stranded: it restarts toward the schema the space has then, with the types it had not finished.

## What a run does to each record

A run reads **every copy of the types it reaches that this instance holds**, whoever last wrote it: a record written here, one a peer delivered, one whose author has left the network. A fork row (an unresolved version of a record) is left alone. Each copy ends in one of four ways:

| Outcome | What it is | What the record keeps or gains |
|---|---|---|
| `stamped` | The copy already fits the new schema and no step changes it. | The new `schemaFingerprint`, written in place. **No new version, no change date, no new position, nothing replicated, no webhook, no embedding job.** Lists do not reorder. |
| `rewritten` | A step changes it. | An ordinary write of the record with the new stamp in the same write: a new version (`seq`), a new `updatedAt`, a new position (it moves to the top of every list sorted by change date, here and on every peer), it replicates to every peer, and it is embedded again. No webhook fires: the run writes as the instance, not as a token. |
| `unconverted` | It cannot be converted: the steps would leave it not conforming, no case of a split matches, a rename would collide, or its version cannot go higher. | Nothing. It is left exactly as it is and listed as an [unconverted item](#the-unconverted-list). |
| `moved` | The record changed while the run was reading it. | Nothing from this run, which does not pass it again. The write that moved it was validated and stamped as every write is, so a copy written in the new shape carries the stamp; one written in the old names is converted by the next run of its type (a schema change of it, or Convert). |

An edge of an entity that was re-typed by a `renameType` is stamped again after the entity moves (`edgesRestamped`), because a re-typed entity takes the stamp off its edges.

A run is **idempotent**: a record that carries the run's target stamp is not read again, and an item already dismissed for the same version of the record toward the same schema is not listed again.

### What a rewrite costs

A rewrite is a real edit, so say so to the people whose data it touches:

- The record **moves to the top of every list sorted by change date** and its change date moves, on this instance and on every peer.
- It **replicates**: every record a step changes travels to every member of every network the space is in, at their next sync.
- It is **embedded again** on every member (a renamed property changes the text a record is embedded from).
- It is **not undone**. There is no undo of a rewrite; the old shape is gone from the record, and a later conversion with the inverse step is another rewrite.
- A rewrite takes a version above everything this instance has seen. A body a peer wrote that this instance has not received yet is overwritten by a rewrite of the stale copy, last writer wins. The first sync a run asks for on a networked space (below) shortens that window and does not close it.

Converting with no steps, or on records no step changes, costs none of this: a stamp is not an edit.

## The steps

A conversion declares its steps as `convertRecords`:

```json
{ "steps": [ { "op": "renameProperty", "kind": "entity", "type": "person", "from": "nick", "to": "alias" } ] }
```

`{}` is a conversion with no step. There are four steps; each names one `kind` (`entity`, `fact`, `edge` or `chrono`) and one type (an edge's type is its label).

| `op` | Fields | What it does to a record of the type |
|---|---|---|
| `renameProperty` | `kind`, `type`, `from`, `to` | Moves the value of property `from` to `to`. |
| `mapEnum` | `kind`, `type`, `property`, `values` | Replaces a value of `property` by the one `values` maps it to (`{ "old": "new" }`); other values stay. |
| `renameType` | `kind`, `from`, `to` | Gives the record the type `to`. |
| `splitType` | `kind`, `from`, `cases`, `otherwise?` | Gives a record of type `from` the `to` of the first case whose `when` condition is true for it, else `otherwise`; no `otherwise` and no case true makes it unconvertible. |

How the steps apply to one record, in a fixed order whatever the order of the list:

1. The **type steps** decide the type the record has afterwards. A split's conditions are read against the record as it is, in order, and the first true case wins. A condition that reads a property the record lacks is false for that case.
2. The **property steps** of that resulting type then apply: every `renameProperty`, then every `mapEnum` (`property` names the property by its new name).

A record that holds both the old and the new name of a rename is not convertible (`both_set`). A condition is a [rule](06a-schema-api.md#rules) expression that must answer true or false, judged by the same engine and priced against the same budget as a type's rules, and it reads `self.properties.<name>` as a rule does.

The bounds are each refused, never cut, and the refusal names the one that was passed: the steps in one `convertRecords` (as many as a space may have rules), the entries in one `values`, the `cases` in one split, the length of a type name and the length of a `when` (a rule's length).

### How a step is checked

Each step is held to the schema **before** the change and the schema **after** it, when you save (`400 bad_conversion_step`, with the index of the step as `step`), and nothing is written if one fails. The Convert act holds each step to the schema the space has now, because it changes no schema.

| Step | The schema before must | The schema after must |
|---|---|---|
| `renameProperty` | declare `from` on the type | declare `to` on the type, and **not declare `from`** |
| `mapEnum` | declare `property` with an `enum` holding every key of `values` | declare `property` with an `enum` holding every value of `values` |
| `renameType` | declare `from` | declare `to` |
| `splitType` | declare `from`, and every condition must be a valid, affordable rule | declare every case's `to` and `otherwise` |

Also refused: a name renamed to itself, two renames of one property or onto one name, a key mapped to itself, two type steps on one type, and a property step on a type that a type step moves every record out of.

**A renamed property's old name must be gone from the schema after the change.** The schema a space runs on is its own definitions with each network's layer laid under them, and their properties are united. A rename between two names that are both still declared would move values every schema still accepts under the old name. A **type** is not required to be gone: a networked change never removes one (see [On a network](#on-a-network)).

### Worked examples

The examples save to the space `people`. The REST request is `PATCH /api/spaces/people` with the body shown; the MCP call is `schema_update` with the same fields as arguments (`meta`'s keys become arguments, `space` names the space). A save that carries `convertRecords` answers the ordinary answer with `convert` added (the space on REST), here for a space in no network:

```json
{ "convert": { "state": "started", "types": [{ "kind": "entity", "type": "Person" }], "toFp": "<the fingerprint the run converts toward>" } }
```

**Rename a property.** `Person` declared `fullName`; after the change it declares `name`, and the step moves the value.

```json
{ "meta": { "typeSchemas": { "entity": { "Person": { "propertySchemas": { "name": { "type": "string" } } } } } },
  "convertRecords": { "steps": [{ "op": "renameProperty", "kind": "entity", "type": "Person", "from": "fullName", "to": "name" }] } }
```

MCP `schema_update`:

```json
{ "space": "people",
  "typeSchemas": { "entity": { "Person": { "propertySchemas": { "name": { "type": "string" } } } } },
  "convertRecords": { "steps": [{ "op": "renameProperty", "kind": "entity", "type": "Person", "from": "fullName", "to": "name" }] } }
```

A named type is replaced whole, so the type in `meta` is its full definition after the change: here `name` and nothing else. That is also why `fullName` is gone from the schema after.

**Map enum values.** `Person` declared `status` with the values `a` and `b`; it now declares `x` and `y`.

```json
{ "meta": { "typeSchemas": { "entity": { "Person": { "propertySchemas": { "status": { "type": "string", "enum": ["x", "y"] } } } } } },
  "convertRecords": { "steps": [{ "op": "mapEnum", "kind": "entity", "type": "Person", "property": "status", "values": { "a": "x", "b": "y" } }] } }
```

MCP `schema_update`:

```json
{ "space": "people",
  "typeSchemas": { "entity": { "Person": { "propertySchemas": { "status": { "type": "string", "enum": ["x", "y"] } } } } },
  "convertRecords": { "steps": [{ "op": "mapEnum", "kind": "entity", "type": "Person", "property": "status", "values": { "a": "x", "b": "y" } }] } }
```

The `convert` answer is the one shown above. A value that `values` does not name is not changed, and a value the new enum does not allow makes the record unconverted.

**Rename a type.** `person` declares `fullName`; the entities of type `person` become `human`, which declares it too.

```json
{ "meta": { "typeSchemas": { "entity": { "human": { "propertySchemas": { "fullName": { "type": "string" } } } } } },
  "convertRecords": { "steps": [{ "op": "renameType", "kind": "entity", "from": "person", "to": "human" }] } }
```

MCP `schema_update`:

```json
{ "space": "people",
  "typeSchemas": { "entity": { "human": { "propertySchemas": { "fullName": { "type": "string" } } } } },
  "convertRecords": { "steps": [{ "op": "renameType", "kind": "entity", "from": "person", "to": "human" }] } }
```

The answer's `types` names the source as well as the target (`person` and `human`): a run reaches the type a type step moves records out of. Whether `person` stays in the schema is your edit's choice on a space in no network, and on a network it always stays (below).

**Split a type.** `person` declares `status`. A record of type `person` whose `status` is `open` becomes an `activePerson`; every other record stays a `person`. The condition is read against the properties `person` declares, so `person` must still be declared when you save.

```json
{ "meta": { "typeSchemas": { "entity": { "activePerson": { "propertySchemas": { "status": { "type": "string" } } } } } },
  "convertRecords": { "steps": [{ "op": "splitType", "kind": "entity", "from": "person",
    "cases": [{ "when": "self.properties.status == \"open\"", "to": "activePerson" }], "otherwise": "person" }] } }
```

MCP `schema_update`:

```json
{ "space": "people",
  "typeSchemas": { "entity": { "activePerson": { "propertySchemas": { "status": { "type": "string" } } } } },
  "convertRecords": { "steps": [{ "op": "splitType", "kind": "entity", "from": "person",
    "cases": [{ "when": "self.properties.status == \"open\"", "to": "activePerson" }], "otherwise": "person" }] } }
```

Leave `otherwise` out and a record that no case matches is not convertible (`no_case_matched`) and is listed. A condition the engine cannot answer on a record (an input too large) makes that record unconvertible too (`could_not_evaluate`).

## Saving with `convertRecords`

`convertRecords` is a top-level field of the save, beside `meta` and never inside it. It needs a `meta` in the same request: without one the answer is `400` `convert_needs_meta`, because a step is held to the schema before and after a change. It starts the same rewrite as the Convert act, so it pays **the same price** ([below](#the-convert-act-and-the-status-of-a-run)), beside what each `meta` field needs; a save without `convertRecords` is priced as before. On a network the proposer pays it at the save; a member that applies the passed round pays nothing (it did not call). A body with `convertRecords` and `targetNetwork` is allowed; the steps then go to that one network's round.

The answer carries `convert`, and a save that sent no `convertRecords` carries none:

| `convert.state` | Meaning |
|---|---|
| `started` | The run was started on this instance (or joined the run already going) toward `toFp`. It continues in the background. |
| `after_vote` | The save opened a vote that has not passed here. Each member starts its run when the round passes there. |
| `nothing` | The change reaches no type a run converts, so nothing was started. |
| `not_started` | The schema was saved and the run could not be started; `error` says why. The save is not undone: read the run with the status door, or run Convert. |

`types` lists the types the save converts: the types the change touched, the types a type step moves records out of, and, on a space in no network, the types a replace left out. When the change touches the space's `rules`, every kind a changed rule governs is converted whole, and its `type` is `*`.

The answer comes when the run is **created**. The records are converted afterwards, in the background, one page at a time; the run survives a restart and is resumed.

## The Convert act and the status of a run

```http
POST /api/spaces/:id/schema-convert
GET /api/spaces/:id/schema-convert
```

The act converts the records of the types you name toward the schema the space has **now**, with optional steps. It changes no schema and is never voted.

```json
{ "types": [{ "kind": "entity", "type": "person" }],
  "steps": [{ "op": "renameProperty", "kind": "entity", "type": "person", "from": "nick", "to": "alias" }] }
```

`types` is a list of `{ kind, type }`, at least one and no more than one start takes (`too_many_convert_types` names the number). `steps` is optional. There is no other parameter: a key this capability does not have is refused. Answers `202` at once:

```json
{ "state": "started", "toFp": "<the fingerprint the run converts toward>", "types": [{ "kind": "entity", "type": "person" }], "steps": 1 }
```

Here `steps` counts the steps the run holds. MCP `space_schema_convert` takes `space`, `types` and `steps` and answers the same body.

- **It converts every copy this instance holds**, as a run does, and **does not sync first**: its caller asked for it now. A copy another member already converted is skipped (it carries the stamp). When another instance converts the same record at the same moment, both write the same converted record and the later version wins; when the two use different steps (one of them refused its steps), the later write decides.
- **The price, one for the act and for a save that carries `convertRecords`** (both start the same rewrite): `knowledge: admin`, the space's admin right, and one call of the heavy-call allowance. The rewrite reaches every peer, so a token with `knowledge: admin` that does not administer the space is refused (`403` `space_admin_required`); the allowance is the server's heavy-call allowance, a few a minute per token, shared by the act, those saves and the server's other heavy calls on both doors, and past it the answer is `429` `schema_convert_rate_limited`. It is asked after every other refusal, so a refused call costs none of it.
- **One run at a time for an explicit start.** While a run of the space is unfinished the act answers `409` `schema_convert_running`. A schema save or a passed vote joins an unfinished run instead. Every start of a space, whichever door asks, is made one after another, so two starts at once never lose a run.
- **Bounded.** `types` is bounded as above and `steps` as a save's are; how often is the price's allowance.

The status of a run is read with `GET` (MCP `space_schema_conversion`, `knowledge: read`). It writes nothing and answers `{ "state": "none" }` for a space that never had a run:

```json
{ "state": "complete", "toFp": "…", "types": [{ "kind": "entity", "type": "person", "done": true }],
  "steps": [{ "op": "renameProperty", "kind": "entity", "type": "person", "from": "nick", "to": "alias" }],
  "stepsRefused": [], "sources": [{ "kind": "act", "at": "2026-11-18T10:00:00.000Z" }], "owed": false,
  "syncedFirst": { "asked": 0, "answered": 0 }, "startedAt": "…", "finishedAt": "…",
  "counts": { "stamped": 12, "rewritten": 3, "unconverted": 1, "moved": 0, "edgesRestamped": 0 }, "left": 0, "failures": 0 }
```

| Field | Meaning |
|---|---|
| `state` | `running`, `complete`, or `failed` (a run nobody is owed gives up after repeated failed passes and says why in `error`). |
| `toFp` | The schema fingerprint the run converts toward. When the schema changes while a run is going, the run restarts toward the new one. |
| `types` | The types it reaches, each with `done`. |
| `steps`, `stepsRefused` | The steps the run applies, and the ones it did not, each `{ step, reason }`. A `step` of `null` means all of them (a vote's steps this member did not apply). |
| `sources` | What started it: `write` (a save), `round` (a passed vote, with its `roundId`) or `act`, each with `at`. A run that was joined by a later start lists each. |
| `owed` | `true` when a passed vote started it: it is retried for as long as it is owed, never `failed`. |
| `syncedFirst` | `{ asked, answered }`: the peers it asked for one sync before it began, and how many answered. Absent while that sync has not ended; `{ 0, 0 }` for a run that asks none (an act, a space in no network). |
| `counts` | `stamped`, `rewritten`, `unconverted`, `moved` and `edgesRestamped`, as in [What a run does](#what-a-run-does-to-each-record). |
| `unconvertedNotListed` | Present when a run found more unconvertible records than it lists; the number it did not list. |
| `left` | The records of the unfinished types still to read, counted within one bound for the whole answer (two seconds, however many types are left); `null` when the count did not finish in it, never a part of it. |
| `failures`, `error` | The passes that failed so far (the store did not answer, or a space act held the space) and the words of the last failure. A pass that failed is retried. |

**Through a personal view** ([Personal views](06d-personal-views.md)) the status reads the members the view reads for you. A view that reads one member answers exactly as that member does; one that reads several (or none) answers each member's run, in the view's order, because a run is one space's, toward that space's schema, and runs toward different schemas do not add up:

```json
{ "state": "per_member", "runs": [{ "space": "qa", "state": "none" }, { "space": "ops", "state": "running", "toFp": "…", "left": 12 }], "viewMembers": ["qa", "ops"] }
```

## The unconverted list

A record a run could not convert is left as it is and listed. An item is local to this instance and never synced, so a record no member can convert is listed on each member that holds it.

```http
GET /api/spaces/:id/schema-convert/items?kind=&type=&reason=&status=&skip=&limit=
```

MCP `list_unconverted` (`knowledge: read`) takes the same parameters. The list is newest first; `status` is `open` unless you ask for `dismissed` or for `all`, which lists the open and the dismissed items together in the same newest-first order (each row says its `status`, `total` counts both, and `skip`, `limit` and `nextSkip` page the one list, so a page may hold both kinds); any other status is `400` `unconverted_bad_status`, and the message names it. It is paged as the Brain's other lists are (`total`, `count`, `skip`, `limit`, `truncated`, and `nextSkip` when a page was cut) and carries `counts: { open, dismissed, openBy }` for the whole space whatever the filters (see [Counting the open items](#counting-the-open-items)). A row:

```json
{ "itemId": "…", "space": "qa", "kind": "entity", "recordId": "…", "type": "person", "seq": 105, "fromFp": "…", "toFp": "…",
  "reason": "not_conforming", "violations": [{ "field": "properties.status", "reason": "…" }],
  "proposed": { "set": ["alias"], "unset": ["nick"] }, "status": "open", "detectedAt": "…", "record": { "summary": "Ada" } }
```

`space` is the space the item lives in, the one a dismissal names. **Through a personal view** the list reads every member the view reads for you and merges their items newest first, each row naming its member, with `counts` summed over them; past `skip + limit` of the merge's bound the page is refused (`unconverted_bad_paging`): page a member directly.

`reason` says why: `not_conforming` (the converted record would still not conform, or a record that needed no step does not conform), `no_case_matched`, `both_set`, `could_not_evaluate`, `relationship_exists` (an edge relabel onto a relationship that already exists), `functional_taken` (a relabel onto a subject the label's functional rule already holds), `version_ceiling`, `fork`, `step_refused` and `conversion_failed` (the rewrite failed for a reason no other class names, on three passes of the run in a row; its one violation names the kind of error, never its words, and the run went on without it). `violations` names fields and reasons, **never a stored value**, each with its `code` and `params` ([Schema violation codes](04f-write-semantics.md#schema-violation-codes)); an item stored before 6.6 has `field` and `reason` only and is listed so. `proposed` is what the steps would have made of it. `record.summary` is the record's own name or text, and is absent when the record is gone.

**One reason or several.** `reason` takes one reason, or a list of them to list the items of any: `reason=not_conforming,fork` or `reason=not_conforming&reason=fork` on REST, an array (or the same comma text) on MCP. `total` counts the items of all of them, and the other filters and `status` still narrow the list. A list names at most as many reasons as there are, each once; a blank piece (`reason=fork,`) is ignored, and nothing but blank pieces is no filter. An unknown reason anywhere in the list, or a longer list, is `400` `unconverted_bad_reason`, and the message names the value. One reason answers exactly as it always did.

### Counting the open items

`counts.openBy` groups the **open** items of the whole space by what they are: `[{ "kind": "entity", "type": "person", "reason": "not_conforming", "n": 3 }, …]`, ordered by kind, then type, then reason. It ignores `kind`, `type`, `reason`, `status`, `skip` and `limit` (it is the space's, as `open` and `dismissed` are), leaves out dismissed items, and its `n` add up to `counts.open`. Through a personal view the members' groups are added: a group two members hold is one group with the sum. It holds at most 500 groups; past that it holds the first 500 in that order and `counts.openByCut` is `true`, and the groups then add up to less than `open`. With no open item it is an empty list. A page that lists one class of reasons and shows a count beside each class reads these groups, not the `total` of the list it asked for.

**An item is settled by editing the record** (a later write is checked against the schema and stamped, and the item goes stale), **by converting again with other steps**, or **by dismissing it**. A stale item (its record is gone, was written since, carries the space's stamp now, or its type is defined differently now) is removed by the instance's own sweep a little later and is listed until then: a read never writes.

### Dismissing

```http
POST /api/spaces/:id/schema-convert/items/:itemId/dismiss
POST /api/spaces/:id/schema-convert/items/dismiss
```

The first dismisses one item (MCP `dismiss_unconverted`, `{ space, itemId }`) and answers `{ "item": { …the row, "status": "dismissed" } }`. The second dismisses every **open** item a filter lists (MCP `dismiss_unconverted_shown`), when you were shown exactly `expect` of them:

```json
{ "kind": "entity", "type": "person", "reason": "both_set", "expect": 7 }
```

`reason` is one reason, or a list of them (`"reason": ["not_conforming", "fork"]`, or one text with commas), read as the list reads it: the call dismisses the open items of any of them, `expect` counts over all of them, and it is the `total` the list answers for the same filter (a list with `status=all` counts dismissed items too, so ask with the default status to get the number to confirm). The call dismisses open items only: a `status` of `all`, `dismissed` or anything but `open` is `400` `unconverted_bad_status`, naming the value. It answers `{ "dismissed": 7 }`. If the number of open items for that filter is not `expect`, nothing is dismissed and the answer is `409` `unconverted_changed` with `current`; list again and confirm the new number. A filter that matches more open items than one call may dismiss is `400` `unconverted_too_many` with `max`, the most one call takes: narrow it by kind, type or reason. Both need `knowledge: write`.

A dismissal changes no record: the item stays, marked `dismissed`, and a run that meets the same version of the record toward the same schema does not list it again. A new version of the record, or another schema, can.

## On a network

A space in a network is changed by a vote, so the steps travel with it.

**The proposer.** `PATCH` with `convertRecords` and a `meta` opens a `meta_change` round on each network that carries the space (a pub/sub network this instance subscribes to is not one: its edit opens no round there and lands in its own definitions); the round carries the steps beside the schema (`convertRecords` on the round). The steps are checked at the save **by the same check every member makes when the round passes**, against the same pair of schemas: what the round carries (the schema the changed types held, plus the definition of every type a type step moves records out of, and the schema it proposes) and what this instance will run on once the round has landed here, which is its own definitions with each network's layer as the round leaves it (the round replaces each type it carries in the layer of every network it reaches, so a property the change drops from a shared type is gone from that layer too). So a save is refused (`bad_conversion_step`) exactly when its own conclusion would refuse the steps: a renamed property's old name must be gone from what this instance will run on, a step must hold against what the round proposes, and each type step must move records into a type the change sends (`step_target_not_in_round`: send the definition of the target type with the change). A space in no network has no round: its steps are held to its schema before the change and after it. The proposer's own cast carries a third signature, `csig`, over the steps; a member on an older release does not read it. The answer's `convert.state` is `after_vote` while the round is open and `started` when the proposer's own yes passed it (a club, the publisher of a pub/sub network, the only member).

**A voter** reads the steps on the vote row before it casts: `convertRecords` is on the round as `GET /api/networks/:id/votes` and MCP `network_votes` show it ([List Open Vote Rounds](08-networks-api.md#list-open-vote-rounds)). **A yes on such a round is a yes to the schema and to rewriting the records of the named types on every member that applies the steps.** A member's yes depends on the schema alone: one that cannot read it casts no yes.

**What each member does when the round passes.** The schema is applied as a vote applies it. The steps are applied only when all of these hold; otherwise the member takes the schema and its run applies **no step**:

1. The proposer's `csig` verifies over the steps as the round carries them. A round that was stripped of its `csig`, or whose steps were added or changed after the proposer cast, is read as unsigned (`steps_not_signed`). A relay can therefore never make a member rewrite its records.
2. Every step holds against the round's own change: the schema the types held when it was proposed and the schema it proposes, and each type step moves records only into a type the round changes (`step_target_not_in_round`).
3. The member's own definitions, once the round has landed, no longer declare a renamed property's old name (`property_still_declared_here`). A member that declares it itself may still hold records under it.

A member that applies no step still stamps the copies that conform, lists the ones that do not as items, and its status names why in `stepsRefused` (`{ "step": null, "reason": "…" }`). It **rewrites nothing**, so it cannot undo another member's conversion. The reason is one of the three above or the code of a step check (`property_not_declared_after` and the others of [How a step is checked](#how-a-step-is-checked)).

**Every member converts every copy it holds.** Each member's run reads every copy of its types, whoever wrote it, so a member that pulled the records of another converts them too. A run that a save or a vote started on a networked space **syncs once with each peer it pulls from before it reads its first page**, waits for no peer that does not answer, and records `syncedFirst`. A copy another member already converted arrives converted, carries the stamp, and is not rewritten again here; in most cases the fastest member rewrites the records and the others receive them. When two members rewrite the same record before either copy has travelled, both write the same converted record and the later version wins. A member that was unreachable receives the converted records at its next sync, and its own run then finds nothing left to rewrite.

**A run a vote started is owed.** It is retried with backoff for as long as it is owed, resumed after a restart, and restarted toward the new schema when the schema moves; it never ends `failed`.

**Types on a network.** A network never removes a type: a `meta_change` round merges per type, and a type the change leaves out is kept. So `renameType` and `splitType` on a network add the target types to the layer and keep the source; the records move when the round passes. A property rename or enum map is the same round that replaces the type by name in the layer, which is what removes the old name.

**A member on an older release** keeps the steps on the round, takes the schema and converts nothing. After it upgrades, nothing starts by itself: a round only a member of this release concluded is owed a run, so a round the older release concluded is not; running Convert on its types converts its copies. See [Upgrading](02b-upgrading.md).

## Refusals

Every refusal carries a `code`; the same code is on both doors.

| Code | Status | Where | What to do |
|---|---|---|---|
| `bad_conversion_step` | `400`, with `step` | a save, the act | Fix the step at that index: `error` says why in words. Nothing was written or started. |
| `convert_needs_meta` | `400` | a save | Send `convertRecords` with the `meta` of the change. |
| `bad_convert_types` | `400` | the act | Send `types` as a non-empty list of `{ kind, type }`. |
| `too_many_convert_types` | `400` | the act | Name no more types than the message says, and start again for the rest. |
| `bad_convert_request` | `400` | the act | Send only `types` and `steps`, and `steps` as a list. |
| `knowledge_rung` | `403` | the act, the status, a save with `convertRecords` | The token needs `knowledge: admin` to start and `knowledge: read` to read. |
| `space_admin_required` | `403` | the act, a save with `convertRecords` | Use a token that administers the space. |
| `schema_convert_running` | `409` | the act | Read the status and start again when the run is no longer `running`. |
| `schema_convert_rate_limited` | `429` | the act, a save with `convertRecords` | Wait and start again: see the price above. |
| `unconverted_rung` | `403` | the lists and dismissals | The token needs `knowledge: read` to list and `knowledge: write` to dismiss. |
| `unconverted_bad_kind`, `unconverted_bad_type`, `unconverted_bad_status`, `unconverted_bad_reason` | `400` | the lists and dismissals | Send a filter from the lists above. For `reason`: every reason in a list must be one that exists, and a list names at most as many as there are. |
| `unconverted_bad_paging` | `400` | the list | Send `skip` and `limit` as whole numbers. |
| `unconverted_bad_item_id` | `400` | the dismissal | Send an `itemId` a list returned. |
| `unconverted_item_not_found` | `404` | the dismissal | List again: the item may have been removed as stale. |
| `unconverted_bad_expect` | `400` | the bulk dismissal | Send `expect`, the whole number of open items you were shown. |
| `unconverted_changed` | `409`, with `current` | the bulk dismissal | List again and confirm the new number. |
| `unconverted_too_many` | `400`, with `max` | the bulk dismissal | Narrow the filter. |

A space that is not configured here is `404` (on the start and the dismissals a personal view's id too: they write), an id the 6.0 upgrade retired `410` `space_retired`.

## Audit and metrics

A start is audited as `schema.convert.start`, a finished run as `schema.convert.run` (an entry of the instance's own, with the counts), a list as `unconverted.list`, and the dismissals as `unconverted.dismiss` and `unconverted.dismiss_shown` ([Audit Log](13-audit-log-api.md)). The counters `ythril_schema_convert_records_total` (by `outcome`) and `ythril_schema_convert_runs_in_progress` are in the [metrics reference](11-setup-api.md).

## Not built

- **A personal view as the space** of a start or a dismissal: they write, so they name one configured space, as every act that writes or administers does.
- **Undo of a rewrite.** A converted record keeps no copy of its old shape.
- **A conversion on the other doors that change a schema** (the full-schema `PUT`, the single-type `PUT` and `DELETE`, the schema library, precedence, a layer arriving): they convert nothing until you run Convert.
- **A network vote that deletes a type.** A rename or split on a network keeps the source type.
