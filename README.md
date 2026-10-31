# @antelopejs/rethinkdb

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/rethinkdb"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/rethinkdb?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/rethinkdb?style=for-the-badge&labelColor=000000&color=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://interfaces.antelopejs.com/docs/database"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

The RethinkDB backend of AntelopeJS: it runs the database interface's queries on RethinkDB with [`rethinkdb-ts`](https://github.com/rethinkdb/rethinkdb-ts), and exposes that driver to modules that need it directly.

## Interfaces

| Interface                                                                                            | Documentation                                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`@antelopejs/interface-database`](https://github.com/AntelopeJS/interface-database)                 | [Database](https://interfaces.antelopejs.com/docs/database)                |
| [`@antelopejs/interface-rethinkdb`](https://github.com/AntelopeJS/interface-rethinkdb)               | [RethinkDB](https://interfaces.antelopejs.com/docs/rethinkdb/introduction) |
| [`@antelopejs/interface-database-catalog`](https://github.com/AntelopeJS/interface-database-catalog) | [External mode](docs/external-mode.md#the-catalog)                         |

Schemas, tables, queries, change feeds and atomic mutations are documented on the database interface pages.

## Install

```bash
ajs project modules add @antelopejs/rethinkdb
```

The command writes the module's default configuration: a connection pool to `127.0.0.1:28015` as `admin`.

## Configuration

The module connects either through a connection pool (`pool`) or through a single connection (`connection`). When both are set, `pool` wins.

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

| Key                  | Description                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pool`               | `rethinkdb-ts` pool options (`RPoolConnectionOptions`), passed to `r.connectPool()`.                                                                                                      |
| `connection`         | `rethinkdb-ts` connection options (`RConnectionOptions`), passed to `r.connect()`. Used when `pool` is unset.                                                                             |
| `url`                | `rethinkdb://user:password@host:port/database`, parsed into pool options. Required in external mode.                                                                                      |
| `mode`               | `owned` (default): the module creates a database per schema and scopes rows to instances. `external`: it serves a database it did not create, see [External mode](docs/external-mode.md). |
| `statementTimeoutMs` | Time limit of each read of an external instance, enforced by closing that read's connection.                                                                                              |
| `catalog`            | `{ enabled?: boolean }`: whether an external instance answers the catalog outside development.                                                                                            |

The module refuses to start when none of `url`, `pool` and `connection` is set. The option types come from [`rethinkdb-ts`](https://github.com/rethinkdb/rethinkdb-ts).

## Quick start

In the module that stores data, add the database interface:

```bash
pnpm add @antelopejs/interface-database
```

Then follow the [database interface guide](https://framework.antelopejs.com/docs/guides/database) to declare a schema and query it. The same code runs on [`@antelopejs/mongodb`](https://github.com/AntelopeJS/mongodb).

To use the driver directly instead, add `@antelopejs/interface-rethinkdb` and read its [documentation](https://interfaces.antelopejs.com/docs/rethinkdb/introduction).

## Storage layout

- Each schema is a RethinkDB database, and each schema table is a table in it. Every table has a `tenant_id` index that scopes it to one instance.
- Each declared index `<name>` becomes a `<name>__i` index led by the instance. An index declared with `crossInstance: true` also gets an unprefixed `<name>` index for `CROSS_INSTANCE` queries; without it, those queries scan the table and log a one-time warning. Index names ending in `__i` are reserved.
- The primary key is the `_id` field, shared by all instances of a table: inserting an `_id` that any instance already uses throws a `DuplicateKeyError` on `_id`.
- RethinkDB cannot enforce unique secondary indexes, so schema initialization refuses a table that declares an index with `unique: true` and names the schema, table and index.
- Schema initialization creates missing databases, tables and indexes, retries up to five times, and waits for the indexes before the schema accepts queries.

Version 1.4 added the `<name>__i` indexes. The first boot after an upgrade builds them, which takes longer on large tables. The module never drops an index: drop the old ones you no longer need by hand, for example `r.db("<schema>").table("<table>").indexDrop("<name>")`.

## Documentation

- [Database](https://interfaces.antelopejs.com/docs/database): the `@antelopejs/interface-database` contract this module implements
- [RethinkDB](https://interfaces.antelopejs.com/docs/rethinkdb/introduction): the `@antelopejs/interface-rethinkdb` contract this module implements
- [External mode](docs/external-mode.md): serving a database the module did not create, and its catalog
- [Configuration](https://framework.antelopejs.com/docs/concepts/configuration): module sources, `config` blocks and config variables in `antelope.config.ts`

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                                  | Supported                                                      | Tested with                                                    |
| ---------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `@antelopejs/interface-core`             | `>=0.2.4 <1.0.0`                                               | `0.2.4`                                                        |
| `@antelopejs/interface-database`         | `file:.campaign/tgz/antelopejs-interface-database-6bef278.tgz` | `file:.campaign/tgz/antelopejs-interface-database-6bef278.tgz` |
| `@antelopejs/interface-database-catalog` | `>=0.0.3 <0.1.0`                                               | `0.0.3`                                                        |
| `@antelopejs/interface-rethinkdb`        | `>=0.1.0 <0.2.0`                                               | `0.1.0`                                                        |

<!-- antelopejs-docs-compat:end -->

The module is developed and tested on Node.js 24, with `rethinkdb-ts` `^2.7.0` and RethinkDB 2.4.

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
pnpm test           # build, then ajs module test
```

The tests also run the shared conformance suite of `@antelopejs/interface-database`. Read the [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE)
