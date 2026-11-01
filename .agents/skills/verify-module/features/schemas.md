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
  - unique-refused
  - instances
---

# Schemas and instances

What an owned instance creates in RethinkDB: a database per schema, a table per declared table, the `tenant_id` and `<name>__i` indexes, the instance registry, the refusal of unique secondary indexes and the isolation of instances. This feature holds the Format door of the stored layout (`storage-layout`) and the Data door of instance scoping (`instances`).

## Sub-features

- `storage-layout`: database, tables and index names as README.md describes them.
- `unique-refused`: `unique: true` on a secondary index stops the project with a message naming schema, table and index, and creates nothing.
- `instances`: rows belong to one instance, `_id` is shared by all, `CROSS_INSTANCE` reads them all, `destroyInstance` removes only its own.

## How to get to it (user POV)

- `new Schema(id, definition)` and `schema.createInstance()` in a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" schemas
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- A refused registration is an unhandled rejection of the consumer: the journey reads the project's logs, not a rejected query (see the issue draft on schema registration failures).
