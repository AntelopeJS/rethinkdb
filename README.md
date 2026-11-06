# `@antelopejs/rethinkdb`

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/rethinkdb"><img data-illustration alt="npm" src="https://img.shields.io/npm/v/@antelopejs/rethinkdb?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img data-illustration alt="License" src="https://img.shields.io/npm/l/@antelopejs/rethinkdb?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/g4pFt6eXqu"><img data-illustration src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://interfaces.antelopejs.com/docs/database"><img data-illustration src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

The RethinkDB backend of AntelopeJS. It runs the queries of the database interface on RethinkDB through [`rethinkdb-ts`](https://github.com/rethinkdb/rethinkdb-ts), and gives that driver to the modules that need it directly.

Part of [AntelopeJS](https://github.com/AntelopeJS/antelopejs). Used by [AntelopeJS DMS](https://github.com/AntelopeJS/dms), the open-source back office for your PostgreSQL, MongoDB or RethinkDB database.

## Interfaces

| Interface                                                                                            | Documentation                                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@antelopejs/interface-database`](https://github.com/AntelopeJS/interface-database)                 | [Database](https://interfaces.antelopejs.com/docs/database)                |
| [`@antelopejs/interface-rethinkdb`](https://github.com/AntelopeJS/interface-rethinkdb)               | [RethinkDB](https://interfaces.antelopejs.com/docs/rethinkdb/introduction) |
| [`@antelopejs/interface-database-catalog`](https://github.com/AntelopeJS/interface-database-catalog) | [External mode](docs/external-mode.md#the-catalog)                         |

The database interface pages document schemas, tables, queries, change feeds, and atomic mutations.

## Install

```bash
ajs project modules add @antelopejs/rethinkdb
```

The command writes the default configuration of the module, which opens a connection pool to `127.0.0.1:28015` as `admin`.

## Configuration

The module connects through a connection pool (`pool`) or through a single connection (`connection`). When both are set, `pool` wins. When `url` is set, the module builds the pool from it and ignores `connection`.

```typescript [antelope.config.ts]
import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "my-project",
  modules: {
    rethinkdb: {
      source: {
        type: "package",
        package: "@antelopejs/rethinkdb",
        version: "^1.4.0",
      },
      config: {
        pool: {
          host: "127.0.0.1",
          port: 28015,
          user: "admin",
          password: "",
          pool: true,
          cursor: false,
          silent: true,
          discovery: true,
        },
      },
    },
  },
});
```

For a single connection:

```typescript fragment
config: {
  connection: { host: "127.0.0.1", port: 28015, user: "admin", password: "" },
},
```

| Key                  | Description                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pool`               | `rethinkdb-ts` pool options (`RPoolConnectionOptions`), passed to `r.connectPool()`.                                                                                              |
| `connection`         | `rethinkdb-ts` connection options (`RConnectionOptions`), passed to `r.connect()`. Used when `pool` and `url` are unset.                                                          |
| `url`                | `rethinkdb://user:password@host:port/database`, parsed into pool options. The port defaults to `28015` and the user to `admin`. Required in external mode.                        |
| `mode`               | `owned` (default) creates a database per schema and scopes rows to instances. `external` serves a database the module did not create. See [External mode](docs/external-mode.md). |
| `statementTimeoutMs` | Time limit, in milliseconds, of each read of an external instance. The module closes the connection of a read that runs past it. It must be a positive safe integer.              |
| `catalog`            | `{ enabled?: boolean }`. Turns the catalog of an external instance on or off. Unset, the catalog answers under `ajs project dev` and `ajs project run` only.                      |

The module refuses to start when none of `url`, `pool`, or `connection` is set, and when `mode` is neither `owned` nor `external`. The option types come from [`rethinkdb-ts`](https://github.com/rethinkdb/rethinkdb-ts).

## Quick start

In the module that stores data, add the database interface:

```bash
pnpm add @antelopejs/interface-database
```

Then follow the [database interface guide](https://framework.antelopejs.com/docs/guides/database) to declare a schema and query it. The same code runs on [`@antelopejs/postgres`](https://github.com/AntelopeJS/postgres) and [`@antelopejs/mongodb`](https://github.com/AntelopeJS/mongodb).

To use the driver directly instead, add `@antelopejs/interface-rethinkdb` and read its [documentation](https://interfaces.antelopejs.com/docs/rethinkdb/introduction).

## Storage layout

- Each schema is a RethinkDB database, and each schema table is a table in it. Every table has a `tenant_id` index that scopes it to one instance. The database also holds an `__instances__` table that records the instances of the schema.
- Each declared index `<name>` becomes a `<name>__i` index led by the instance. An index declared with `crossInstance: true` also gets an unprefixed `<name>` index for `CROSS_INSTANCE` queries. Without that index, those queries scan the table and log a warning once per index. Initialization refuses a declared index whose name ends in `__i`.
- The primary key is the `_id` field, which all instances of a table share. An insert of an `_id` that any instance already uses throws a `DuplicateKeyError` on `_id`.
- RethinkDB cannot enforce unique secondary indexes. Schema initialization refuses a table that declares an index with `unique: true`, and the error names the schema, the table, and the index.
- Schema initialization creates the missing databases, tables, and indexes. It makes up to five attempts, and it waits for the indexes before the schema accepts queries.

Initialization builds every missing index at boot, so a boot that adds indexes to a large table takes longer. The module never drops an index. Drop an index you no longer need by hand, for example `r.db("<schema>").table("<table>").indexDrop("<name>")`. [`CHANGELOG.md`](CHANGELOG.md) records when the index layout changed.

## Documentation

- [Database](https://interfaces.antelopejs.com/docs/database) documents `@antelopejs/interface-database`, which this module implements.
- [RethinkDB](https://interfaces.antelopejs.com/docs/rethinkdb/introduction) documents `@antelopejs/interface-rethinkdb`, which this module implements.
- [External mode](docs/external-mode.md) explains how the module serves a database it did not create, and what its catalog answers.
- [Configuration](https://framework.antelopejs.com/docs/concepts/configuration) documents module sources, `config` blocks, and config variables in `antelope.config.ts`.

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                                  | Supported        | Tested with |
| ---------------------------------------- | ---------------- | ----------- |
| `@antelopejs/interface-core`             | `>=0.2.4 <1.0.0` | `0.2.4`     |
| `@antelopejs/interface-database`         | `>=0.3.1 <0.4.0` | `0.3.1`     |
| `@antelopejs/interface-database-catalog` | `>=0.0.3 <0.1.0` | `0.0.3`     |
| `@antelopejs/interface-rethinkdb`        | `>=0.1.0 <0.2.0` | `0.1.0`     |

<!-- antelopejs-docs-compat:end -->

The repository pins its Node.js version in `.nvmrc`. The `rethinkdb-ts` range is in the `dependencies` of `package.json`. The RethinkDB image that the tests run against is in `.github/release-services.yml`.

## Contributing

The tests need a RethinkDB server on `127.0.0.1:28015`. Start the one CI uses:

```bash
docker compose -f .github/release-services.yml up -d --wait
```

Then run the checks:

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm knip
pnpm test           # build, then the owned and external-mode suites
```

The tests also run the shared conformance suites of `@antelopejs/interface-database`. Read the [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE)
