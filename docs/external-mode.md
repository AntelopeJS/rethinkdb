---
title: External mode
description: How an external instance of the RethinkDB module reads and writes the rows of a database it did not create, and what its catalog answers.
mode: reference
---

`mode: "external"` points the module at tables that already exist, in a database it does not own,
and reads and writes their rows. Use it to describe an existing database to AntelopeJS, typically
with a schema written from the catalog of the module. The module never changes the structure of
that database. It creates no database, table, or index, and it keeps no registry table.

```typescript fragment
{
    mode: "external",
    url: "rethinkdb://erp_reader:…@client-db:28015/erp",
}
```

`url` is required, with the database as its path. An external instance without one refuses to
construct and does not fall back to a default. The url is the one secret of the instance, so
projects set it through `envOverrides`. A staging copy under another database name needs only
another value:

```typescript fragment
envOverrides: { ERP_RETHINKDB_URL: "modules.rethinkdb-erp.config.url" },
```

`pool` options still apply, merged under what the url gives. The module refuses a `pool.db` that
disagrees with the database of the url. One external instance serves one database.

An external instance does not implement `@antelopejs/interface-rethinkdb`, so no module gets its
raw `r`. The project lists that interface in the `disabledExports` of the module. The module
depends on that interface only optionally, so the project still loads when no other module
provides it.

## The schema mirrors the database

The module maps nothing. The table id is the name of the table, and a field is a top-level key of
its rows, both verbatim. The schema id is a label, because the module always reads the tables from
the database of the url. Declare the primary key field (`id`, `sku`) as a field of its own, beside
`_id`.

## What registration does

Registration reads once per declared table and writes nothing. It reads the table list, `info()`,
`indexStatus()`, the types of the first and last keys of the primary index, and the types of the
fields of the first 1000 rows. A failure here fails the registration of the schema, so every query
on that schema fails with the same message. Registration fails on:

- a declared table that the database does not have
- `_id` declared on a table whose primary keys have more than one type (see below)
- a field type that the module does not know

Registration accepts two cases with a warning. The first is a field where some sampled values have
a type that the declaration does not read, and the warning gives their share. The second is a
declared index that has no matching index on the table.

## Values and `_id`

A row answers `_id` and its declared fields, nothing else. A value of a type that the declaration
does not read is null. For example, `price: "12"` in a `number` field reads as null, because the
module never parses strings.

| Primary key type     | `_id` answered | A key addresses  |
| -------------------- | -------------- | ---------------- |
| string               | itself         | itself           |
| number               | its text       | the number       |
| array (compound key) | its JSON text  | the parsed array |

A key that does not parse as the type of the table, such as `"[bad"` for an array key, matches
nothing, and `get` answers not found. The module reads a table whose primary keys have more than
one type without `_id`. Queries, counts, and aggregations work on that table. `get`, `getAll` by
`_id`, and writes are refused.

`get`, `getAll`, and `between` by `_id` or by a declared index read the primary index of the table,
or its own index over the same fields. An `orderBy` that comes first sorts by such an index too.
Every later stage compares the declared values, so a filter scans the table, as any ReQL `filter`
does.

RethinkDB has no server-side time limit. With `statementTimeoutMs` set, the module runs each read
on a connection of its own and closes that connection when the limit passes. Closing the
connection stops the query on the server, and the read rejects with an error whose `name` is
`"QueryTimeoutError"`. A read that finishes in time leaves its connection open for the next
bounded read. The package does not export the class, so check `name` instead of
`instanceof`.

## Writing

`insert`, `update`, `replace`, and `delete` work on every table whose keys share one type.

- A payload names declared fields only. The module refuses any other key by name, `_internal`
  included. It drops `_instance` and `tenant_id`.
- `object` and array fields are read-only. `insert` refuses a value for one, and `update` and
  `replace` ignore it.
- `_id` and the primary key field say which row the module writes. An `update` whose `_id` names
  another row writes nothing and answers 0. On `insert`, they are the key of the new row, and they
  must agree.
- An insert without a key lets the server generate a uuid when the keys of the table are uuids.
  Otherwise the module refuses the insert.
- The module writes only the fields whose read value differs from the written value. A row read
  and written back whole changes nothing and answers 0. A field that a read answered as null keeps
  its stored value, or stays absent.
- `replace` removes the declared fields it leaves out and keeps the undeclared ones. The module
  never calls the ReQL `replace()`, because that call would drop them.
- A duplicate key raises the `DuplicateKeyError` of the interface, which quotes no row. A write
  that the account may not make raises an error of kind `forbidden`.

## What is refused

- writes to a table whose keys have more than one type, and `atomicMutation`
- `update` with an expression mapper (`update(row => …)`)
- `changes()`
- a named instance, `createInstance`, and `destroyInstance` (`listInstances` answers an empty list)

## The account to connect with

```javascript
r.db("rethinkdb").table("users").insert({ id: "dms", password: "…" });
r.db("erp").grant("dms", { read: true });
r.db("erp").table("orders").grant("dms", { read: true, write: true });
```

RethinkDB has no read-only session. The module sends only reads, apart from the writes that a
caller asks for and the write probe of the catalog (see below). An account with only `read` is the
guarantee.

## The catalog

An external instance also implements `@antelopejs/interface-database-catalog`, which describes and
profiles the database for a generator. The catalog answers under `ajs project dev` and
`ajs project run`. Under `ajs project start`, it refuses unless `catalog: { enabled: true }` is
set. An owned instance refuses every catalog call.

- **Fields come from a sample.** The catalog lists each top-level key with its ReQL types and
  their shares, the declaration that reads at least 80% of the values, and what that declaration
  loses. Indexes list the fields of a `getField` or of an array of fields. Any other function
  index lists none.
- **Write privileges come from a delete.** The catalog deletes a key that no row has. A reader
  gets a permission error, a writer gets `skipped: 1`, and nothing changes. RethinkDB lets an
  account read neither its own permissions nor the table configuration.
- **Measures run on their own connections.** The catalog closes each connection at 5 s, and the
  measure then answers `{ status: "timeout" }`. The rest of the profile stands. Catalog calls run
  one at a time.
- **Large tables are sampled.** Above one million estimated rows, a uuid-keyed table is read
  through the 1000 rows after each of 50 evenly spaced uuids, so a second profile reads the same
  rows. Any other large table is read through `sample(50000)`, which reads the whole table under
  the time limit.
- **Values appear only as categories.** The catalog names values only as the categories of a
  field with at most 25 distinct values, each counted at least 5 times. A text field answers no
  minimum or maximum value, only the minimum, average, and maximum of its lengths. `SampleRows`
  answers at most 20 rows, as text cut at 200 characters, for a person to look at.
