---
covers:
  - src/implementations/database/atomic.ts
docs:
  - README.md
journeys:
  - atomic-outcomes
---

# Atomic mutations

`table.atomicMutation(id, request)` in one RethinkDB `replace`: revision compare, missing versus null, instance scope, top-level patch replacement and `deleteIfEqual`.

## Sub-features

- `atomic-outcomes`: applied, not-applied and the refusal of a patch naming `_id`.

## How to get to it (user POV)

- `table.atomicMutation(id, { type: "update" | "delete" | "deleteIfEqual", ... })`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" atomic
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- The `unknown` outcome needs a lost acknowledgement and is not reachable from a journey.
