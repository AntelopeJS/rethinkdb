---
covers:
  - src/implementations/database/external-read.ts
  - src/implementations/database/external-selection.ts
  - src/implementations/database/external-descriptor.ts
  - src/implementations/database/external-probe.ts
  - src/implementations/database/external-registration.ts
docs:
  - docs/external-mode.md
journeys:
  - external-reads
  - external-registration
---

# External reads

An external instance reading a database it does not own: `_id` by key type, null for values the declaration does not read, indexes, the multi-type key table, the registration failures and warnings, and the guarantee that the structure never changes.

## Sub-features

- `external-reads`: reads by key class, by index, by a list of keys, by an `_id` range, in descending index order and by scan, the refused named instance, with the client structure compared before and after.
- `external-registration`: a missing table, `_id` over multi-type keys and an unknown field type fail with their message, in the query's error or the logs, and no query on that schema answers; a partial sample and a missing index only warn; a field declared with an io-ts codec registers, under a schema id that is only a label.

## How to get to it (user POV)

- `mode: "external"` with `url: "rethinkdb://account:password@host:port/database"`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" external-read
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- The accounts, rows and tables are created by the journey as the database's owner; the module never creates them.
