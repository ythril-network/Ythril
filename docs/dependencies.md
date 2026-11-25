# Dependencies and Licensing Notes

This document explains how Ythril uses its runtime dependencies, the licensing
status of each, and why Ythril's Ythril License obligations are not affected by them.

---

## Node.js packages

Ythril is an npm-workspaces monorepo: the **root** `package.json` declares no runtime
dependencies of its own — they live in `server/package.json`,
`client/package.json` and `schema/package.json`. The attribution-requiring packages
across the three workspaces are reproduced in `NOTICE`. They are MIT, Apache 2.0,
0BSD, BSD-3-Clause, or ISC licensed.

The third workspace, `schema/` (`@ythril-network/schema`, the schema vocabulary and validator the server imports), is versioned with
each release under the Apache License 2.0 and is published to npm from 6.5.0, by the release workflow's `publish-schema` job through npm trusted publishing with provenance (no npm token is stored). Its runtime dependencies (zod, `@bufbuild/cel` and what it pulls in) are the server's own,
at the same versions, and are named again in `schema/NOTICE`, which a gate holds to the package's production closure.

The package has one **optional peer dependency**, `typescript` (`>=5.4`), used only by its `@ythril-network/schema/from-typescript`
entry, which reads a space's schemas back from TypeScript with the caller's own compiler (Apache License 2.0, Microsoft). It is
neither bundled nor installed by npm and is not in the image, so it is not in the production closure and `schema/NOTICE` carries a
sentence, not a heading, for it; the entry's error names the fix, `npm install typescript@6`. The package's own tests run the entry
on the compiler the repository develops with and, through an aliased development dependency (`typescript-6`), on a 6.x. That
alias declares the same `tsc` bin, so every package script compiles through `scripts/tsc.mjs`, which resolves `typescript` by
name, and a gate refuses a bare `tsc` in a script. Before it runs the compiler, `scripts/tsc.mjs` compares the install with
package-lock.json and stops with one line naming the package and `run npm ci` when an installed version differs from the lock, or
when a package the workspace being built depends on is not installed. The NOTICE walk leaves the peer out only because the package's own lock entry marks it optional, and the publish workflow asks the
published image that `node_modules/typescript` is absent.

**Two packages are dual-licensed with a copyleft arm**, and Ythril elects the permissive arm in both. A dual grant
is a choice the distributor makes, so each election is recorded in its NOTICE entry rather than left to be inferred
— "no copyleft applies" is a conclusion a reader should be able to check rather than take on trust.

| package | offered as | Ythril elects | reaches the user via |
|---|---|---|---|
| `dompurify` | `MPL-2.0 OR Apache-2.0` | Apache 2.0 | a direct client dependency |
| `jszip` | `MIT OR GPL-3.0-or-later` | MIT | **transitively**, through `exceljs`, in the browser bundle |

With those elections, no copyleft restrictions apply to any redistributed npm package.

`jszip` is the reason the check below is not limited to direct dependencies. It was found by the Legal &
Compliance audit lens, not by a gate: it is transitive, so the direct-attribution rule skipped it, and it ships in
the browser bundle all the same.

`testing/standalone/notice-coverage.test.js` asserts that every dependency shipped to a user — the
`dependencies` of both workspaces, which land in the image and in the browser bundle — is attributed in
NOTICE. `devDependencies` are deliberately out of scope: they are build-time only and are not
redistributed, so listing them would make NOTICE less accurate, not more.

### The schema-rule engine and what it ships

Custom schema rules (F-46) are evaluated by `@bufbuild/cel`, a CEL evaluator, pinned to an **exact** version
(`0.6.1`): the engine decides what a stored rule means, and a caret range would let a patch release change the
verdict on a record that was accepted the day before. Its licence obligations are carried by its **children** as
much as by itself, so `a-notice-names-every-package-the-rule-engine-ships.test.js` reads its whole production
closure out of `package-lock.json` (dependencies, optional dependencies and peers, never a hand-written list) and
holds NOTICE to naming each package by its full scoped name:

| package | licence | why it is there |
|---|---|---|
| `@bufbuild/cel` | Apache-2.0 | the evaluator; ships no licence file of its own |
| `@bufbuild/cel-spec` | Apache-2.0 | the language definitions and conformance data (about 6 MB, test data included, in the image); generated from Google's `cel-spec` and `cel-go` |
| `@bufbuild/protobuf` | `Apache-2.0 AND BSD-3-Clause` — **conjunctive**: both apply | the protobuf runtime the syntax trees are read with; a direct server dependency, pinned exactly (`2.16.0`), its licence expression to be rechecked on every bump. The BSD part is Google's (2008) varint code, reproduced in NOTICE in its own wording |
| `@bufbuild/re2` | MIT | the regex engine behind `matches()`: linear, so no rule can stall a write on a backtracking pattern; a port of RE2JS / RE2J (Go's `regexp`) |

Because three of these are Apache-2.0 and ship no licence file, NOTICE carries the **full** text of the Apache License
2.0 (it carried only the appendix's boilerplate before), which covers every Apache-2.0 component it lists.

### The RDF readers and what they ship

The RDF import reads a file a stranger made, so it reads it with two libraries: `n3` for Turtle, TriG and N-Quads (it also reads the
RDF 1.2 triple terms the export writes), and `jsonld-streaming-parser` for JSON-LD, which reads in its streaming profile and so
holds no document whole. Both are direct dependencies of the server (`n3` was a development dependency of the repository until the
import needed it). The JSON-LD library fetches a remote `@context` by default; Ythril gives it a document loader that refuses
every remote context, and a test refuses any other construction of it, so an upload cannot make the server request an address.
`a-notice-names-every-package-the-rdf-parsers-ship.test.js` reads the production closure of both out of `package-lock.json`
and holds NOTICE and this table to naming each package, and every licence in it to be a permissive one:

| package | licence | why it is there |
|---|---|---|
| `n3` | MIT | the Turtle, TriG and N-Quads reader |
| `jsonld-streaming-parser` | MIT | the streaming JSON-LD reader |
| `jsonld-context-parser` | MIT | its context reader; the loader it fetches with is never used |
| `rdf-data-factory` | MIT | the term factory of the JSON-LD reader |
| `relative-to-absolute-iri` | MIT | the address resolver of the context reader |
| `canonicalize` | Apache-2.0 | the JSON canonicalizer for `@json` values |
| `http-link-header` | MIT | the `Link` header reader of the context reader (not used by the import) |
| `@bergos/jsonparse` | MIT | the streaming JSON tokenizer |
| `@rdfjs/types` | MIT | RDF/JS interface types, listed as a runtime dependency |
| `@types/http-link-header`, `@types/readable-stream`, `@types/node` | MIT | type declarations the JSON-LD libraries list as runtime dependencies |
| `readable-stream`, `string_decoder`, `buffer`, `safe-buffer`, `base64-js`, `ieee754`, `abort-controller`, `event-target-shim`, `events`, `process` | MIT, and `ieee754` BSD-3-Clause | the stream and buffer implementations of `n3` and the JSON-LD readers, and their children |
| `undici-types` | MIT | the type declarations of `undici`'s API, pulled in by `@types/node` (not the HTTP client `undici` itself) |

The rows group packages that NOTICE attributes under a heading of their own or in a list; the gate reads one name per heading.

### The SPARQL engine and what it ships

The quad source (`server/src/rdf/quad-source.ts`) answers SPARQL through Comunica, `@comunica/query-sparql-rdfjs`, pinned to an
**exact** version (`5.5.0`): the engine decides what a query answers, and a caret range would let a patch release change it. The engine
ships HTTP packages (`@comunica/actor-http-fetch` among them) because it can query remote sources; Ythril never lets it. Every query is
parsed first and SERVICE, LOAD and every update are refused, the engine runs with a fetch that refuses, and its HTTP bus has no actor,
which `a-sparql-query-never-reaches-the-network.test.js` holds against a local listener.
`a-notice-names-every-package-the-sparql-engine-ships.test.js` reads the engine's production closure out of `package-lock.json` and
holds NOTICE and this table to naming each package, and every licence in it to be one that may ship:

| package | licence |
|---|---|
| `@colors/colors`, `@comunica/actor-abstract-mediatyped`, `@comunica/actor-abstract-parse`, `@comunica/actor-abstract-path`, `@comunica/actor-bindings-aggregator-factory-average`, `@comunica/actor-bindings-aggregator-factory-count`, `@comunica/actor-bindings-aggregator-factory-extensions`, `@comunica/actor-bindings-aggregator-factory-group-concat`, `@comunica/actor-bindings-aggregator-factory-max`, `@comunica/actor-bindings-aggregator-factory-min`, `@comunica/actor-bindings-aggregator-factory-sample` | MIT |
| `@comunica/actor-bindings-aggregator-factory-sum`, `@comunica/actor-bindings-aggregator-factory-wildcard-count`, `@comunica/actor-context-preprocess-convert-shortcuts`, `@comunica/actor-context-preprocess-set-defaults`, `@comunica/actor-context-preprocess-source-to-destination`, `@comunica/actor-expression-evaluator-factory-default`, `@comunica/actor-function-factory-expression-bnode`, `@comunica/actor-function-factory-expression-bound`, `@comunica/actor-function-factory-expression-coalesce`, `@comunica/actor-function-factory-expression-concat`, `@comunica/actor-function-factory-expression-extensions`, `@comunica/actor-function-factory-expression-if` | MIT |
| `@comunica/actor-function-factory-expression-in`, `@comunica/actor-function-factory-expression-logical-and`, `@comunica/actor-function-factory-expression-logical-or`, `@comunica/actor-function-factory-expression-not-in`, `@comunica/actor-function-factory-expression-same-term`, `@comunica/actor-function-factory-term-abs`, `@comunica/actor-function-factory-term-addition`, `@comunica/actor-function-factory-term-ceil`, `@comunica/actor-function-factory-term-contains`, `@comunica/actor-function-factory-term-datatype`, `@comunica/actor-function-factory-term-day`, `@comunica/actor-function-factory-term-division` | MIT |
| `@comunica/actor-function-factory-term-encode-for-uri`, `@comunica/actor-function-factory-term-equality`, `@comunica/actor-function-factory-term-floor`, `@comunica/actor-function-factory-term-greater-than`, `@comunica/actor-function-factory-term-greater-than-equal`, `@comunica/actor-function-factory-term-has-lang`, `@comunica/actor-function-factory-term-has-langdir`, `@comunica/actor-function-factory-term-hours`, `@comunica/actor-function-factory-term-inequality`, `@comunica/actor-function-factory-term-iri`, `@comunica/actor-function-factory-term-is-blank`, `@comunica/actor-function-factory-term-is-iri` | MIT |
| `@comunica/actor-function-factory-term-is-literal`, `@comunica/actor-function-factory-term-is-numeric`, `@comunica/actor-function-factory-term-is-triple`, `@comunica/actor-function-factory-term-lang`, `@comunica/actor-function-factory-term-langdir`, `@comunica/actor-function-factory-term-langmatches`, `@comunica/actor-function-factory-term-lcase`, `@comunica/actor-function-factory-term-lesser-than`, `@comunica/actor-function-factory-term-lesser-than-equal`, `@comunica/actor-function-factory-term-md5`, `@comunica/actor-function-factory-term-minutes`, `@comunica/actor-function-factory-term-month` | MIT |
| `@comunica/actor-function-factory-term-multiplication`, `@comunica/actor-function-factory-term-not`, `@comunica/actor-function-factory-term-now`, `@comunica/actor-function-factory-term-object`, `@comunica/actor-function-factory-term-predicate`, `@comunica/actor-function-factory-term-rand`, `@comunica/actor-function-factory-term-regex`, `@comunica/actor-function-factory-term-replace`, `@comunica/actor-function-factory-term-round`, `@comunica/actor-function-factory-term-seconds`, `@comunica/actor-function-factory-term-sha1`, `@comunica/actor-function-factory-term-sha256` | MIT |
| `@comunica/actor-function-factory-term-sha384`, `@comunica/actor-function-factory-term-sha512`, `@comunica/actor-function-factory-term-str`, `@comunica/actor-function-factory-term-str-after`, `@comunica/actor-function-factory-term-str-before`, `@comunica/actor-function-factory-term-str-dt`, `@comunica/actor-function-factory-term-str-ends`, `@comunica/actor-function-factory-term-str-lang`, `@comunica/actor-function-factory-term-str-langdir`, `@comunica/actor-function-factory-term-str-len`, `@comunica/actor-function-factory-term-str-starts`, `@comunica/actor-function-factory-term-str-uuid` | MIT |
| `@comunica/actor-function-factory-term-sub-str`, `@comunica/actor-function-factory-term-subject`, `@comunica/actor-function-factory-term-subtraction`, `@comunica/actor-function-factory-term-timezone`, `@comunica/actor-function-factory-term-triple`, `@comunica/actor-function-factory-term-tz`, `@comunica/actor-function-factory-term-ucase`, `@comunica/actor-function-factory-term-unary-minus`, `@comunica/actor-function-factory-term-unary-plus`, `@comunica/actor-function-factory-term-uuid`, `@comunica/actor-function-factory-term-xsd-to-boolean`, `@comunica/actor-function-factory-term-xsd-to-date` | MIT |
| `@comunica/actor-function-factory-term-xsd-to-datetime`, `@comunica/actor-function-factory-term-xsd-to-day-time-duration`, `@comunica/actor-function-factory-term-xsd-to-decimal`, `@comunica/actor-function-factory-term-xsd-to-double`, `@comunica/actor-function-factory-term-xsd-to-duration`, `@comunica/actor-function-factory-term-xsd-to-float`, `@comunica/actor-function-factory-term-xsd-to-integer`, `@comunica/actor-function-factory-term-xsd-to-string`, `@comunica/actor-function-factory-term-xsd-to-time`, `@comunica/actor-function-factory-term-xsd-to-year-month-duration`, `@comunica/actor-function-factory-term-year`, `@comunica/actor-hash-bindings-murmur` | MIT |
| `@comunica/actor-hash-quads-murmur`, `@comunica/actor-http-fetch`, `@comunica/actor-http-proxy`, `@comunica/actor-init-query`, `@comunica/actor-optimize-query-operation-annotate-union-order`, `@comunica/actor-optimize-query-operation-assign-sources-exhaustive`, `@comunica/actor-optimize-query-operation-bgp-to-join`, `@comunica/actor-optimize-query-operation-construct-distinct`, `@comunica/actor-optimize-query-operation-describe-to-constructs-subject`, `@comunica/actor-optimize-query-operation-distinct-terms-pushdown`, `@comunica/actor-optimize-query-operation-filter-pushdown`, `@comunica/actor-optimize-query-operation-group-file-sources` | MIT |
| `@comunica/actor-optimize-query-operation-group-sources`, `@comunica/actor-optimize-query-operation-join-bgp`, `@comunica/actor-optimize-query-operation-join-connected`, `@comunica/actor-optimize-query-operation-leftjoin-expression-pushdown`, `@comunica/actor-optimize-query-operation-path-to-patterns`, `@comunica/actor-optimize-query-operation-prune-empty-source-operations`, `@comunica/actor-optimize-query-operation-query-source-identify`, `@comunica/actor-optimize-query-operation-query-source-skolemize`, `@comunica/actor-optimize-query-operation-rewrite-add`, `@comunica/actor-optimize-query-operation-rewrite-copy`, `@comunica/actor-optimize-query-operation-rewrite-move`, `@comunica/actor-optimize-query-operation-set-sources-from-dataset` | MIT |
| `@comunica/actor-optimize-query-operation-sort-limit-pushdown`, `@comunica/actor-query-operation-ask`, `@comunica/actor-query-operation-bgp-join`, `@comunica/actor-query-operation-construct`, `@comunica/actor-query-operation-distinct-identity`, `@comunica/actor-query-operation-extend`, `@comunica/actor-query-operation-filter`, `@comunica/actor-query-operation-from-quad`, `@comunica/actor-query-operation-group`, `@comunica/actor-query-operation-join`, `@comunica/actor-query-operation-leftjoin`, `@comunica/actor-query-operation-minus` | MIT |
| `@comunica/actor-query-operation-nodes`, `@comunica/actor-query-operation-nop`, `@comunica/actor-query-operation-orderby`, `@comunica/actor-query-operation-path-alt`, `@comunica/actor-query-operation-path-inv`, `@comunica/actor-query-operation-path-link`, `@comunica/actor-query-operation-path-nps`, `@comunica/actor-query-operation-path-one-or-more`, `@comunica/actor-query-operation-path-seq`, `@comunica/actor-query-operation-path-zero-or-more`, `@comunica/actor-query-operation-path-zero-or-one`, `@comunica/actor-query-operation-project` | MIT |
| `@comunica/actor-query-operation-reduced-hash`, `@comunica/actor-query-operation-slice`, `@comunica/actor-query-operation-source`, `@comunica/actor-query-operation-union`, `@comunica/actor-query-operation-union-ordered`, `@comunica/actor-query-operation-update-clear`, `@comunica/actor-query-operation-update-compositeupdate`, `@comunica/actor-query-operation-update-create`, `@comunica/actor-query-operation-update-deleteinsert`, `@comunica/actor-query-operation-update-drop`, `@comunica/actor-query-operation-update-load`, `@comunica/actor-query-operation-values` | MIT |
| `@comunica/actor-query-parse-graphql`, `@comunica/actor-query-parse-sparql`, `@comunica/actor-query-process-explain-logical`, `@comunica/actor-query-process-explain-parsed`, `@comunica/actor-query-process-explain-physical`, `@comunica/actor-query-process-explain-query`, `@comunica/actor-query-process-sequential`, `@comunica/actor-query-result-serialize-json`, `@comunica/actor-query-result-serialize-rdf`, `@comunica/actor-query-result-serialize-simple`, `@comunica/actor-query-result-serialize-sparql-csv`, `@comunica/actor-query-result-serialize-sparql-json` | MIT |
| `@comunica/actor-query-result-serialize-sparql-tsv`, `@comunica/actor-query-result-serialize-sparql-xml`, `@comunica/actor-query-result-serialize-stats`, `@comunica/actor-query-result-serialize-table`, `@comunica/actor-query-result-serialize-tree`, `@comunica/actor-query-serialize-sparql`, `@comunica/actor-query-source-identify-hypermedia`, `@comunica/actor-query-source-identify-hypermedia-sparql`, `@comunica/actor-query-source-identify-rdfjs`, `@comunica/actor-query-source-identify-service-executor`, `@comunica/actor-rdf-join-entries-sort-cardinality`, `@comunica/actor-rdf-join-entries-sort-selectivity` | MIT |
| `@comunica/actor-rdf-join-inner-hash`, `@comunica/actor-rdf-join-inner-merge`, `@comunica/actor-rdf-join-inner-multi-bind`, `@comunica/actor-rdf-join-inner-multi-bind-source`, `@comunica/actor-rdf-join-inner-multi-empty`, `@comunica/actor-rdf-join-inner-multi-index-nested-loop`, `@comunica/actor-rdf-join-inner-multi-merge`, `@comunica/actor-rdf-join-inner-multi-smallest`, `@comunica/actor-rdf-join-inner-multi-smallest-filter-bindings`, `@comunica/actor-rdf-join-inner-nestedloop`, `@comunica/actor-rdf-join-inner-none`, `@comunica/actor-rdf-join-inner-single` | MIT |
| `@comunica/actor-rdf-join-inner-symmetrichash`, `@comunica/actor-rdf-join-minus-hash`, `@comunica/actor-rdf-join-optional-bind`, `@comunica/actor-rdf-join-optional-hash`, `@comunica/actor-rdf-join-optional-index-nested-loop`, `@comunica/actor-rdf-join-optional-nestedloop`, `@comunica/actor-rdf-join-selectivity-variable-counting`, `@comunica/actor-rdf-metadata-accumulate-cardinality`, `@comunica/actor-rdf-metadata-accumulate-pagesize`, `@comunica/actor-rdf-metadata-accumulate-requesttime`, `@comunica/actor-rdf-parse-html`, `@comunica/actor-rdf-parse-html-microdata` | MIT |
| `@comunica/actor-rdf-parse-html-rdfa`, `@comunica/actor-rdf-parse-html-script`, `@comunica/actor-rdf-parse-jsonld`, `@comunica/actor-rdf-parse-n3`, `@comunica/actor-rdf-parse-rdfxml`, `@comunica/actor-rdf-parse-shaclc`, `@comunica/actor-rdf-parse-xml-rdfa`, `@comunica/actor-rdf-serialize-jsonld`, `@comunica/actor-rdf-serialize-n3`, `@comunica/actor-rdf-serialize-shaclc`, `@comunica/actor-rdf-update-quads-rdfjs-store`, `@comunica/actor-term-comparator-factory-expression-evaluator` | MIT |
| `@comunica/actor-warmup-queries-sampled`, `@comunica/bus-bindings-aggregator-factory`, `@comunica/bus-context-preprocess`, `@comunica/bus-expression-evaluator-factory`, `@comunica/bus-function-factory`, `@comunica/bus-hash-bindings`, `@comunica/bus-hash-quads`, `@comunica/bus-http`, `@comunica/bus-http-invalidate`, `@comunica/bus-init`, `@comunica/bus-merge-bindings-context`, `@comunica/bus-optimize-query-operation` | MIT |
| `@comunica/bus-query-operation`, `@comunica/bus-query-parse`, `@comunica/bus-query-process`, `@comunica/bus-query-result-serialize`, `@comunica/bus-query-serialize`, `@comunica/bus-query-source-dereference-link`, `@comunica/bus-query-source-identify`, `@comunica/bus-query-source-identify-hypermedia`, `@comunica/bus-rdf-join`, `@comunica/bus-rdf-join-entries-sort`, `@comunica/bus-rdf-join-selectivity`, `@comunica/bus-rdf-metadata-accumulate` | MIT |
| `@comunica/bus-rdf-parse`, `@comunica/bus-rdf-parse-html`, `@comunica/bus-rdf-resolve-hypermedia-links`, `@comunica/bus-rdf-resolve-hypermedia-links-queue`, `@comunica/bus-rdf-serialize`, `@comunica/bus-rdf-update-quads`, `@comunica/bus-term-comparator-factory`, `@comunica/bus-warmup`, `@comunica/config-query-sparql`, `@comunica/context-entries`, `@comunica/core`, `@comunica/logger-pretty` | MIT |
| `@comunica/logger-void`, `@comunica/mediator-all`, `@comunica/mediator-combine-pipeline`, `@comunica/mediator-combine-union`, `@comunica/mediator-join-coefficients-fixed`, `@comunica/mediator-number`, `@comunica/mediator-race`, `@comunica/mediatortype-accuracy`, `@comunica/mediatortype-join-coefficients`, `@comunica/mediatortype-time`, `@comunica/query-sparql-rdfjs`, `@comunica/runner` | MIT |
| `@comunica/types`, `@comunica/utils-algebra`, `@comunica/utils-bindings-factory`, `@comunica/utils-bindings-index`, `@comunica/utils-data-factory`, `@comunica/utils-expression-evaluator`, `@comunica/utils-iterator`, `@comunica/utils-metadata`, `@comunica/utils-query-operation`, `@dabh/diagnostics`, `@jeswr/prefixcc`, `@jeswr/stream-to-string` | MIT |
| `@so-ric/colorspace`, `@traqula/algebra-sparql-1-1`, `@traqula/algebra-sparql-1-2`, `@traqula/algebra-transformations-1-1`, `@traqula/algebra-transformations-1-2`, `@traqula/core`, `@traqula/generator-sparql-1-1`, `@traqula/generator-sparql-1-2`, `@traqula/parser-sparql-1-1`, `@traqula/parser-sparql-1-2`, `@traqula/rules-sparql-1-1`, `@traqula/rules-sparql-1-2` | MIT |
| `@types/http-cache-semantics`, `@types/imurmurhash`, `@types/minimist`, `@types/n3`, `@types/semver`, `@types/spark-md5`, `@types/triple-beam`, `@types/yargs`, `@types/yargs-parser`, `ansi-regex`, `ansi-regex`, `ansi-styles` | MIT |
| `arrayify-stream`, `async`, `asynciterator`, `asyncjoin`, `bignumber.js`, `color`, `color-convert`, `color-convert`, `color-name`, `color-name`, `color-name`, `color-string` | MIT |
| `componentsjs`, `cross-fetch`, `dom-serializer`, `emoji-regex`, `emoji-regex`, `enabled`, `escalade`, `event-emitter-promisify`, `fast-deep-equal`, `fecha`, `fetch-sparql-endpoint`, `fn.name` | MIT |
| `graphql`, `graphql-to-sparql`, `hash.js`, `htmlparser2`, `imurmurhash`, `is-fullwidth-code-point`, `is-fullwidth-code-point`, `is-stream`, `jsonld-streaming-serializer`, `kuler`, `logform`, `microdata-rdf-streaming-parser` | MIT |
| `minimist`, `ms`, `node-fetch`, `object-inspect`, `one-time`, `promise-polyfill`, `rdf-isomorphic`, `rdf-literal`, `rdf-literal`, `rdf-object`, `rdf-parse`, `rdf-quad` | MIT |
| `rdf-string`, `rdf-string-ttl`, `rdf-terms`, `rdfa-streaming-parser`, `rdfxml-streaming-parser`, `readable-from-web`, `readable-stream-node-to-web`, `require-directory`, `safe-stable-stringify`, `shaclc-parse`, `shaclc-write`, `sparqljson-parse` | MIT |
| `sparqljson-parse`, `sparqljson-to-tree`, `sparqlxml-parse`, `stack-trace`, `stream-to-string`, `streamify-array`, `string-width`, `string-width`, `strip-ansi`, `strip-ansi`, `text-hex`, `tiny-set-immediate` | MIT |
| `tr46`, `triple-beam`, `util-deprecate`, `validate-iri`, `whatwg-url`, `winston`, `winston-transport`, `wrap-ansi`, `wrap-ansi`, `xmlchars`, `yargs`, `yargs` | MIT |
| `@rubensworks/saxes`, `cliui`, `cliui`, `get-caller-file`, `inherits`, `minimalistic-assert`, `semver`, `y18n`, `yargs-parser`, `yargs-parser` | ISC |
| `lru-cache`, `lru-cache`, `lru-cache`, `lru-cache`, `lru-cache`, `lru-cache`, `lru-cache` | BlueOak-1.0.0 |
| `domelementtype`, `domhandler`, `domutils`, `entities`, `entities`, `http-cache-semantics`, `webidl-conversions` | BSD-2-Clause |
| `spark-md5` | WTFPL OR MIT |
| `negotiate` | FreeBSD |
| `@traqula/chevrotain` | Apache-2.0 |

The closure holds two licence forms the other closures do not: `negotiate` names its licence in a `licenses` array (`FreeBSD`, the
two-clause BSD text), which the lock does not record, so the gate reads the installed `package.json`; and one package offers a choice
with no copyleft arm, so Ythril records its election:

| package | offered as | Ythril elects |
|---|---|---|
| `spark-md5` | `WTFPL OR MIT` | MIT |

---

## Vendored client assets

Some things the browser downloads are **not npm dependencies**, so the coverage test above cannot see them. They
are checked in as files and shipped by the bundler, and they carry licences of their own.

| asset | where | licence | provenance |
|---|---|---|---|
| **Inter**, four latin weights (300/400/500/600), WOFF2 | `client/src/assets/fonts/` | SIL Open Font License 1.1 | copied unmodified from the `@fontsource/inter` **5.3.0** distribution |

**To refresh them:** `npm i -D @fontsource/inter@<version>`, copy
`node_modules/@fontsource/inter/files/inter-latin-{300,400,500,600}-normal.woff2` into
`client/src/assets/fonts/`, remove the dependency again, and update the version in the table above and in
`NOTICE`. The package is not kept as a dependency because nothing imports it — the four files are the
whole of what ships, and an unused dependency in the manifest is a worse record than this paragraph.

**They are served by the instance, deliberately.** The UI previously fetched its font from a public font CDN on
every page load, which sent every operator's IP to a third party from a self-hosted admin UI and failed outright on
an air-gapped install. `testing/standalone/no-external-assets.test.js` now asserts that the client requests no
asset from a remote host, and that anything vendored under `client/src/assets/` is attributed in NOTICE.

---

## mongodb/mongodb-atlas-local (Docker image)

### What it is and why it is used

Ythril's `docker-compose.yml` references the official `mongodb/mongodb-atlas-local`
image published by MongoDB, Inc. on Docker Hub. It is used as the database backend.

The image bundles two processes:

| Process | Role | License |
|---------|------|---------|
| `mongod` | MongoDB Community Edition server | Server Side Public License v1 (SSPL) |
| `mongot` | Search and vector-index sidecar | Proprietary (MongoDB, Inc.) |

`mongot` is the reason this specific image is used instead of plain Community Edition.
Ythril issues `$vectorSearch` aggregation queries against MongoDB to power semantic
recall (`query` and `recall` MCP tools; calling `recall` with its `space` parameter
omitted searches across every space the token can access). That stage requires `mongot`
to be running and connected to `mongod`. There is currently no fully open-source
drop-in replacement that provides equivalent vector search on top of MongoDB.

### How it is deployed

The image runs as a **separate container** (`ythril-mongo`) on a private, **internal** Docker
bridge network (`ythril-db`). Ythril connects to it over TCP at `mongodb://ythril-mongo:27017`.

> **Security — the database network is deliberately isolated.** MongoDB runs without
> authentication, so Ythril's security model (PATs, admin gating, space scoping, read-only
> tokens, the audit log) is enforced at the **API layer only** — anything that can open a TCP
> connection to port 27017 can read and rewrite every space, invisibly to the audit log.
>
> The media sidecars (`ollama`, `whisper`) exist to parse **untrusted user-supplied media**
> and are the highest-risk attack surface in the deployment, so they live on a *separate*
> network (`ythril-media`) and **cannot reach the database at all**. Only the `ythril`
> container bridges the two. `ythril-db` is marked `internal: true`, so the database also has
> no outbound internet access. This mirrors what the Kubernetes deployment enforces via
> `NetworkPolicy` (`kubernetes/manifests/media-netpol.yaml`).
>
> If you add a service that needs the database, put it on `ythril-db` deliberately — and
> understand that you are granting it unauthenticated access to the entire brain.

### Authenticating the bundled database

**New installs: just set credentials.** Copy `.env.example` to `.env` and set:

```bash
MONGO_USERNAME=ythril
MONGO_PASSWORD=$(openssl rand -base64 24)
```

Compose passes them to the database as the root user and to Ythril, which builds an
authenticated connection URI. Nothing else is required.

**Existing installs: leave them empty, and migrate deliberately.**

MongoDB **cannot have authentication switched on in place**. The Atlas Local image runs a
single-node replica set (required for `$vectorSearch`), and auth on a replica set needs an
internal keyfile that the image only provisions on a **first** init. Adding credentials to a
database that already holds data does **not** enable auth — mongod fails to start with
`Unable to acquire security key[s]`, and hand-placing a keyfile breaks the replica set
(`node is not in primary or recovering state`).

So migrating means recreating the database and restoring into it. **Back up first.**

```bash
# 1. Dump the application database ONLY. Never dump/restore `admin` — it holds the auth
#    users, and restoring it over a fresh instance clobbers the account you just created.
docker exec ythril-mongo mongodump --db=ythril --out=/tmp/dump
docker cp ythril-mongo:/tmp/dump ./mongo-dump

# 2. Also copy the data directory itself, so the old state is recoverable.
cp -r local-data/mongo local-data/mongo.backup

# 3. Set MONGO_USERNAME / MONGO_PASSWORD in .env, then recreate the database from empty
#    (this is the only path on which the image can enable auth).
docker compose down
#    The volume names start with the compose project name (`ythril` when the folder is named so; `docker volume ls` lists them).
docker volume rm ythril_ythril-mongo-data ythril_ythril-mongo-configdb   # or clear the bind mount
docker compose up -d ythril-mongo

# 4. Restore, authenticating with the new credentials.
docker cp ./mongo-dump ythril-mongo:/tmp/dump
docker exec ythril-mongo mongorestore \
  -u "$MONGO_USERNAME" -p "$MONGO_PASSWORD" --authenticationDatabase admin \
  --db=ythril /tmp/dump/ythril

# 5. Start Ythril. It rebuilds the $vectorSearch indexes on boot.
docker compose up -d
```

Verify before deleting the backup: the entry counts in **Settings → Spaces** should match
what you had, and semantic recall should return results once the vector indexes finish
building.

**Already using managed Atlas or your own cluster?** Nothing to do — set `MONGO_URI` and it
wins over everything above; those deployments are already authenticated.

```text
[ythril container] --TCP:27017--> [ythril-mongo container]
                                   ├── mongod (SSPL)
                                   └── mongot (proprietary)
```

The `ythril-mongo` container has **no published ports** — it is not reachable from
the host or any external network. Only the `ythril` container can reach it, via
the internal bridge.

### Ythril does not distribute this image

Ythril's repository contains no MongoDB binaries, no `mongot` binary, and no
MongoDB source code. The `docker-compose.yml` file contains only a reference to
the image name on Docker Hub. Docker pulls the image separately when a user runs
`docker compose up`. Ythril is not the distributor.

### Ythril License compliance

**No conflict.** Here is why:

1. **No combined work.** Ythril communicates with `mongod`/`mongot` solely over a
   TCP socket. GPL-family copyleft extends to works that are statically linked or
   form a combined work in the same process. A database server accessed over a
   network socket is not a combined work with the client. This is the same legal
   relationship as any application using PostgreSQL, Redis, or any other
   server-based database.

2. **SSPL "Service Provision" clause does not apply.** SSPL's aggressive clause
   requires that if you make the covered software itself available as a service
   (i.e., you are offering MongoDB-as-a-service), you must open-source your entire
   service infrastructure. Ythril uses MongoDB as an internal component of a
   different application. It does not offer MongoDB as a service to anyone.

3. **mongot is external and not incorporated.** `mongot` is proprietary, but it
   runs as a separate process inside a separate container that Ythril never ships.
   No proprietary binary is incorporated into Ythril's source or distribution.

**Summary:** Ythril's Ythril License source obligations apply only to Ythril's own code.
They do not extend to `mongod`, `mongot`, or the `mongodb/mongodb-atlas-local` image.

### Honest disclosure

The semantic recall feature has a runtime dependency on a proprietary binary
(`mongot`). A deployment of Ythril with full functionality is therefore not a
fully open-source stack. This is an accepted constraint, documented here and in
`NOTICE`. It does not affect compliance, but it is worth knowing if
you are evaluating Ythril for an environment where fully open-source runtime
stacks are required.

A future Ythril version may introduce an alternative vector-search backend
(e.g., plain MongoDB CE + mongot CE Preview, or a different vector store) to
address this for users who need it.

---

## MongoDB 8.2+ (Community / Enterprise)

MongoDB 8.2+ ships native `$vectorSearch` support without requiring the `mongot`
sidecar. Ythril detects this at startup and uses it automatically.

| MongoDB flavour | `$vectorSearch` | License | `mongot` needed |
|---|---|---|---|
| `mongodb/mongodb-atlas-local` (default) | ✓ | SSPL + proprietary (`mongot`) | Bundled |
| Managed MongoDB Atlas (M10+) | ✓ | Managed service (ToS) | Managed |
| MongoDB 8.2+ Community Edition | ✓ | SSPL | No |
| MongoDB 8.2+ Enterprise | ✓ | Commercial | No |
| MongoDB < 8.2 (vanilla) | ✗ | SSPL | N/A |

When using MongoDB 8.2+ CE, the SSPL analysis above still applies — Ythril uses
MongoDB as an internal component over a TCP socket, not as a service offering.
The key difference is that **no proprietary `mongot` binary is involved**, making
this the only fully SSPL-only (no proprietary) deployment option with full
`$vectorSearch` support.

See [integration-guide.md](integration-guide/02-hosting.md#mongodb-flexibility) for
connection configuration.

---

## Media & document runtime images (Docker / Kubernetes sidecars)

Ythril's media-embedding and document-conversion pipelines run as **separate
container images**, pulled independently at deployment time exactly like the
MongoDB image above. None of them are bundled into or distributed by Ythril, and
none are linked into the application — Ythril talks to each over HTTP on a private
network. They are documented here because runtime infrastructure must be listed with its licensing impact.

| Image | Role | License |
|---|---|---|
| `ollama/ollama` | Vision model host — captions uploaded images (default `moondream`) for the media pipeline. | MIT (the Ollama runtime). Models are pulled separately; the default `moondream` is Apache 2.0. |
| `fedirz/faster-whisper-server` | Speech-to-text — transcribes uploaded/segmented audio via an OpenAI-compatible endpoint. | MIT (the server). Whisper models are pulled separately and are Apache 2.0. |
| `unstructured-io/unstructured-api` | Server-side PDF / DOCX / EPUB conversion (`hi_res` OCR + layout detection, table and embedded-image extraction). | Apache 2.0. |
| `ythril-doc-render` (first-party, built from `sidecars/doc-render`) | Renders PDF pages to PNG images for the F11 VLM document-extraction path (`documentProcessing.mode` `vlm`/`auto`/`max`). | Apache-2.0. Wraps **PDFium** via `pypdfium2` (Apache-2.0 / BSD-3-Clause) + Pillow (HPND) — all permissive. Deliberately **not** PyMuPDF (AGPL-3.0). See `sidecars/doc-render/LICENSES.md`. |
| `ythril-doc-office` (first-party, built from `sidecars/doc-office`) — **optional** | Renders **office** docs (DOCX/EPUB/…) to PNG images for the same VLM path: LibreOffice converts to PDF, then PDFium rasterizes. Opt-in via the compose `office` profile. | LibreOffice is **MPL-2.0 / LGPL-3.0** (not AGPL), invoked as a **separate process** (not linked); PDFium/Pillow permissive. See `sidecars/doc-office/LICENSES.md`. |
| `ythril-doc-nlp` (first-party, built from `sidecars/doc-nlp`) | Finds the candidate mentions the conversation extractor (`F-31`) builds entities from: spaCy's `en_core_web_trf` named entities and noun phrases. Bundled; `DOC_NLP_REPLICAS=0` leaves it out. | MIT (spaCy, the model, RoBERTa-base, spacy-transformers), Apache-2.0 (Transformers), BSD-3-Clause (PyTorch CPU). See `sidecars/doc-nlp/LICENSES.md`. |

**Where they are referenced.** `ollama`, `whisper`, `unstructured`, and `doc-render` are all services in
`docker-compose.yml`. `ollama`/`whisper` also have matching Kubernetes manifests
(`kubernetes/manifests/{ollama,whisper}-deploy.yaml`); the `unstructured-api` sidecar is
in `kubernetes/manifests/ythril-deployment.yaml`, pod-local. `ollama`/`whisper` form the
media-embedding stack; `unstructured` is the bundled document-conversion sidecar, and `doc-render`
is the first-party page-render sidecar built locally from `sidecars/doc-render` (not pulled).

> **Why not `unstructured-api-full`?** The `-full` variant (extra Tesseract language packs +
> LibreOffice) was made private on quay.io and now returns `401 UNAUTHORIZED` on an anonymous
> pull. The public `unstructured-api` image is built from the same release, supports the exact
> `hi_res` OCR + embedded-image extraction path Ythril calls, and is what upstream's own README
> points self-hosters at. Ythril's PDF/DOCX/EPUB + English-OCR path needs nothing the `-full`
> extras add.
>
> **Image size — `unstructured-api` is very heavy: **≈10.8 GB to download** (26 compressed layers, measured from the registry manifest) and **20–32 GB on disk** depending on the storage driver — measured at 20.7 GB on k3s/containerd and 31.9 GB on Docker Desktop.** It bundles OCR model
> weights (Tesseract), so the first `docker compose up` pulls a large image and the sidecar
> is slow to become ready (a long `start_period`). It is intentionally **not** a startup
> dependency of the `ythril` service — Ythril runs without it and PDF/DOCX/EPUB conversion
> simply reports `sidecar_down` until the sidecar is up. To keep it out of a deployment
> altogether — a resource-constrained workstation, or an instance that uses an external
> converter via `CONVERSION_SIDECAR_URL` — set **`UNSTRUCTURED_REPLICAS=0`** in `.env`; a machine
> that never starts it never pays for its image pull either. In-process text/HTML conversion and
> every other feature keep working. It runs on an isolated, internal `ythril-convert` network with
> no database access and no internet egress.

**`doc-office` (office → page images for the VLM path) is opt-in and heavy.** Rasterizing office
documents (DOCX/EPUB/…) needs LibreOffice to convert them to PDF first; LibreOffice adds ≈ +1 GB to the
otherwise-tiny render image, so — like `unstructured-api` — it is **not** started by default. Enable it
with `docker compose --profile office up -d`. Without it, office docs in a `vlm`/`auto`/`max` extraction
mode transparently fall back to OCR (unchanged from before). Everything happens **on-box** on the isolated
`ythril-convert` network — no page images or text leave the instance. Licensing: LibreOffice is MPL-2.0 /
LGPL-3.0 (not AGPL) and runs as a separate process (not linked), so it carries no copyleft into Ythril.

**`doc-nlp` (candidate mentions for the conversation extractor) is bundled like the other models, and heavy.**
It runs spaCy's transformer pipeline on CPU PyTorch, so the image is ≈ 3 GB and the model ≈ 0.5 GB in
memory. Ythril reaches it via `NLP_SIDECAR_URL` (default `http://doc-nlp:8102`). A machine that never
extracts conversations can leave it out with `DOC_NLP_REPLICAS=0`; extraction is then refused with that
setting named rather than run with nothing to judge. It proposes spans only — every judgement about them is the decision model's — and
it was chosen by measurement: on the ten committed LoCoMo extractions it proposes 96% of the entities whose
name the conversation says (on conversations nothing was tuned against), against 92% for spaCy's large
statistical model, 87% for wink-nlp and 88% for hand-written rules, at about 30 ms a turn including the
HTTP hop. The model is installed at build time, so the container never downloads anything, and it runs on
the isolated `ythril-convert` network. Its own caps: `NLP_MAX_TEXTS` (256 texts a request) and
`NLP_MAX_CHARS` (200 000 characters a request); `NLP_MODEL` names the spaCy pipeline to load.

### Sandboxing and resource ceilings

The application's own container is confined too, in Compose as in Kubernetes: no privilege escalation, all
capabilities dropped, a read-only root filesystem with two in-memory scratch mounts (`/tmp` and its home folder),
and memory and process ceilings (`YTHRIL_MEM_LIMIT`, `YTHRIL_PIDS_LIMIT`). It has no default CPU ceiling in
Compose, because Docker refuses one above the host's core count.

Every one of these sidecars exists to parse **untrusted user-supplied input** — uploaded images, audio,
PDFs — which makes them the highest-risk processes in the deployment. They are therefore confined the
same way in Compose and in Kubernetes:

| Control | Compose | Kubernetes |
|---|---|---|
| No privilege escalation | `security_opt: [no-new-privileges:true]` | `allowPrivilegeEscalation: false` |
| All Linux capabilities dropped | `cap_drop: [ALL]` | `capabilities.drop: [ALL]` |
| Read-only root filesystem | `read_only: true` + a `/tmp` tmpfs | `readOnlyRootFilesystem: true` + an `emptyDir` |
| Memory / CPU ceiling | `mem_limit` / `cpus` | `resources.limits.memory` / `.cpu` |
| Process (thread) ceiling | `pids_limit` | pod-level (`podPidsLimit` on the kubelet) |
| Network isolation | separate bridge networks (`ythril-media`, internal `ythril-convert`) | `media-netpol.yaml` egress rules |

Writes are confined to the named volume each service already owns (`/root/.ollama`, `/root/.cache`) plus
a per-container tmpfs at `/tmp`; nothing else on the root filesystem is writable.

Two of them need help to keep writing only inside the tmpfs. `unstructured` gets `NUMBA_CACHE_DIR` and
`MPLCONFIGDIR` pointed at `/tmp` (numba otherwise caches a compiled function *next to* the installed
package and fails on the read-only mount), and it also runs with `HF_HUB_OFFLINE=1` — not a hardening
flag but a **fix**: its layout and table models are baked into the image, yet `huggingface_hub` calls the
hub to resolve them before reading its own cache, which cannot work on the internal, no-internet
`ythril-convert` network. Do **not** set `HOME` or `XDG_CACHE_HOME` on that service — they are what locate
the baked model cache.

**One documented exception:** `whisper` runs *without* `read_only`. The `faster-whisper-server` image
starts through `uv run`, which rewrites its own virtualenv on every launch, so a read-only root filesystem
crash-loops it (`Read-only file system (os error 30)`); the same image also cannot run as a non-root user,
because that virtualenv lives under a root-owned path. Every other control above still applies to it. The
Kubernetes manifest carries the same exception for the same reason.

**The ceilings are sized from measurement, not guesswork** — on a 16-core host, a moondream vision
caption peaked at ~2.4 GB RSS / ~8 cores / 43 threads, and a short clip through faster-whisper `small`
at ~1.4 GB / ~4 cores / 42 threads. The defaults sit roughly 3× above that. Note that `pids_limit`
counts **threads**, and inference libraries spawn one per core, so the process ceiling is deliberately
far above the observed peak: it is there to stop a fork bomb, not to size inference.

**Each of the three is also individually switchable**, so an infra-managed deployment can decide which
sidecars it runs without forking the compose file. Setting a switch to `0` stops and removes the
container on the next `docker compose up`, and a machine that never starts it never pulls its image:

```bash
UNSTRUCTURED_REPLICAS=0   # no server-side PDF/DOCX/EPUB conversion (or an external one via CONVERSION_SIDECAR_URL)
OLLAMA_REPLICAS=0         # no image captioning
DOC_NLP_REPLICAS=0        # no conversation extraction (its candidate mentions)
WHISPER_REPLICAS=0        # no audio transcription
```

If you run a larger model (a 13B vision model, a `large-v3` transcription model) or OCR very large
scans, raise the relevant ceiling in `.env` rather than editing `docker-compose.yml`:

```bash
YTHRIL_MEM_LIMIT=8g        # default 4g  — the app itself, and its embedding process (one ceiling for both)
YTHRIL_PIDS_LIMIT=2048     # default 1024 — the app's ceiling on processes and threads
YTHRIL_MONGO_MEM_LIMIT=8g  # default 4g  — MongoDB and vector search; the database cache is sized from it
YTHRIL_MONGOT_HEAP_PERCENT=25  # default 25 — the vector search heap, as a share of YTHRIL_MONGO_MEM_LIMIT (sensible range 1-90)
OLLAMA_MEM_LIMIT=16g       # default 8g  / OLLAMA_PIDS_LIMIT 2048       / OLLAMA_CPUS 8.0
WHISPER_MEM_LIMIT=8g       # default 4g  / WHISPER_PIDS_LIMIT 1024      / WHISPER_CPUS 4.0
UNSTRUCTURED_MEM_LIMIT=8g  # default 6g  / UNSTRUCTURED_PIDS_LIMIT 1024 / UNSTRUCTURED_CPUS 4.0
DOC_RENDER_MEM_LIMIT=2g    # default 1g  / DOC_RENDER_PIDS_LIMIT 128    / DOC_RENDER_CPUS 1.0
DOC_OFFICE_MEM_LIMIT=4g    # default 2g  / DOC_OFFICE_PIDS_LIMIT 512    / DOC_OFFICE_CPUS 2.0
DOC_NLP_MEM_LIMIT=4g       # default 3g  / DOC_NLP_PIDS_LIMIT 256       / DOC_NLP_CPUS 2.0
```

`YTHRIL_MONGO_MEM_LIMIT` is the one to raise as spaces grow: a space of tens of thousands of records needs more database
memory than a small limit gives, and the `4g` default has not been measured at that size. The search process's heap is a
share of the same limit (`YTHRIL_MONGOT_HEAP_PERCENT`), so it rises with it; an index's vectors live outside that heap, so
it is the limit, not the share, that has to grow with records times vector width. When the search process runs out of heap
the whole database container stops, and the cause is in `mongot.log` on the `ythril-mongo-logs` volume
([hosting guide, Database memory](integration-guide/02-hosting.md)).

The last two are the document sidecars: `doc-render` turns PDF pages into images, and `doc-office`
(the `office` profile) converts Word and similar through LibreOffice. Their ceilings used to be fixed in
`docker-compose.yml`, so raising them meant editing that file -- dense or very large documents are exactly
the case where you would need to.

`YTHRIL_MEM_LIMIT` is one ceiling for **two processes**: the bundled embedding model does not run inside the server,
it runs in a child process of the same container (started on the first embed, ended after ten idle minutes, which is
what returns the model's memory to the operating system). If you run a larger embedding model, size this for the model
as well as the server.

A job that exceeds its memory ceiling is OOM-killed by the kernel: the affected caption/transcription/
extraction fails and is reported as such, the rest of the stack keeps running. To confirm that is what
happened, check the container rather than guessing:

```bash
docker inspect ythril-ollama --format '{{.State.OOMKilled}}'   # true → raise OLLAMA_MEM_LIMIT
```

> **Upgrading an existing deployment:** these ceilings did not exist before, so if you already run a model
> heavier than the defaults (a 13B vision model, `large-v3` transcription), set the matching `*_MEM_LIMIT`
> in `.env` **before** you `docker compose up -d` — otherwise the first job after the upgrade is OOM-killed.

**Licensing impact — none on Ythril's Ythril License obligations.** All three are permissively
licensed (MIT / Apache 2.0), carry no copyleft, and run as independent network services
rather than linked code — the same TCP-socket relationship analysed for MongoDB above.
`unstructured-api` in particular ships under Apache 2.0, but because its tag can change,
verify the image's bundled `LICENSE` on every version bump (the procedure is documented in
the header of `kubernetes/manifests/ythril-deployment.yaml`).
