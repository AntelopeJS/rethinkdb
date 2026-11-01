# Coverage table

The documented behaviour of this module, one row each, with the journey and check that fails when it breaks. A verifier checks the layer against this fixed list, and a change to the docs adds or edits its rows in the same pull request. Rows 1 to 135 keep their numbers from the first table; rows 136 and later were added after a further pass over every page below.

Doc keys: R = rethinkdb README.md, X = rethinkdb docs/external-mode.md, I = interface-database docs (`docs/<path>`), W = interface-database `WriteValue` TSDoc, Q = interface-rethinkdb README and docs, C = interface-database-catalog docs and TSDoc. Each row names the journey and the check (by its label) that fails when the behaviour breaks. "Not asserted" rows say why.

### Module, config, connection (R)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 1 | `pool` options connect through a pool | R Configuration | module/connection-modes, smoke/insert-values |
| 2 | `connection` alone connects | R | module/connection-modes |
| 3 | `url` parsed into pool options; `pool` options are merged under what the url gives, so the url's host and port win | R, X | module/connection-modes ("url only"); module/external-options: "the url's server wins over the pool's host and port" |
| 4 | `pool` wins when both are set | R | module/connection-modes ("pool beside a dead connection") |
| 5 | refuses to start without `url`, `pool`, `connection` | R | module/config-refused |
| 6 | external without url / database, `pool.db` disagreeing, unknown mode, non-rethinkdb url, and a `statementTimeoutMs` that is not a positive safe integer (zero, 1.5, -5) | R, X, `config.ts` TSDoc | module/config-refused: "the refusal says why (...)" for each, including "a fractional statementTimeoutMs" and "a negative statementTimeoutMs" |
| 7 | installed as `local`, loads every implemented interface, Ctrl+C exits 130, the port refuses afterwards | R Install | smoke/module-dev: the repository's guarded copy of the pack journey ("the consumer loaded every implemented interface", interrupted, port refused) |
| 8 | default config is a pool to 127.0.0.1:28015 as admin | R Install | not asserted: the journeys point at the run's own container on a free port, never at 28015 |

### Storage layout (R)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 9 | each schema is a database, each table a table | R | schemas/storage-layout: "the schema is one database", "each declared table is a table" |
| 10 | every table has a `tenant_id` index | R | schemas/storage-layout: "a table without indexes holds tenant_id only" |
| 11 | each declared index `<name>` becomes `<name>__i` led by the instance (simple, compound, multi) | R | schemas/storage-layout: "users holds tenant_id, a <name>__i index per declared index..."; cross-instance-indexes: scoped reads (a compound key not led by the instance leaks rows) |
| 12 | `crossInstance: true` also creates the unprefixed `<name>` | R | schemas/storage-layout (`role`) |
| 13 | without `crossInstance`, CROSS_INSTANCE queries scan and log a one-time warning | R | schemas/cross-instance-indexes: "a CROSS_INSTANCE read on '<index>', without crossInstance, warns once" (cat, cat_price, tags) |
| 14 | a flagged index never warns | I 5.indexes.md | schemas/cross-instance-indexes: "... with crossInstance, never warns" |
| 15 | index names ending in `__i` are reserved | R | schemas/refused-indexes: "an index name ending in __i: the refusal is said ...", "no query ... answers"; no database created |
| 16 | `_id` primary key shared by all instances; a taken `_id` throws `DuplicateKeyError` on `_id` | R, I 4.crud.md | schemas/instances: "an _id used by another instance is a DuplicateKeyError on _id"; writes/insert-conflicts |
| 17 | `unique: true` refused, naming schema, table, index | R | schemas/refused-indexes: "a unique secondary index: the refusal is said ..." |
| 18 | initialization creates missing databases, tables, indexes | R | schemas/storage-layout (all index and table checks) |
| 19 | existing tables and rows are kept; the module never drops an index | R | schemas/storage-layout: "the instance serves the row its table already held", "... its own legacy index, never dropped" |
| 20 | waits for the indexes before the schema accepts queries | R | schemas/storage-layout: "every index is ready once the schema answers" |
| 21 | retries up to five times | R | not asserted: needs a transient server failure during initialization |
| 22 | first boot after upgrade builds `__i` indexes | R | schemas/storage-layout (pre-existing table gets the `__i` indexes) |

### Write values (W, I 2.table.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 23 | text, numbers, booleans, null, date, list, nested document stored as given | W | writes/insert-values: "each value is stored as its own ReQL type"; write-values/stored-values |
| 24 | a list of mixed values (null, numbers, booleans, text, date, document, lists) read back as given | W | write-values/stored-values: "<by>: each value of the mixed list keeps its ReQL type", "<by>: the mixed list is stored as written", "the module reads the mixed list back as written" |
| 25 | an empty list | W | write-values/stored-values: "<by>: the empty list is stored as an empty list" |
| 26 | an empty nested document | W | write-values/stored-values: "<by>: the empty document is stored as an empty document" |
| 27 | a date read back as the instant written, milliseconds included | W | write-values/stored-values: "<by>: with its milliseconds", "the module reads the date back to the millisecond"; writes/insert-values |
| 28 | the same values through insert, batch insert, update, replace, conflict upsert | I 3.selection.md, 4.crud.md | write-values/stored-values (each check per `<by>`) |
| 29 | dates inside lists and nested documents are times | W | write-values/unstorable-values |
| 30 | bigint refused (insert, replace, update), nothing stored | W | write-values/unstorable-values |
| 31 | symbol dropped | W | write-values/unstorable-values |
| 32 | `undefined` writes no value (insert) and keeps the stored field (update) | W | write-values/unstorable-values |

### Writes (I 2.table.md, 3.selection.md, 4.single_selection.md, 4.crud.md, 3.results/2.write_results.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 33 | insert resolves to generated ids, one per document | I write_results | writes/insert-values: "an array insert resolves to one id per document", "generated ids are non-empty text" |
| 34 | insert of a provided `_id` resolves to that id | I write_results | not asserted: head answers `[]` (rethinkdb#73); asserting the docs would fail head, asserting head would pin the bug. The stored row is asserted |
| 35 | conflict `update` keeps unmentioned fields, `replace` drops them, both answer the id | I 4.crud.md | writes/insert-conflicts |
| 36 | a single row error is surfaced (DuplicateKeyError) | I 4.crud.md | writes/insert-conflicts, schemas/instances, external-write/external-writes |
| 37 | update changes only given fields, answers the count; function update | I 3.selection.md | writes/update-replace-delete |
| 38 | update and delete answer the documents they modified: 0 for a missing key | I | writes/update-replace-delete: "update of a missing key resolves to 0"; schemas/instances: "a CROSS_INSTANCE update of a missing key resolves to 0 ...", "a CROSS_INSTANCE delete of a missing key resolves to 0 ..." |
| 136 | update counts the documents it modified: an update that changes nothing resolves to 0, one where some rows already hold the values counts the others | I 3.selection.md, 2.write_results.md | writes/update-replace-delete: "an update that changes nothing modified no document", "an update of two documents that already hold the values modified none", "an update of two documents, one already holding the value, modified one" |
| 137 | a replace that writes the document already stored | I 3.selection.md | not asserted: the docs do not say whether it counts as replaced |
| 39 | replace drops the fields it leaves out, answers 1 | I | writes/update-replace-delete, write-values/stored-values ("no field outside the written document") |
| 40 | delete answers the number deleted, single and filtered | I | writes/update-replace-delete |
| 41 | batch insert with a duplicate: other rows depend on the database | I 4.crud.md | not asserted: documented as unspecified |

### Schemas and instances (I 2.database_management.md, 3.results/5.database_changes.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 42 | `createInstance(id?)` resolves to the instance id | I 5.database_changes | schemas/instances: "createInstance resolves to the instance's id" |
| 43 | rows belong to one instance, in every table | I multi-tenant | schemas/instances: "instance a holds its two rows", "instance b holds only its own rows", "the default instance holds only its own row", "b does not see a's row" |
| 44 | multi-table instances | I | schemas/instances (users and notes), native per-tenant counts |
| 45 | `listInstances` lists named instances; the default one is not included | I 2.database_management | schemas/instances: "listInstances names the named instances, not the default one" |
| 46 | `destroyInstance` deletes the instance's data, in every table | I index.md | schemas/instances: "destroyInstance left no row of a in users ...", "... in notes either", "destroyInstance removes a from the list" |
| 47 | destroyInstance leaves other instances, default included | I | schemas/instances: "b keeps its row", "b keeps its note", "the default instance keeps its row" |
| 48 | instances and their data persist (a database) | I | schemas/instances: "instances and their rows outlive a restart" |
| 49 | CROSS_INSTANCE reads every instance | I 5.database_changes | schemas/instances: "CROSS_INSTANCE reads the admins of every instance", "CROSS_INSTANCE counts the rows of every instance" |
| 50 | CROSS_INSTANCE updates and deletes reach every instance | I 2.database_management | schemas/instances: "a CROSS_INSTANCE update reaches every instance", "a CROSS_INSTANCE delete reaches every instance" |
| 51 | adapters reject CROSS_INSTANCE inserts | I 5.database_changes | schemas/instances: "CROSS_INSTANCE refuses an insert" |
| 52 | `Schema.get`, `IsStream` and the other predicates, `cast`, build-only staged queries | I index.md, 1.index.md | not asserted: implemented in `@antelopejs/interface-database`, no module code |

### Indexes (I 5.indexes.md, 3.results/3.index_changes.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 53 | getAll by a secondary index, one value and a list | I | reads/read-selections |
| 54 | between: lower inclusive, upper exclusive; dates | I 2.table.md | reads/read-selections |
| 55 | compound index bounds are lists | I 2.table.md | schemas/cross-instance-indexes: "betweenCompound on instance a / CROSS_INSTANCE, with/without crossInstance" |
| 56 | orderBy on a compound index orders by every field | I 5.indexes.md | reads/read-streams: "orderBy on a compound index ascending/descending ..."; cross-instance-indexes: orderBy, orderByDesc |
| 57 | multi index: lookup by any element | I 5.indexes.md | schemas/cross-instance-indexes: getAllMulti (scoped and cross, both flags) |
| 58 | crossInstance never changes results (getAll, between, orderBy, distinct, count(field)), a document missing the indexed field included | I 5.indexes.md | schemas/cross-instance-indexes: every `<read> on CROSS_INSTANCE, with/without crossInstance`; "distinct on CROSS_INSTANCE leaves out a document missing the field, with and without crossInstance" |
| 59 | scoped reads on an index see only the instance | I | schemas/cross-instance-indexes: every `<read> on instance a ...` |
| 60 | compound prefix lookup "by the first field alone" | I 5.indexes.md | not asserted: the docs give no call shape for it |
| 138 | a `between` bound may be `null` (`IndexBound`) | I 2.table.md | not asserted: the docs do not say what a null bound selects |

### Streams and documents (I 5.stream.md, 8.datum.md, 7.lookup.md, 7.query.md, 2.operations/6.filtering.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 61 | get, get of an unknown key, getAll by keys | I | reads/read-selections |
| 62 | filter, pluck, without, orderBy asc/desc, slice(offset, count) | I | reads/read-selections |
| 63 | iterate with `for await` | I 7.query.md | reads/read-selections: "iterating the table reads every row in order" |
| 64 | `cursor()` yields one row at a time | I 7.query.md | reads/read-streams: "cursor() yields the rows one at a time, in order" |
| 65 | `run()` executes | I 7.query.md | reads/read-streams: "run() executes the query" |
| 66 | stream `key(field)` | I 5.stream.md | reads/read-streams: "key reads one field of every row" |
| 67 | stream `key(field, fallback)` | I 5.stream.md | not asserted: head ignores the fallback (rethinkdb#74) |
| 68 | document `key(field, fallback)` for null, missing and present | I 8.datum.md | reads/read-streams: "key(field, fallback) of a document reads the fallback for null and missing, and the value otherwise" |
| 69 | key chains on a document | I 8.datum.md | reads/read-streams: "key chains read a nested field" |
| 70 | `default` on a missing field and a missing document | I 8.datum.md | reads/read-streams: "default replaces a missing field", "default replaces a missing document" |
| 71 | `do()` | I 8.datum.md | reads/read-streams: "do builds a value from the document" |
| 72 | map, union | I | reads/read-streams |
| 73 | distinct(field), distinct() | I | reads/read-streams: "distinct of a field ...", "distinct() of a mapped stream reads each value once" |
| 74 | count(), count(field) counts distinct values | I 5.stream.md | reads/read-streams: "count() counts every row", "count(field) counts the distinct values of the field"; cross-instance-indexes: count |
| 75 | sum, avg, min, max of a field; sum of a number stream | I | reads/read-streams |
| 76 | group with a mapper | I | reads/read-streams |
| 77 | join (left, null right side), joinInner | I | reads/read-streams |
| 78 | lookup of a single key on a stream | I 7.lookup.md | reads/read-streams: "lookup of a single key replaces it with the document it names" |
| 79 | lookup on a single document | I 7.lookup.md, 8.datum.md | reads/read-streams: "lookup on a single document replaces its key with the document and keeps its fields" |
| 80 | lookup of a list of keys answers a list of documents | I 7.lookup.md | not asserted: head answers an empty list (rethinkdb#75) |
| 81 | nth(n) by position | I 5.stream.md | reads/read-streams: "nth(0) reads the first row in order", "nth(3) reads the fourth row in order" |
| 82 | nth past the end | I | not asserted: the docs give no answer for it |
| 83 | stream `default()` on a sequence | I 5.stream.md | not asserted: the docs do not say whether it applies per row |
| 139 | stream `key` with a ValueProxy yielding the field name | I 5.stream.md | reads/read-streams: "key with a ValueProxy yielding the field name reads that field of every row" |

### ValueProxy (I 9.valueproxy.md, 6.filtering.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 84 | add, sub, mul, div, mod | I | reads/read-expressions: "add adds" ... "mod is the remainder" |
| 85 | round, ceil, floor (also of negatives) | I | reads/read-expressions |
| 86 | band, bor, bxor, bnot, blshift, brshift, brshiftPreserveSign | I | reads/read-expressions |
| 87 | gt, ge, lt, le on numbers, text and dates | I | reads/read-expressions |
| 88 | eq, ne, and, or, not | I | reads/read-expressions; reads/read-selections (filter) |
| 89 | upcase, downcase, split(sep), concat, strlen (codepoints), match | I | reads/read-expressions |
| 90 | `add` concatenates text and lists; a null operand answers null | I | reads/read-expressions: "add concatenates text", "add concatenates lists", "add of null ... answers null" (3 checks) |
| 91 | index, includes, slice(s, e?), map, filter, isempty, count, sum, avg | I | reads/read-expressions |
| 92 | array filter keeps a number unless it is 0 | I | reads/read-expressions: "filter keeps a number unless it is 0" |
| 93 | min, max of numbers, text, dates | I | reads/read-expressions |
| 94 | merge, keys, values, hasfields | I | reads/read-expressions |
| 95 | object `key(k, def)`, a null field's fallback, a ValueProxy fallback | I | reads/read-expressions |
| 96 | `default` replaces null and missing | I | reads/read-expressions |
| 97 | `ValueProxy.constant` | I | reads/read-expressions: "ValueProxy.constant" |
| 98 | date add/sub of seconds, date minus date in seconds | I | reads/read-expressions: "add of seconds to a date", "sub of seconds from a date", "sub of two dates ..." |
| 99 | year, month, day, dayofweek, dayofyear, hours, minutes, seconds, timeofday, epoch (ms precision) | I | reads/read-expressions (seconds, timeofday, epoch to the millisecond) |
| 100 | date components accept a timezone | I | reads/read-expressions: "hours in another timezone" |
| 101 | during with dates and with millisecond bounds, left inclusive | I | reads/read-expressions: "during with date bounds", "during with millisecond bounds includes the lower one", "... after the instant" |
| 102 | `split(sep, max)` | I | not asserted: the docs do not say what `max` keeps |
| 140 | `and` / `or` evaluate operands by truthiness | I 9.valueproxy.md | not asserted: the docs state the compile-time operand rule, not the answer for a non-boolean operand |

### Change feeds (I 6.feed.md, 3.results/6.value_changes.md, 7.query.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 103 | table feed: added (newValue only), modified (both), removed (oldValue only) | I | reads/change-feeds: "a table feed yields an added, a modified and a removed event ..." |
| 104 | one event per iteration | I 7.query.md | reads/change-feeds (events read one `next()` at a time) |
| 105 | document feed sees only its document | I 4.single_selection.md | reads/change-feeds: "a document feed yields its own modified and removed events ..." |
| 106 | a feed opened on an instance sees only that instance | I instances | reads/change-feeds (a write to b is absent from a's feed) |
| 107 | breaking out of the loop closes the cursor | I 6.feed.md | reads/change-feeds (the journey completes after `return()`; not observed on the server) |

### Atomic mutations (I 8.atomic_mutations.md)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 108 | revision compare: applied, stale not-applied, unknown record not-applied | I | atomic/atomic-outcomes |
| 109 | `missing` matches an absent field, not a stored null | I | atomic/atomic-outcomes |
| 110 | instance scope: an update, a delete and a `deleteIfEqual` of another instance's record are not-applied and change nothing | I | atomic/atomic-outcomes: "another instance's record is out of scope", "a delete of another instance's record is not-applied", "a deleteIfEqual of another instance's record is not-applied"; native "the refused patches and the other instance's deletes left both records as written, in instance a" |
| 111 | patch replaces top-level fields whole; null stored; other fields stay | I | atomic/atomic-outcomes |
| 112 | the patch cannot contain `_id`, `id`, the revision field or adapter-owned scope fields (`tenant_id`) | I | atomic/atomic-outcomes: "a patch naming _id is refused with a TypeError", "a patch naming id is refused", "a patch naming the revision field is refused", "a patch naming the adapter-owned tenant_id is refused" |
| 113 | delete with revision; deleteIfEqual by instant, not an array holding it, missing field never matches | I | atomic/atomic-outcomes |
| 114 | deleteIfEqual equality is type-sensitive | I | atomic/atomic-outcomes: "deleteIfEqual is type-sensitive ...", "deleteIfEqual with the stored number is applied" |
| 115 | CROSS_INSTANCE not supported (the interface refuses it before the module) | I | atomic/atomic-outcomes: "a CROSS_INSTANCE atomic mutation is refused" + native "the CROSS_INSTANCE mutation changed nothing ..." |
| 116 | the default instance is supported | I | atomic/atomic-outcomes: "the default instance is supported" |
| 117 | a Date in a patch keeps the normal Date storage | I | atomic/atomic-outcomes: "a Date in a patch is stored as a time", "with its milliseconds" |
| 118 | `unknown` outcome on a lost acknowledgement | I | not asserted: needs a lost acknowledgement |
| 119 | cursor execution rejected | I 7.query.md | not asserted: implemented in the interface package |

### External mode (X)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 120 | never changes structure; registration writes nothing | X | external-read/external-reads: "no database, table or index was created or dropped" |
| 121 | rows answer `_id` and declared fields only; wrong-type values read null | X | external-read/external-reads |
| 122 | `_id` by key type (text, number, compound); unparsable key matches nothing | X | external-read/external-reads |
| 123 | multi-type key table: counts and filters work, read without `_id`, `get` refused | X | external-read/external-reads |
| 124 | `get`, `getAll` (one key, a list of keys, number keys) and `between` by `_id` or a declared index; `orderBy` by a declared index, ascending and descending | X, I 5.stream.md | external-read/external-reads: "getAll by a declared index ...", "getAll with a list of keys reads each row", "getAll with a list of number keys reads each row", "between by a declared index ...", "between by _id includes the lower bound and excludes the upper", "rows come back in the order of the index asked for", "orderBy a declared index descending reverses the order" |
| 125 | registration failures (missing table, multi-type `_id`, unknown field type) fail every query with the message | X | external-read/external-registration: "<label>: the refusal is said, in the query's error or the project's output", "<label>: no query on the refused schema answers" |
| 126 | partial-sample field and missing index only warn | X | external-read/external-registration |
| 127 | writes: declared fields only, `_instance`/`tenant_id` dropped, object and list fields read-only, key agreement, uuid generation, write-only-differences, replace keeps undeclared, DuplicateKeyError quoting no row, `forbidden` | X | external-write/external-writes |
| 141 | insert resolves to the keys: a keyed insert, a conflict replace and a conflict update answer the key | X, I 2.write_results.md | external-write/external-writes: "an insert with a key answers that key", "a conflict replace answers the key", "a conflict update answers the key" |
| 142 | conflict `replace` removes the declared fields it leaves out and keeps undeclared ones; conflict `update` keeps the fields it does not send | X, I 4.crud.md | external-write/external-writes: "a conflict replace removed the declared fields it left out ...", "a conflict update wrote the name and kept the fields it did not send" |
| 143 | writes on a number-key table: insert answers the key's text, update and delete address the number | X Writing (every table whose keys share one type) | external-write/external-writes: "an insert on a number-key table answers the key's text", "an update on a number-key table changes one row", "a delete on a number-key table removes one row", native "the number-key table holds the updated and the inserted rows, keyed by numbers" |
| 144 | writes on a compound-key table: `_id` is the key's JSON text, insert answers it | X | external-write/external-writes: "an insert on a compound-key table answers the key's JSON text", "an update on a compound-key table changes one row", "a delete on a compound-key table removes one row", native "the compound-key table holds ..." |
| 145 | a field a read answered as null keeps its stored value, or its absence, when the row is written back | X | external-write/external-writes: "a row whose field read as null, written back whole, changes nothing", "a row missing a declared field, written back whole, changes nothing", native "a field read as null kept its stored value", "a field read as absent kept its absence" |
| 146 | a field declared with an io-ts codec is a known field type | I 3.results/4.table_changes.md, X | external-read/external-registration: "a field declared with an io-ts codec is a known type ..." |
| 147 | the schema id is a label: the tables are always read from the url's database | X | external-read/external-registration: "the schema registers and reads" (schema `warn`), "... labelled codec, registers and reads the url's notes" |
| 128 | refused: multi-type key writes, mapper update, `changes()`, atomicMutation, `createInstance`, `destroyInstance`, and a named instance for reads; listInstances empty | X | external-write/external-refusals (each "is refused with its reason", "listInstances is empty"); external-read/external-reads: "a named instance of an external table is refused" |
| 129 | `statementTimeoutMs` closes a read that outlasts it, and the read rejects with a timeout | X, R | module/external-options: "a read that outlasts statementTimeoutMs rejects with a timeout" (a 40000-row scan, limit 1 ms), against "without a limit the scan reads every order and matches none" |
| 130 | an external instance does not implement interface-rethinkdb | X | external-write/external-refusals (project lists it in `disabledExports`), catalog journeys |

### Catalog (X, C) and raw client (Q)

| # | Documented behaviour | Source | Journey: check |
| --- | --- | --- | --- |
| 131 | Info, ListRelations (keys, write privilege), DescribeRelations, Profile row count, SampleRows (20 rows, text cut at 200 characters); writes nothing | X, C | catalog/catalog-describe |
| 132 | refused on an owned instance and when disabled | X | catalog/catalog-refused |
| 148 | SampleRows refuses more than 20 rows (21 too), answers only the `columns` asked for, `sample` null when the table was read whole, and a binary value by its length only | X, C | catalog/catalog-describe: "SampleRows of 21 rows is refused", "SampleRows answers only the columns asked for ...", "SampleRows answers a binary value by its length only" |
| 149 | a field's declaration is the one that reads at least 80% of its sampled values; none when no type reaches 80% | X | catalog/catalog-describe: "a field whose sampled values are at least 80% one type declares it, and one where no type reaches 80% declares nothing" |
| 150 | indexes list the fields of a `getField` or an array of fields; any other function index lists none | X | catalog/catalog-describe: "an index lists the fields of a getField or of an array of fields, and any other function index lists none" |
| 151 | values are named only as categories of a field with at most 25 distinct values, each counted at least 5 times; rarer values are counted in `other` | X, C | catalog/catalog-describe: "a value counted at least 5 times is a category ...", "values counted fewer than 5 times are never named ...", "a field with 26 distinct values names no category, one with 25 names each ..." |
| 152 | text answers no minimum or maximum | X, C | catalog/catalog-describe: "text answers no minimum or maximum", "a text column with categories still answers no range" |
| 153 | Profile counts nulls and distinct values, and measures text lengths | C | catalog/catalog-describe: "Profile counts a column's nulls", "Profile counts a column's distinct values", "Profile measures the lengths of a text column" |
| 154 | Profile answers the ends of number and date columns, dates as ISO strings | C | catalog/catalog-describe: "Profile answers the ends of a number column", "Profile answers the ends of a date column as ISO instants" |
| 155 | Profile counts the rows of a date column per calendar month, `YYYY-MM` in UTC | C | catalog/catalog-describe: "Profile counts the rows of a date column per calendar month" |
| 156 | a column with one distinct value per row, never null, is `identifier-like` | C | catalog/catalog-describe: "a column with one distinct value per row, never null, is identifier-like" |
| 157 | other traits (`enum-like`, `label-candidate`, `time-axis`, `measure`) | C | not asserted: their thresholds ("enough rows", "short enough") are not documented |
| 158 | Profile with `columns` profiles only those columns | C | catalog/catalog-describe: "Profile with columns profiles only those columns" |
| 159 | CheckReference answers containment, the rows checked, whether it sampled and whether the target is a key | C | catalog/catalog-describe: "CheckReference finds every value of a referring column in the key it names", "CheckReference of a column whose values the other does not hold ..." |
| 160 | a relation whose keys have more than one type is not unmappable: it registers without `_id` | C, X | catalog/catalog-describe: "a table whose keys have more than one type is not unmappable ..." |
| 161 | the catalog is on under `ajs project dev` when `catalog.enabled` is unset | X, `config.ts` TSDoc | catalog/catalog-describe (no `catalog` option; every call answers) |
| 162 | under `ajs project start` the catalog refuses when `catalog.enabled` is unset and answers when it is true; under `ajs project run` it answers | X, C, `config.ts` TSDoc | catalog/catalog-start: "under ajs project start, the catalog refuses when catalog.enabled is unset", "... answers when catalog.enabled is true", "under ajs project run, the catalog answers when catalog.enabled is unset" |
| 163 | catalog calls run one at a time | X | not asserted: the answers do not show whether two calls overlapped |
| 133 | large-table sampling (above one million estimated rows), measures closed at 5 s answering `{ status: "timeout" }` | X, C | not asserted: needs a table over one million rows or a measure that outlasts 5 s |
| 134 | `RunQuery` runs a query on the module's connection; `r` is rethinkdb-ts | Q | raw-client/raw-client |
| 164 | a table named without a database is read from the configured default database | Q docs/1.introduction.md | raw-client/raw-client: "a table named without a database is read from the configured default database" |
| 135 | run options pass through to the driver | Q | not asserted: `readMode`, `durability` have no observable answer on a single server |

