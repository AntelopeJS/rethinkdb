import { mock } from "node:test";
import assert from "node:assert/strict";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import {
  CROSS_INSTANCE,
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database";

import { Logger } from "../utils/logger";
import { executeTermJson } from "../connection";
import { Schemas } from "../implementations/database/schema";
import { SelectionQuery } from "../implementations/database/selection";
import {
  DecodingContext,
  type QueryStage,
} from "../implementations/database/utils";
import {
  ensureDatabase,
  InitializeSchemaDatabase,
  retryWithBackoff,
} from "../implementations/database/initialize";

type IndexValue = string | number | Array<string | number> | undefined;

interface Item {
  [field: string]: IndexValue;
  _id: string;
  status?: string;
  rank?: number;
  tags?: string[] | string;
  category?: string;
}

interface Tables {
  items: Item;
}

interface Selectable {
  build(): QueryStage[];
}

const SCHEMA_ID = "test-instance-indexes";
const CONCURRENT_SCHEMA_ID = "test-instance-indexes-concurrent";
const CONCURRENT_BOOTS = 4;
const SLOW_TEST_TIMEOUT_MS = 30000;
const TABLE = "items";
const DEFINITION: SchemaDefinition = {
  items: {
    fields: { status: "string", rank: "number", tags: ["string"] },
    indexes: {
      status: {},
      status_rank: { fields: ["status", "rank"] },
      tags: { multi: true },
      category: { crossInstance: true },
    },
  },
};
const DOCUMENTS: Record<string, Item[]> = {
  alpha: [
    {
      _id: "a1",
      status: "open",
      rank: 1,
      tags: ["red", "red", "blue"],
      category: "x",
    },
    { _id: "a2", status: "open", rank: 2, tags: ["blue"], category: "y" },
    { _id: "a3", status: "closed", rank: 3, tags: "red", category: "x" },
    { _id: "a4", rank: 4 },
  ],
  beta: [
    { _id: "b1", status: "open", rank: 1, tags: ["red"], category: "x" },
    { _id: "b2", status: "closed", rank: 2, category: "y" },
  ],
};

const db: TermJson = [TermType.DB, [SCHEMA_ID]];
const table: TermJson = [TermType.TABLE, [db, TABLE]];
let schema: Schema<Tables>;

function compoundKey(...values: Array<string | number>): string {
  return values as never;
}

function list(...values: TermJson[]): TermJson {
  return [TermType.MAKE_ARRAY, values];
}

function field(name: string): TermJson {
  return [TermType.BRACKET, [[TermType.VAR, [0]], name]];
}

function ids(documents: Item[]): string[] {
  return documents.map((document) => document._id).sort();
}

function buildTerm(query: Selectable): TermJson {
  return SelectionQuery.buildTermJson(query.build(), new DecodingContext());
}

async function dropDatabase(name: string) {
  const databases: string[] = await executeTermJson([TermType.DB_LIST, []]);
  if (databases.includes(name)) {
    await executeTermJson([TermType.DB_DROP, [name]]);
  }
}

async function createLegacyIndexes() {
  await executeTermJson([TermType.DB_CREATE, [SCHEMA_ID]]);
  await executeTermJson([
    TermType.TABLE_CREATE,
    [db, TABLE],
    { primary_key: "_id" },
  ]);
  const compound = [
    TermType.FUNC,
    [list(0), list(field("status"), field("rank"))],
  ];
  await executeTermJson([TermType.INDEX_CREATE, [table, "status"]]);
  await executeTermJson([
    TermType.INDEX_CREATE,
    [table, "status_rank", compound],
  ]);
  await executeTermJson([
    TermType.INDEX_CREATE,
    [table, "tags"],
    { multi: true },
  ]);
  await executeTermJson([TermType.INDEX_CREATE, [table, "tenant_id"]]);
}

async function legacyScoped(
  tenantId: string,
  selection: TermJson,
): Promise<string[]> {
  return ids(
    await executeTermJson([
      TermType.FILTER,
      [selection, { tenant_id: tenantId }],
    ]),
  );
}

async function legacyCross(selection: TermJson): Promise<string[]> {
  return ids(await executeTermJson(selection));
}

function legacyGetAll(index: string, ...keys: TermJson[]): TermJson {
  return [TermType.GET_ALL, [table, ...keys], { index }];
}

function legacyBetween(index: string, low: TermJson, high: TermJson): TermJson {
  return [TermType.BETWEEN, [table, low, high], { index }];
}

describe("Instance-prefixed indexes", function () {
  this.timeout(SLOW_TEST_TIMEOUT_MS);
  before(async () => {
    await dropDatabase(SCHEMA_ID);
    await createLegacyIndexes();
    await Schemas.register(SCHEMA_ID, DEFINITION);
    schema = new Schema<Tables>(SCHEMA_ID, DEFINITION);
    for (const [instanceId, documents] of Object.entries(DOCUMENTS)) {
      await schema.createInstance(instanceId).run();
      await schema.instance(instanceId).table(TABLE).insert(documents).run();
    }
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    await dropDatabase(SCHEMA_ID);
    await dropDatabase(CONCURRENT_SCHEMA_ID);
  });
  it(
    "adds instance-prefixed indexes to a table with legacy indexes",
    upgradeLegacyTable,
  );
  it("uses the instance-prefixed index for scoped getAll", scopedGetAllTerm);
  it("keeps scoped getAll results", scopedGetAllResults);
  it("keeps scoped multi-index getAll results", scopedMultiGetAll);
  it("keeps scoped between results", scopedBetween);
  it("keeps scoped orderBy unindexed", scopedOrderBy);
  it("uses the unprefixed index for crossInstance indexes", crossInstanceIndex);
  it(
    "warns once per index for unindexed cross-instance reads",
    crossInstanceWarning,
  );
  it(
    "scans other indexes across instances with the same results",
    crossInstanceScan,
  );
  it(
    "creates the database and indexes from concurrent boots",
    concurrentInitialization,
  );
  it("retries schema initialization with a bound", boundedRetry);
});

async function upgradeLegacyTable() {
  const indexes: string[] = await executeTermJson([
    TermType.INDEX_LIST,
    [table],
  ]);
  assert.deepEqual(indexes.sort(), [
    "category",
    "category__i",
    "status",
    "status__i",
    "status_rank",
    "status_rank__i",
    "tags",
    "tags__i",
    "tenant_id",
  ]);
  const statuses: Array<{ ready: boolean }> = await executeTermJson([
    TermType.INDEX_STATUS,
    [table],
  ]);
  assert.ok(statuses.every((status) => status.ready));
}

async function scopedGetAllTerm() {
  const items = schema.instance("alpha").table(TABLE);
  assert.deepEqual(buildTerm(items.getAll("open", "status")), [
    TermType.GET_ALL,
    [table, list("alpha", "open")],
    { index: "status__i" },
  ]);
  assert.deepEqual(
    buildTerm(items.getAll([compoundKey("open", 1)], "status_rank")),
    [
      TermType.GET_ALL,
      [table, [TermType.PREPEND, [list("open", 1), "alpha"]]],
      { index: "status_rank__i" },
    ],
  );
}

async function scopedGetAllResults() {
  for (const tenantId of Object.keys(DOCUMENTS)) {
    const items = schema.instance(tenantId).table(TABLE);
    assert.deepEqual(
      ids(await items.getAll(["open", "closed"], "status").run()),
      await legacyScoped(tenantId, legacyGetAll("status", "open", "closed")),
    );
    assert.deepEqual(
      ids(await items.getAll([compoundKey("open", 2)], "status_rank").run()),
      await legacyScoped(
        tenantId,
        legacyGetAll("status_rank", list("open", 2)),
      ),
    );
  }
}

async function scopedMultiGetAll() {
  const items = schema.instance("alpha").table(TABLE);
  for (const keys of [["red"], ["blue"], ["red", "blue"]]) {
    assert.deepEqual(
      ids(await items.getAll(keys, "tags").run()),
      await legacyScoped("alpha", legacyGetAll("tags", ...keys)),
    );
  }
  assert.deepEqual(ids(await items.getAll("red", "tags").run()), [
    "a1",
    "a1",
    "a3",
  ]);
}

async function scopedBetween() {
  const items = schema.instance("alpha").table(TABLE);
  assert.deepEqual(
    ids(await items.between("status", "closed", "open").run()),
    await legacyScoped("alpha", legacyBetween("status", "closed", "open")),
  );
  assert.deepEqual(
    ids(await items.between("status_rank", ["open", 1], ["open", 2]).run()),
    await legacyScoped(
      "alpha",
      legacyBetween("status_rank", list("open", 1), list("open", 2)),
    ),
  );
  assert.deepEqual(
    ids(await items.between("tags", "a", "c").run()),
    await legacyScoped("alpha", legacyBetween("tags", "a", "c")),
  );
}

async function scopedOrderBy() {
  const items = schema.instance("alpha").table(TABLE);
  const term = JSON.stringify(buildTerm(items.orderBy("status")));
  assert.ok(!term.includes("status__i"));
  const ordered: Item[] = await items.orderBy("status").run();
  assert.deepEqual(
    ordered.slice(0, 2).map((item) => item._id),
    ["a4", "a3"],
  );
  assert.deepEqual(ids(ordered.slice(2)), ["a1", "a2"]);
}

async function crossInstanceIndex() {
  const items = schema.instance(CROSS_INSTANCE).table(TABLE);
  const warn = mock.method(Logger, "Warn", () => undefined);
  assert.deepEqual(buildTerm(items.getAll("x", "category")), [
    TermType.GET_ALL,
    [table, "x"],
    { index: "category" },
  ]);
  assert.deepEqual(ids(await items.getAll("x", "category").run()), [
    "a1",
    "a3",
    "b1",
  ]);
  assert.deepEqual(ids(await items.between("category", "x", "z").run()), [
    "a1",
    "a2",
    "a3",
    "b1",
    "b2",
  ]);
  assert.equal(warn.mock.callCount(), 0);
}

async function crossInstanceScan() {
  mock.method(Logger, "Warn", () => undefined);
  const items = schema.instance(CROSS_INSTANCE).table(TABLE);
  assert.deepEqual(
    ids(await items.getAll(["open", "closed"], "status").run()),
    await legacyCross(legacyGetAll("status", "open", "closed")),
  );
  assert.deepEqual(
    ids(await items.getAll([compoundKey("open", 1)], "status_rank").run()),
    await legacyCross(legacyGetAll("status_rank", list("open", 1))),
  );
  assert.deepEqual(
    ids(await items.between("status", "closed", "open").run()),
    await legacyCross(legacyBetween("status", "closed", "open")),
  );
  assert.deepEqual(ids(await items.getAll("blue", "tags").run()), ["a1", "a2"]);
  assert.deepEqual(ids(await items.getAll("red", "tags").run()), [
    "a1",
    "a3",
    "b1",
  ]);
  const ordered: Item[] = await items.orderBy("status").run();
  assert.deepEqual(
    ordered.map((item) => item.status),
    [undefined, "closed", "closed", "open", "open", "open"],
  );
}

async function crossInstanceWarning() {
  const warn = mock.method(Logger, "Warn", () => undefined);
  const items = schema.instance(CROSS_INSTANCE).table(TABLE);
  buildTerm(items.getAll("open", "status"));
  buildTerm(items.between("status", "a", "z"));
  buildTerm(items.orderBy("status"));
  buildTerm(items.filter((item) => item.key("status").eq("open")));
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /index 'status'/);
  buildTerm(items.orderBy("status_rank"));
  assert.equal(warn.mock.callCount(), 2);
}

function runConcurrently(boot: () => Promise<unknown>) {
  return Promise.all(Array.from({ length: CONCURRENT_BOOTS }, boot));
}

async function concurrentInitialization() {
  await dropDatabase(CONCURRENT_SCHEMA_ID);
  await runConcurrently(() => ensureDatabase(CONCURRENT_SCHEMA_ID));
  const tablesOnly: SchemaDefinition = {
    [TABLE]: { ...DEFINITION[TABLE], indexes: {} },
  };
  await InitializeSchemaDatabase(CONCURRENT_SCHEMA_ID, tablesOnly);
  await runConcurrently(() =>
    InitializeSchemaDatabase(CONCURRENT_SCHEMA_ID, DEFINITION),
  );
  const concurrentTable: TermJson = [
    TermType.TABLE,
    [[TermType.DB, [CONCURRENT_SCHEMA_ID]], TABLE],
  ];
  const indexes: string[] = await executeTermJson([
    TermType.INDEX_LIST,
    [concurrentTable],
  ]);
  assert.deepEqual(indexes.sort(), [
    "category",
    "category__i",
    "status__i",
    "status_rank__i",
    "tags__i",
    "tenant_id",
  ]);
}

async function boundedRetry() {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("transient");
    }
    return calls;
  };
  mock.method(Logger, "Warn", () => undefined);
  assert.equal(await retryWithBackoff(flaky), 2);
  let failures = 0;
  const broken = async () => {
    failures += 1;
    throw new Error("permanent");
  };
  await assert.rejects(retryWithBackoff(broken, 2), /permanent/);
  assert.equal(failures, 2);
}
