---
covers:
  - src/implementations/database/external-writes.ts
docs:
  - docs/external-mode.md
journeys:
  - external-writes
  - external-refusals
---

# External writes

Writes to the client's tables: declared fields only, dropped scope fields, read-only object and list fields, key rules, replace keeping undeclared fields, `DuplicateKeyError`, `forbidden`, and what an external instance refuses. This feature holds the second containment of the Data door (`external-writes`).

## Sub-features

- `external-writes`: insert, update, replace and delete against the client rows, read back with `rethinkdb-ts`.
- `external-refusals`: multi-type key writes, mapper updates, `changes()`, `atomicMutation` and instances are refused and change nothing.

## How to get to it (user POV)

- `insert`, `update`, `replace`, `delete` on a schema declared against an external instance with a writer account.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" external-write
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- The statement time limit is not reachable from a journey and is not verified.
