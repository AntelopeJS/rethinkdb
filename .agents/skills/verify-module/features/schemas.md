---
covers:
  - src/implementations/database/schema.ts
  - src/implementations/database/initialize.ts
  - src/implementations/database/indexes.ts
  - src/implementations/database/utils.ts
docs:
  - README.md
journeys:
  - storage-layout
  - refused-indexes
  - instances
  - cross-instance-indexes
---

# Schemas and instances

What an owned instance creates in RethinkDB: a database per schema, a table per declared table, the `tenant_id` and `<name>__i` indexes, the instance registry, the refusal of unique secondary indexes and the isolation of instances. This feature holds the Format door of the stored layout (`storage-layout`) and the Data door of instance scoping (`instances`).

## Sub-features

- `storage-layout`: database, tables and index names (simple, compound, multi and crossInstance) as README.md describes them, over a table that already exists, whose rows and own index are kept.
- `refused-indexes`: `unique: true` on a secondary index, and an index name ending in `__i`, are refused with a message naming the index and its table; no query on the schema answers and nothing is created.
- `instances`: rows of two tables belong to one instance, `_id` is shared by all, `CROSS_INSTANCE` reads, updates and deletes them all, answers 0 for an update or delete of a missing key, and refuses an insert, `listInstances` leaves out the default instance, `destroyInstance` removes only its own rows in every table, and instances and rows outlive a restart.
- `cross-instance-indexes`: getAll, between, orderBy, distinct and count(field) on simple, compound and multi indexes answer the same rows with and without `crossInstance`, scoped or across instances, and the unflagged ones log one warning each.

## How to get to it (user POV)

- `new Schema(id, definition)` and `schema.createInstance()` in a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" schemas
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- `refused-indexes` queries the refused schema and accepts the message in the query's error or in the project's output: docs/external-mode.md says queries on the schema fail with the message, while the module today ends the project (interface-database#61). Both behaviours pass; a schema that answers a query fails.
