import assert from "node:assert/strict";
import { r, type RDatum, type RQuery } from "rethinkdb-ts";
import {
  CROSS_INSTANCE,
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database";

import { InitializeSchemaDatabase } from "../implementations/database/initialize";
import { assertValidIndexNames } from "../implementations/database/indexes";
import { RunQuery } from "../implementations/rethinkdb";
import {
  allocateArgNumber,
  IsList,
  IsObject,
} from "../implementations/database/utils";

interface Article {
  _id: string;
  meta: { sku: string; shelf: string };
  tags: string[];
  color: string;
}

const SCHEMA_ID = "test-stale-index-rebuild";
const TABLE = "articles";
const INSTANCES = ["north", "south"];
const LONG_RUNNING_QUERIES = 1_000_000;
const DEFINITION: SchemaDefinition = {
  [TABLE]: {
    fields: {
      meta: { sku: "string", shelf: "string" },
      tags: ["string"],
      color: "string",
    },
    indexes: {
      "meta.sku": { crossInstance: true },
      shelf: { fields: ["meta.shelf"], crossInstance: true },
      tag: { fields: ["tags"], multi: true },
      color: { fields: ["color"] },
    },
  },
};

const schema = new Schema<{ [TABLE]: Article }>(SCHEMA_ID, DEFINITION);
const table = r.db(SCHEMA_ID).table(TABLE);

function articles(instanceId: Parameters<typeof schema.instance>[0]) {
  return schema.instance(instanceId).table(TABLE);
}

function ids(documents: Article[]): string[] {
  return documents.map((document) => document._id).sort();
}

async function replaceIndex(name: string, creation: RQuery) {
  const existing: unknown = await RunQuery(table.indexList());
  if (IsList(existing) && existing.includes(name)) {
    await RunQuery(table.indexDrop(name));
  }
  await RunQuery(creation);
  await RunQuery(table.indexWait(name));
}

function previousMultiFunction(row: RDatum) {
  const tags = r.expr([row("tags")]);
  return r
    .branch(tags.typeOf().eq("ARRAY"), tags, [tags])
    .map((entry) => [row("tenant_id"), entry]);
}

async function seedPreviousFunctions() {
  await replaceIndex("meta.sku", table.indexCreate("meta.sku"));
  await replaceIndex(
    "shelf",
    table.indexCreate("shelf", (row: RDatum) => r.expr([row("meta.shelf")])),
  );
  await replaceIndex(
    "tag__i",
    table.indexCreate("tag__i", previousMultiFunction, { multi: true }),
  );
  await replaceIndex(
    "tag__i__rebuild",
    table.indexCreate("tag__i__rebuild", previousMultiFunction, {
      multi: true,
    }),
  );
}

async function readDeclaredIndexes() {
  return {
    sku: ids(await articles(CROSS_INSTANCE).getAll("SKU-1", "meta.sku").run()),
    shelf: ids(await articles(CROSS_INSTANCE).getAll("low", "shelf").run()),
    tag: ids(await articles("north").getAll("red", "tag").run()),
  };
}

async function storedFunctions(): Promise<Map<unknown, unknown>> {
  const statuses: unknown = await RunQuery(table.indexStatus());
  assert.ok(IsList(statuses));
  return new Map(
    statuses.map((status) => {
      assert.ok(IsObject(status) && "index" in status && "function" in status);
      return [status.index, status.function];
    }),
  );
}

describe("Stale index rebuild", () => {
  before(async () => {
    for (const [position, instanceId] of INSTANCES.entries()) {
      await schema.createInstance(instanceId).run();
      await articles(instanceId).delete().run();
      await articles(instanceId)
        .insert([
          {
            _id: `${instanceId}-1`,
            meta: { sku: `SKU-${position}`, shelf: "top" },
            tags: ["red", "blue"],
            color: "green",
          },
          {
            _id: `${instanceId}-2`,
            meta: { sku: `SKU-${position + 2}`, shelf: "low" },
            tags: ["blue"],
            color: "grey",
          },
        ])
        .run();
    }
  });
  after(async () => {
    for (const instanceId of INSTANCES) {
      await articles(instanceId).delete().run();
      await schema.destroyInstance(instanceId).run();
    }
  });

  it(
    "rebuilds indexes stored with a previous function at boot, so reads answer as on a fresh database, not with the stale keys",
    RebuildsStaleIndexes,
  );
  it(
    "keeps indexes whose stored function matches their definition, a v1.8 index of one field included, not rebuilding them at every boot of a long-running process",
    KeepsCurrentIndexes,
  );
  it(
    "rejects a declared index ending with __rebuild, not letting a rebuild drop or overwrite it",
    RejectsRebuildSuffix,
  );
});

async function RebuildsStaleIndexes() {
  await seedPreviousFunctions();
  assert.deepEqual(await readDeclaredIndexes(), {
    sku: [],
    shelf: [],
    tag: [],
  });

  await InitializeSchemaDatabase(SCHEMA_ID, DEFINITION);

  assert.deepEqual(await readDeclaredIndexes(), {
    sku: ["south-1"],
    shelf: ["north-2", "south-2"],
    tag: ["north-1"],
  });
  assert.ok(!(await storedFunctions()).has("tag__i__rebuild"));
}

async function KeepsCurrentIndexes() {
  await InitializeSchemaDatabase(SCHEMA_ID, DEFINITION);
  await replaceIndex(
    "color__i",
    table.indexCreate("color__i", (row: RDatum) =>
      r.expr([row("color")]).prepend(row("tenant_id")),
    ),
  );
  const before = await storedFunctions();
  for (let query = 0; query < LONG_RUNNING_QUERIES; query++) {
    allocateArgNumber();
  }

  await InitializeSchemaDatabase(SCHEMA_ID, DEFINITION);

  assert.deepEqual(await storedFunctions(), before);
  assert.deepEqual(
    ids(await articles("north").getAll("green", "color").run()),
    ["north-1"],
  );
}

function RejectsRebuildSuffix() {
  assert.throws(
    () =>
      assertValidIndexNames({
        [TABLE]: { fields: {}, indexes: { shelf__rebuild: {} } },
      }),
    /reserved suffix '__rebuild'/,
  );
}
