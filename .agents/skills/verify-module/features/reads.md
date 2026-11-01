---
covers:
  - src/implementations/database/stream.ts
  - src/implementations/database/expression.ts
  - src/implementations/database/query.ts
docs:
  - README.md
journeys:
  - read-selections
  - read-streams
---

# Reads

Selections, filters, ordering, slicing, aggregates, groups and joins on an owned table.

## Sub-features

- `read-selections`: get, getAll, between bounds, filter, pluck, without, orderBy, slice and `for await`.
- `read-streams`: key, default, map, union, distinct, sum, avg, min, max, group, join, joinInner.

## How to get to it (user POV)

- `await table.filter(...).orderBy(...).slice(...)` and `for await (const row of table)`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" reads
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- Every stored row also carries `tenant_id`; the journeys do not assert it.
