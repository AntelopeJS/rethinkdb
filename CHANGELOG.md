# Changelog

## Unreleased

### ⚠️ Upgrade notes

- **Breaking in 1.9.0:** an index with one `fields` entry now reads that field's value, not a one-element tuple. `getAll`, `between` and `lookup` on it take the value itself as the key, so a caller that passed `["red"]` must now pass `"red"`. A `multi` index of one field indexes each element of the list ([#103](https://github.com/AntelopeJS/rethinkdb/pull/103)).
- Implements `@antelopejs/interface-database` `>=0.3.3 <0.4.0`. A dotted index field, index name, `orderBy` name or lookup key reads a nested path: `"title.fr"` reads `fr` inside `title`, not a top-level key named `title.fr`. This holds in owned mode; external mode keeps its own index matching ([#103](https://github.com/AntelopeJS/rethinkdb/pull/103)).
- The first boot after the upgrade rebuilds three kinds of index whose stored function changed: an index whose name or `fields` entry is dotted, a `crossInstance` index with one `fields` entry, and a `multi` index with one `fields` entry. Each one is built under `<name>__rebuild` and swapped in when ready, so it keeps answering reads during the build. Boot waits for these builds; on a large table that takes as long as creating the index. Every other index is kept, and no `indexDrop` is needed ([#105](https://github.com/AntelopeJS/rethinkdb/pull/105)).
- From now on, boot rebuilds any declared index whose stored function or `multi` flag differs from its definition, and logs `Index '<name>' was built from another definition; rebuilding it` ([#105](https://github.com/AntelopeJS/rethinkdb/pull/105)).
- During a rolling deploy, 1.x replicas still running read the rebuilt indexes with their old keys, so their reads on these three kinds return no rows until they are replaced ([#105](https://github.com/AntelopeJS/rethinkdb/pull/105)).
- Index names ending in `__rebuild` are now reserved, like `__i`, and schema initialization rejects them. Rename such an index before upgrading ([#105](https://github.com/AntelopeJS/rethinkdb/pull/105)).

## v1.8.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.7.2...v1.8.0)

### 🔥 Performance

- **connection:** Stop building a query backtrace on every query ([#100](https://github.com/AntelopeJS/rethinkdb/pull/100))
- **external:** Reuse the connections of bounded reads that finish in time ([#101](https://github.com/AntelopeJS/rethinkdb/pull/101))

### 📖 Documentation

- **verify:** Add the features index the verify-module skill points to ([#98](https://github.com/AntelopeJS/rethinkdb/pull/98))

### 📦 Build

- **deps:** Bump @antelopejs/tooling-configs to 0.5.0 ([#97](https://github.com/AntelopeJS/rethinkdb/pull/97))
- **deps:** Bump @antelopejs/tooling-configs to 0.5.1 ([#99](https://github.com/AntelopeJS/rethinkdb/pull/99))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v1.7.2

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.7.1...v1.7.2)

### 🔥 Performance

- **verify:** Seed the client database with concurrent queries ([#90](https://github.com/AntelopeJS/rethinkdb/pull/90))

### 🩹 Fixes

- **database:** Read an update as a function only by the recorded func shape ([#91](https://github.com/AntelopeJS/rethinkdb/pull/91))
- **stream:** Give each row the key fallback for a null or missing field ([#93](https://github.com/AntelopeJS/rethinkdb/pull/93))
- **schema:** Keep a refused registration in the schema gate instead of rejecting ([#95](https://github.com/AntelopeJS/rethinkdb/pull/95))
- **database:** Resolve insert to the provided and generated keys ([#92](https://github.com/AntelopeJS/rethinkdb/pull/92))
- **lookup:** Read each key of a field holding a list of keys ([#94](https://github.com/AntelopeJS/rethinkdb/pull/94))

### 📦 Build

- **deps:** Bump @antelopejs/tooling-configs to 0.4.0 ([#96](https://github.com/AntelopeJS/rethinkdb/pull/96))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v1.7.1

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.7.0...v1.7.1)

### 📦 Build

- **deps:** Bump @antelopejs packages to the 2026-11-06 releases ([#88](https://github.com/AntelopeJS/rethinkdb/pull/88))
- **deps:** Bump @antelopejs packages to the 2026-11-06 releases ([#89](https://github.com/AntelopeJS/rethinkdb/pull/89))

### 🏡 Chore

- **verify:** Remove seeded runs from the verification skill ([#85](https://github.com/AntelopeJS/rethinkdb/pull/85))
- **ci:** Remove the weekly mutation caller ([#86](https://github.com/AntelopeJS/rethinkdb/pull/86))

### 🤖 CI

- Call ci-node.yml@v1 ([#87](https://github.com/AntelopeJS/rethinkdb/pull/87))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v1.7.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.6.1...v1.7.0)

### 🏡 Chore

- Land the cleanup campaign on main ([#83](https://github.com/AntelopeJS/rethinkdb/pull/83))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v1.6.1

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.6.0...v1.6.1)

### 📖 Documentation

- **readme:** List PostgreSQL as a backend that runs the same code ([#70](https://github.com/AntelopeJS/rethinkdb/pull/70))
- **readme:** Use one Discord invite ([#66](https://github.com/AntelopeJS/rethinkdb/pull/66))
- **github:** Send questions and ideas to Discord ([#76](https://github.com/AntelopeJS/rethinkdb/pull/76))
- **readme:** Link the package to AntelopeJS and AntelopeJS DMS ([723af1c](https://github.com/AntelopeJS/rethinkdb/commit/723af1c))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v1.6.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.5.0...v1.6.0)

### 🚀 Enhancements

- External mode and the database catalog ([#45](https://github.com/AntelopeJS/rethinkdb/pull/45))

### 🩹 Fixes

- **deps:** Cap @antelopejs/interface-rethinkdb below 0.1.0 ([#43](https://github.com/AntelopeJS/rethinkdb/pull/43))

### 💅 Refactors

- Clean the repo with the guardrail pack ([#46](https://github.com/AntelopeJS/rethinkdb/pull/46))
- Clear the residual ratchet findings ([#50](https://github.com/AntelopeJS/rethinkdb/pull/50))
- Narrow primitive values without constructor comparisons ([#52](https://github.com/AntelopeJS/rethinkdb/pull/52))

### 📖 Documentation

- **changelog:** Upgrade notes of rethinkdb 1.5.0 ([#40](https://github.com/AntelopeJS/rethinkdb/pull/40))
- **readme:** Align the compatibility table with package.json ranges ([#44](https://github.com/AntelopeJS/rethinkdb/pull/44))

### 📦 Build

- **deps:** Adopt @antelopejs/interface-rethinkdb 0.1.0 ([#49](https://github.com/AntelopeJS/rethinkdb/pull/49))
- **deps:** Adopt @antelopejs/interface-database 0.2.0 ([#48](https://github.com/AntelopeJS/rethinkdb/pull/48))
- **deps:** Bump @antelopejs/tooling-configs to 0.2.17 ([#53](https://github.com/AntelopeJS/rethinkdb/pull/53))

### 🏡 Chore

- Adopt the guardrail pack from tooling-configs 0.2.0 ([#41](https://github.com/AntelopeJS/rethinkdb/pull/41))
- Configure Renovate with the shared preset ([#42](https://github.com/AntelopeJS/rethinkdb/pull/42))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))
- Thomas ([@Thomasims](http://github.com/Thomasims))

## v1.5.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.4.1...v1.5.0)

### Upgrade notes

- Implements `@antelopejs/interface-database` `>=0.1.11 <0.2.0` ([#39](https://github.com/AntelopeJS/rethinkdb/pull/39)).
- **Behavior change:** a duplicate primary key now throws `DuplicateKeyError("_id", ["_id"])` instead of a plain `Error`. `_id` is shared by every instance of a table, so an `_id` used by another instance is refused too.
- **Breaking for schemas with unique secondary indexes:** RethinkDB cannot enforce them, so schema initialization refuses a table declaring `unique: true` on a secondary index (the error names schema, table and index). Use MongoDB or PostgreSQL for such schemas.

### 🚀 Enhancements

- **errors:** Throw DuplicateKeyError on duplicate primary keys ([#39](https://github.com/AntelopeJS/rethinkdb/pull/39))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v1.4.1

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.4.0...v1.4.1)

### 📖 Documentation

- **readme:** Fix the outdated CLI commands in the README ([#34](https://github.com/AntelopeJS/rethinkdb/pull/34))
- Rewrite the README ([#36](https://github.com/AntelopeJS/rethinkdb/pull/36))
- **agents:** Simplify repository guidance ([#37](https://github.com/AntelopeJS/rethinkdb/pull/37))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v1.4.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.3.0...v1.4.0)

### ⚠️ Upgrade notes

- The first boot adds the `<name>__i` indexes to existing tables and waits until RethinkDB has built them.
- Unprefixed `<name>` indexes of indexes that are not declared `crossInstance` are no longer used. They are not dropped automatically; drop them by hand with `indexDrop("<name>")`.

### ⚠️ Behavior changes

- `CROSS_INSTANCE` `orderBy` on an index that is not declared `crossInstance` now also returns documents missing the sorted field.
- `CROSS_INSTANCE` `getAll`, `between` and `lookup` on an index that is not declared `crossInstance` return each matching document once, instead of once per matching key or `multi` entry.
- Scoped `getAll` and `between` with a scalar key on a compound index now fail with an error instead of returning no documents.

### 🚀 Enhancements

- **indexes:** Add tenant-prefixed indexes and use them for scoped queries ([#32](https://github.com/AntelopeJS/rethinkdb/pull/32))
- **indexes:** Every declared index gets an instance-prefixed `<name>__i` index. Scoped `getAll` and `between` use it instead of filtering the `tenant_id` index.
- **indexes:** Indexes declared with `crossInstance: true` also keep the unprefixed `<name>` index, used by `CROSS_INSTANCE` queries. Other `CROSS_INSTANCE` index reads scan the table and log a warning once per schema, table and index.
- **schema:** Initialization ignores "already exists" errors from concurrent boots, retries with backoff, and waits for the indexes it manages to be ready.
- **schema:** Index names ending with the reserved `__i` suffix are rejected at initialization.

### 📖 Documentation

- **readme:** Remove social card image ([#26](https://github.com/AntelopeJS/rethinkdb/pull/26))

### 🏡 Chore

- Align community files with the organization defaults ([#25](https://github.com/AntelopeJS/rethinkdb/pull/25))
- Remove .git-blame-ignore-revs ([#27](https://github.com/AntelopeJS/rethinkdb/pull/27))

### 🤖 CI

- Harden specialized npm release workflow ([#24](https://github.com/AntelopeJS/rethinkdb/pull/24))
- **release:** Release next from a dedicated branch and restore requireCommits ([#28](https://github.com/AntelopeJS/rethinkdb/pull/28))
- **release:** Use the shared release workflow with compose services ([#29](https://github.com/AntelopeJS/rethinkdb/pull/29))
- Start test services from the shared compose file ([#30](https://github.com/AntelopeJS/rethinkdb/pull/30))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v1.3.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.2.4...v1.3.0)

### 🚀 Enhancements

- **database:** Add atomic single-record mutations ([#23](https://github.com/AntelopeJS/rethinkdb/pull/23))

### 🏡 Chore

- Replace Biome with oxlint, oxfmt and Knip ([#22](https://github.com/AntelopeJS/rethinkdb/pull/22))

### 🤖 CI

- Standardize npm releases ([#21](https://github.com/AntelopeJS/rethinkdb/pull/21))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Thomas ([@Thomasims](http://github.com/Thomasims))

## v1.2.4

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.2.3...v1.2.4)

### 🩹 Fixes

- **runtime:** Support Core 1.5 interface packages ([#20](https://github.com/AntelopeJS/rethinkdb/pull/20))

### ❤️ Contributors

- Antony Rizzitelli <upd4ting@gmail.com>

## v1.2.3

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.2.2...v1.2.3)

### 🔥 Performance

- Use tenant_id index for tenant-scoped reads instead of full-table filter ([#19](https://github.com/AntelopeJS/rethinkdb/pull/19))

### ❤️ Contributors

- Fabrice Cst <fabrice@altab.be>

## v1.2.2

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.2.1...v1.2.2)

## v1.2.1

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.1.0...v1.2.1)

### 🚀 Enhancements

- Explicit instance lifecycle, CROSS_INSTANCE rename ([#16](https://github.com/AntelopeJS/rethinkdb/pull/16))

### ❤️ Contributors

- Thomas ([@Thomasims](http://github.com/Thomasims))

## v1.2.0

### 🚀 Enhancements

- ⚠️ Explicit instance lifecycle (`createInstance`, `destroyInstance`, `listInstances`) tracked via a `__instances__` table inside each schema's database.
- ⚠️ Rename `CROSS_TENANT` import to `CROSS_INSTANCE` (semantics unchanged: skip filter on read/update/delete, reject on insert/replace).

### 🏗️ Breaking Changes

- ⚠️ `tenantScoped` and `physicalStore` are no longer honored — every table is implicitly instance-scoped, every schema lives in its own database (`${schemaId}`).
- ⚠️ Strict instance validation: `instance(id).table(...)` rejects unless `createInstance(id)` was called first.

## v1.1.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.0.0...v1.1.0)

### 🚀 Enhancements

- ⚠️ Per-table tenant scoping with shared physical stores ([#15](https://github.com/AntelopeJS/rethinkdb/pull/15))

### 🏡 Chore

- Update package.json ([5873032](https://github.com/AntelopeJS/rethinkdb/commit/5873032))
- Update dependencies ([2b18a04](https://github.com/AntelopeJS/rethinkdb/commit/2b18a04))

#### ⚠️ Breaking Changes

- ⚠️ Per-table tenant scoping with shared physical stores ([#15](https://github.com/AntelopeJS/rethinkdb/pull/15))

### ❤️ Contributors

- Antony Rizzitelli <upd4ting@gmail.com>

## v1.0.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v0.1.2...v1.0.0)

### 🚀 Enhancements

- Add logging functionality to database connection and query execution ([#11](https://github.com/AntelopeJS/rethinkdb/pull/11))
- AQL2 query builder rewrite with modular architecture ([#13](https://github.com/AntelopeJS/rethinkdb/pull/13))
- Better group typing ([4bec429](https://github.com/AntelopeJS/rethinkdb/commit/4bec429))
- Support function-based .update() for expression-based field updates ([b50820f](https://github.com/AntelopeJS/rethinkdb/commit/b50820f))
- Add boolean to .getAll() key types ([58269b8](https://github.com/AntelopeJS/rethinkdb/commit/58269b8))
- Add union operation for streams ([8c2a22c](https://github.com/AntelopeJS/rethinkdb/commit/8c2a22c))
- Use Selection in lookup instead of Table ([b57cd6d](https://github.com/AntelopeJS/rethinkdb/commit/b57cd6d))
- **database:** Support conflict resolution options in table insert ([80b18d5](https://github.com/AntelopeJS/rethinkdb/commit/80b18d5))
- **database:** Support map and filter operations on array fields ([d054cd7](https://github.com/AntelopeJS/rethinkdb/commit/d054cd7))

### 🔥 Performance

- **database:** Use indexed orderBy when sorting on a table with a matching index ([aff781a](https://github.com/AntelopeJS/rethinkdb/commit/aff781a))

### 🩹 Fixes

- Datum.lookup ([99e3c83](https://github.com/AntelopeJS/rethinkdb/commit/99e3c83))
- **selection:** Decode args in get, getAll, and between stage handlers ([a1e8680](https://github.com/AntelopeJS/rethinkdb/commit/a1e8680))
- **selection:** Use query context for decoding args in read handlers ([ea9a41e](https://github.com/AntelopeJS/rethinkdb/commit/ea9a41e))
- **selection:** Use conditional return type for update callback overload ([4928f5d](https://github.com/AntelopeJS/rethinkdb/commit/4928f5d))
- **schema:** Preserve existing instances on re-registration ([e7864da](https://github.com/AntelopeJS/rethinkdb/commit/e7864da))
- Remove incorrect timezone parameter ([fcb675a](https://github.com/AntelopeJS/rethinkdb/commit/fcb675a))
- Mark singleElement with other reduction stages than nth ([a2a1a8e](https://github.com/AntelopeJS/rethinkdb/commit/a2a1a8e))
- Default localField in lookup to avoid errors ([9018526](https://github.com/AntelopeJS/rethinkdb/commit/9018526))
- Pass constant values as raw TermJson without decoding ([25f3bc4](https://github.com/AntelopeJS/rethinkdb/commit/25f3bc4))
- Avoid generating a GET_ALL on top of other stages ([312bcc0](https://github.com/AntelopeJS/rethinkdb/commit/312bcc0))
- Lookup: don't coerce to array before nth(0) ([6e4286e](https://github.com/AntelopeJS/rethinkdb/commit/6e4286e))
- Lookup: default to null to avoid error ([e72247e](https://github.com/AntelopeJS/rethinkdb/commit/e72247e))
- Resolve all lint warnings and migrate to biome ([#14](https://github.com/AntelopeJS/rethinkdb/pull/14))
- Lookup on single element queries ([2b4a9c1](https://github.com/AntelopeJS/rethinkdb/commit/2b4a9c1))

### 💅 Refactors

- Split boolean-option methods into dedicated variants ([550600e](https://github.com/AntelopeJS/rethinkdb/commit/550600e))
- Schema instance management for explicit control ([393e74f](https://github.com/AntelopeJS/rethinkdb/commit/393e74f))
- Align module structure with MongoDB conventions ([e22faa3](https://github.com/AntelopeJS/rethinkdb/commit/e22faa3))

### 📦 Build

- Replace rm -rf with rimraf ([#10](https://github.com/AntelopeJS/rethinkdb/pull/10))

### 🏡 Chore

- Remove ci publish adopt guidelines strict ts interface tests ([#12](https://github.com/AntelopeJS/rethinkdb/pull/12))
- Simplify CI workflow triggers and update AGENTS.md ([fbf8de9](https://github.com/AntelopeJS/rethinkdb/commit/fbf8de9))
- Generate exports ([fb1be39](https://github.com/AntelopeJS/rethinkdb/commit/fb1be39))
- Sync test with mongodb ([786b2e1](https://github.com/AntelopeJS/rethinkdb/commit/786b2e1))
- Migrate from local beta interfaces to published @antelopejs packages ([4e72cce](https://github.com/AntelopeJS/rethinkdb/commit/4e72cce))

### ✅ Tests

- Add multi-key .getAll() tests for index and primary key lookups ([f3443e1](https://github.com/AntelopeJS/rethinkdb/commit/f3443e1))
- Add getAll().orderBy() chaining test ([bac0eaf](https://github.com/AntelopeJS/rethinkdb/commit/bac0eaf))
- **database:** Add date operation query tests ([0765eaf](https://github.com/AntelopeJS/rethinkdb/commit/0765eaf))

### 🤖 CI

- Remove test:coverage step from CI workflow ([b3d9945](https://github.com/AntelopeJS/rethinkdb/commit/b3d9945))

### ❤️ Contributors

- Antony Rizzitelli <upd4ting@gmail.com>
- Thomasims <thomasims3@hotmail.fr>
- Fabrice Cst <fabrice@altab.be>
- Glastis ([@Glastis](http://github.com/Glastis))

## v0.1.2

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- Changelog generation is now using changelogen ([#8](https://github.com/AntelopeJS/rethinkdb/pull/8))

### 📦 Build

- Command 'build' that remove previous one before building ([#7](https://github.com/AntelopeJS/rethinkdb/pull/7))
- Update changelog config ([c7ad110](https://github.com/AntelopeJS/rethinkdb/commit/c7ad110))

### 🏡 Chore

- Update tsconfig.json paths ([15f46a0](https://github.com/AntelopeJS/rethinkdb/commit/15f46a0))

### 🤖 CI

- Add GitHub Workflow to validate interface export ([#9](https://github.com/AntelopeJS/rethinkdb/pull/9))

### ❤️ Contributors

- Antony Rizzitelli <upd4ting@gmail.com>
- Thomas ([@Thomasims](http://github.com/Thomasims))
- Fabrice Cst <fabrice@altab.be>
- Glastis ([@Glastis](http://github.com/Glastis))

## [0.1.1](https://github.com/AntelopeJS/rethinkdb/compare/v0.1.0...v0.1.1) (2025-07-28)

### Bug Fixes

- implementation and interface mismatch ([#6](https://github.com/AntelopeJS/rethinkdb/issues/6)) ([98a679d](https://github.com/AntelopeJS/rethinkdb/commit/98a679dc6d6eefb0bf007c09cf8009ef546b2442))

## [0.1.0](https://github.com/AntelopeJS/rethinkdb/compare/v0.0.1...v0.1.0) (2025-05-29)

### Features

- default config ([#4](https://github.com/AntelopeJS/rethinkdb/issues/4)) ([105fbc2](https://github.com/AntelopeJS/rethinkdb/commit/105fbc2761a9bbc5e6de12f117d253264a7be545))

## 0.0.1 (2025-05-08)
