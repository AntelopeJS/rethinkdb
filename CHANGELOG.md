# Changelog

## v1.1.0

[compare changes](https://github.com/AntelopeJS/rethinkdb/compare/v1.0.0...v1.1.0)

### 🚀 Enhancements

- ⚠️  Per-table tenant scoping with shared physical stores ([#15](https://github.com/AntelopeJS/rethinkdb/pull/15))

### 🏡 Chore

- Update package.json ([5873032](https://github.com/AntelopeJS/rethinkdb/commit/5873032))
- Update dependencies ([2b18a04](https://github.com/AntelopeJS/rethinkdb/commit/2b18a04))

#### ⚠️ Breaking Changes

- ⚠️  Per-table tenant scoping with shared physical stores ([#15](https://github.com/AntelopeJS/rethinkdb/pull/15))

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
