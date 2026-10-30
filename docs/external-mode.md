# External mode

`mode: "external"` points the module at tables that already exist, in a database it does not own,
and reads and writes their rows. It is for describing an existing database to AntelopeJS,
typically a schema written from the module's catalog. It never changes that database's structure:
no database, table or index is created, and no registry table is kept.

```typescript fragment
{
    mode: "external",
    url: "rethinkdb://erp_reader:…@client-db:28015/erp",
}
```

`url` is required, with the database as its path: an external instance without one refuses to
construct, rather than falling back to a default. It is the one secret of the instance, so projects
set it through `envOverrides`, and a staging copy under another database name needs only another
value:

```typescript fragment
envOverrides: { ERP_RETHINKDB_URL: "modules.rethinkdb-erp.config.url" },
```

`pool` options still apply, merged under what the url gives; a `pool.db` that disagrees with the
url's database is refused. One external instance serves one database. An external instance does
not implement `@antelopejs/interface-rethinkdb`: no module gets its raw `r`. The project lists that
interface in the module's `disabledExports`. The module depends on it only optionally, so the
project still loads when no other module provides it.

## The schema mirrors the database

Nothing is mapped. The table id is the table, and a field is a top-level key of its rows, both
verbatim. The schema id is a label: the tables are always read from the url's database. The
primary key field (`id`, `sku`) is declared as a field of its own, beside `_id`.

## What registration does

It reads, once per declared table, and writes nothing: the table list, `info()`, `indexStatus()`,
the first and last keys of the primary index, and the types of the fields of the first 1000 rows.
A failure here fails the schema's registration, so every query on it fails with the same message:

- a declared table the database does not have
- `_id` declared on a table whose primary keys have more than one type (below)
- a field type the module does not know

A field some of whose sampled values are of a type the declaration does not read is accepted with
a warning giving their share, and so is a declared index the table has no index for.

## Values and `_id`

A row answers `_id` and its declared fields, nothing else. A value of a type the declaration does
not read is null: `price: "12"` in a `number` field reads as null, since strings are never parsed.

| Primary key type     | `_id` answered | A key addresses  |
| -------------------- | -------------- | ---------------- |
| string               | itself         | itself           |
| number               | its text       | the number       |
| array (compound key) | its JSON text  | the parsed array |

A key that does not parse as the table's type, such as `"[bad"` for an array key, matches nothing:
`get` answers not found. A table whose primary keys have more than one type is read without `_id`:
queries, counts and aggregations work, `get`, `getAll` by `_id` and writes are refused.

`get`, `getAll` and `between` by `_id` or by a declared index read the table's primary index or
its own index over the same fields; an `orderBy` that comes first sorts by such an index too.
Everything after them compares the declared values, so a filter scans, as any ReQL `filter` does.

RethinkDB has no server-side time limit. `statementTimeoutMs` runs each read on a connection of
its own and closes it when the limit passes, which stops the query on the server, and the read
rejects with a timeout.

## Writing

`insert`, `update`, `replace` and `delete` work on every table whose keys share one type.

- A payload names declared fields only: any other key, `_internal` included, is refused by name.
  `_instance` and `tenant_id` are dropped
- `object` and array fields are read-only: a value for one is refused by `insert` and ignored by
  `update` and `replace`
- `_id` and the primary key field say which row is written: an `update` whose `_id` names another
  row writes nothing and answers 0. On `insert` they are the new row's key, and must agree
- An insert without a key lets the server generate a uuid when the table's keys are uuids, and is
  refused otherwise
- Only the fields whose read differs from the written value are written, so a row read and
  written back whole changes nothing and answers 0, and a field a read answered as null keeps its
  stored value or its absence
- `replace` removes the declared fields it leaves out and keeps undeclared ones: `replace()` is
  never used, since it would drop them
- A duplicate key raises the interface's `DuplicateKeyError`, quoting no row; a write the account
  may not make raises an error of kind `forbidden`

## What is refused

- writes to a table whose keys have more than one type, and `atomicMutation`
- `update` with an expression mapper (`update(row => …)`)
- `changes()`
- a named instance, `createInstance` and `destroyInstance`; `listInstances` is empty

## The account to connect with

```javascript
r.db("rethinkdb").table("users").insert({ id: "dms", password: "…" });
r.db("erp").grant("dms", { read: true });
r.db("erp").table("orders").grant("dms", { read: true, write: true });
```

RethinkDB has no read-only session: the module sends reads only, apart from the writes it is asked
for and the catalog's write probe below, and an account with `read` only is the guarantee.

## The catalog

An external instance also implements `@antelopejs/interface-database-catalog`, which describes and
profiles the database for a generator. It answers under `ajs project dev` and `ajs project run`,
and refuses under `ajs project start` unless enabled with `catalog: { enabled: true }`. An owned
instance refuses it.

- **Fields come from a sample:** each top-level key with its ReQL types and their shares, the
  declaration that reads at least 80% of them, and what it loses. Indexes list the fields of a
  `getField` or an array of fields; any other function index lists none.
- **Write privileges** come from deleting a key no row has: a reader gets a permission error, a
  writer `skipped: 1`, and nothing changes. RethinkDB lets an account read neither its own
  permissions nor the table configuration.
- **Measures** each run on a connection of their own, closed at 5 s, and answer
  `{ status: "timeout" }` then; the rest of the profile stands. Calls run one at a time.
- **Large tables** (above one million estimated rows) are read through 1000 rows after each of 50
  evenly spaced uuids when the keys are uuids, so a second profile reads the same rows, and through
  `sample(50000)` otherwise, which reads the whole table under the time limit.
- **Values** are named only as categories of a field with at most 25 distinct values, each counted
  at least 5 times; text answers no minimum or maximum. `SampleRows` answers at most 20 rows, as
  text cut at 200 characters, for a person to look at.
