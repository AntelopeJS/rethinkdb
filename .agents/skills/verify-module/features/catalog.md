---
covers:
  - src/implementations/catalog/**
docs:
  - docs/external-mode.md
journeys:
  - catalog-describe
  - catalog-refused
  - catalog-start
---

# Catalog

The catalog of an external instance: information, relations, descriptions, profiles and samples, its refusal on an owned instance and when disabled, and that it writes nothing.

## Sub-features

- `catalog-describe`: `Info`, `ListRelations`, `DescribeRelations`, `Profile`, `CheckReference` and `SampleRows`, with the long text cut at 200 characters, a binary value answered by its length, the 80% rule of a field's declaration, the fields of getField, array and other function indexes, the profile's nulls, distinct values, lengths, ranges, months and categories (at least 5 rows each, at most 25 distinct values), and the `columns` filters.
- `catalog-refused`: refusals on an owned instance and with `catalog.enabled` false.
- `catalog-start`: a project built with `ajs project build` and run with `ajs project start` refuses the catalog when `catalog.enabled` is unset and answers it when true; under `ajs project run` it answers. The journey drives `start` and `run` with a small node script, because `context.dev` only runs `ajs project dev`.

## How to get to it (user POV)

- `@antelopejs/interface-database-catalog` called by a generator under `ajs project dev`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" catalog
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- `estimatedRows` comes from RethinkDB's statistics and is not asserted.
