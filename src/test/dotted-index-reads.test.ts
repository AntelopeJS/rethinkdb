import { mock } from "node:test";
import assert from "node:assert/strict";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database";

import { Logger } from "../utils/logger";

interface Article {
  _id: string;
  meta: { sku: string; shelf: string };
  tags: string[];
}

const SCHEMA_ID = "test-dotted-index-reads";
const TABLE = "articles";
const INSTANCES = ["north", "south"];
const SCHEMA_BUILD_TIMEOUT_MS = 20_000;

const schema = new Schema<{ [TABLE]: Article }>(SCHEMA_ID, {
  [TABLE]: {
    fields: { meta: { sku: "string", shelf: "string" }, tags: ["string"] },
    indexes: {
      "meta.sku": { crossInstance: true },
      shelf: { fields: ["meta.shelf"], crossInstance: true },
      "meta.shelf": {},
      meta: { fields: ["meta.shelf"] },
      tag: { fields: ["tags"], multi: true },
    },
  },
});

function articles(instanceId: Parameters<typeof schema.instance>[0]) {
  return schema.instance(instanceId).table(TABLE);
}

function sortedText(values: unknown[]): string[] {
  return values.map(String).sort();
}

function ids(documents: Article[]): string[] {
  return documents.map((document) => document._id).sort();
}

describe("Dotted index reads", () => {
  before(async function () {
    this.timeout(SCHEMA_BUILD_TIMEOUT_MS);
    for (const [position, instanceId] of INSTANCES.entries()) {
      await schema.createInstance(instanceId).run();
      await articles(instanceId).delete().run();
      await articles(instanceId)
        .insert([
          {
            _id: `${instanceId}-1`,
            meta: { sku: `SKU-${position}`, shelf: "top" },
            tags: ["red", "blue"],
          },
          {
            _id: `${instanceId}-2`,
            meta: { sku: `SKU-${position + 2}`, shelf: "low" },
            tags: ["blue"],
          },
        ])
        .run();
    }
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    for (const instanceId of INSTANCES) {
      await articles(instanceId).delete().run();
      await schema.destroyInstance(instanceId).run();
    }
  });

  it(
    "reads a crossInstance index named by a dotted path at its nested value, not a top-level key named meta.sku",
    CrossInstanceDottedName,
  );
  it(
    "reads a crossInstance index of one dotted field with a scalar key, not a one-element tuple",
    CrossInstanceOneDottedField,
  );
  it(
    "scans a dotted index across instances at its nested value, not skipping every row as missing the field",
    CrossInstanceDottedScan,
  );
  it(
    "reads each element of a multi index of one field, not the whole list as a single entry",
    ScopedMultiOneField,
  );
});

async function CrossInstanceDottedName() {
  const all = articles(CROSS_INSTANCE);

  assert.deepEqual(ids(await all.getAll("SKU-1", "meta.sku").run()), [
    "south-1",
  ]);
}

async function CrossInstanceOneDottedField() {
  const all = articles(CROSS_INSTANCE);

  assert.deepEqual(ids(await all.getAll("low", "shelf").run()), [
    "north-2",
    "south-2",
  ]);
}

async function CrossInstanceDottedScan() {
  mock.method(Logger, "Warn", () => undefined);
  const all = articles(CROSS_INSTANCE);

  assert.deepEqual(sortedText(await all.distinct("meta").run()), [
    "low",
    "top",
  ]);
  assert.deepEqual(ids(await all.getAll("top", "meta.shelf").run()), [
    "north-1",
    "south-1",
  ]);
}

async function ScopedMultiOneField() {
  assert.deepEqual(ids(await articles("north").getAll("red", "tag").run()), [
    "north-1",
  ]);
}
