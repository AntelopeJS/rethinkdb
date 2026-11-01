---
covers:
  - src/implementations/catalog/**
docs:
  - docs/external-mode.md
journeys:
  - catalog-describe
  - catalog-refused
---

# Catalog

The catalog of an external instance: information, relations, descriptions, profiles and samples, its refusal on an owned instance and when disabled, and that it writes nothing.

## Sub-features

- `catalog-describe`: `Info`, `ListRelations`, `DescribeRelations`, `Profile` and `SampleRows`, with the long text cut at 200 characters.
- `catalog-refused`: refusals on an owned instance and with `catalog.enabled` false.

## How to get to it (user POV)

- `@antelopejs/interface-database-catalog` called by a generator under `ajs project dev`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" catalog
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- `estimatedRows` comes from RethinkDB's statistics and is not asserted.
