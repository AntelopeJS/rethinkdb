---
covers:
  - src/index.ts
  - src/config.ts
  - src/connection.ts
  - src/utils/logger.ts
  - src/rethinkdb-ts.d.ts
docs:
  - README.md
  - docs/external-mode.md
journeys:
  - connection-modes
  - config-refused
  - external-options
---

# Module

How the module is configured and connects: `pool`, `connection` or `url`, `pool` winning when both are set, and the configs it refuses to start on.

## Sub-features

- `connection-modes`: the default configuration in `package.json` is a pool to 127.0.0.1:28015 as admin, read without connecting to that port; a round trip works with `connection` alone, with `url` alone and with a `pool` beside a dead `connection`.
- `config-refused`: no connection option, an external instance without a url or database, a `pool.db` that disagrees, an unknown mode, a zero, fractional or negative `statementTimeoutMs` and a non-rethinkdb url each stop `ajs project dev` and say why.
- `external-options`: an external instance whose `pool` points at a dead server still reads through the url's server, since pool options are merged under the url; with `statementTimeoutMs: 1`, a scan of 40000 rows rejects with a timeout, while the same scan without a limit answers.

## How to get to it (user POV)

- `modules.rethinkdb.config` in `antelope.config.ts`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" module
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- `config-refused` runs the core CLI itself: the project never comes up, so `context.dev` cannot be used.
