import assert from "node:assert/strict";
import { CROSS_INSTANCE } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "lookup-keys";
const INSTANCE = "a";

interface Product {
  _id: string;
  name: string;
  sku: string;
}

interface Bundle {
  _id: string;
  productIds: string[];
  skus: string[];
  productId: string;
}

const schema = new Schema<{ products: Product; bundles: Bundle }>(SCHEMA_ID, {
  products: {
    fields: { name: "string", sku: "string" },
    indexes: { sku: { crossInstance: true } },
  },
  bundles: {
    fields: { productIds: "string[]", skus: "string[]", productId: "string" },
    indexes: {},
  },
});

const PRODUCTS: Product[] = [
  { _id: "p1", name: "Atlas", sku: "s1" },
  { _id: "p2", name: "Brace", sku: "s2" },
  { _id: "p3", name: "Cable", sku: "s3" },
];

const BUNDLE: Bundle = {
  _id: "b1",
  productIds: ["p3", "p1"],
  skus: ["s3", "s1"],
  productId: "p2",
};

function Names(products: Product[] | undefined): string[] {
  assert.ok(products);
  return products.map((product) => product.name).sort();
}

describe("lookup of a field holding a list of keys", () => {
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    const db = schema.instance(INSTANCE);
    await db.table("products").insert(PRODUCTS).run();
    await db.table("bundles").insert(BUNDLE).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("replaces the list with the documents of an instance's table", async () => {
    const db = schema.instance(INSTANCE);
    const [bundle] = await db
      .table("bundles")
      .lookup(db.table("products"), "productIds", "_id")
      .run();
    assert.deepEqual(Names(bundle?.productIds), ["Atlas", "Cable"]);
  });

  it("replaces the list with the documents a cross-instance index finds", async () => {
    const db = schema.instance(CROSS_INSTANCE);
    const [bundle] = await db
      .table("bundles")
      .lookup(db.table("products"), "skus", "sku")
      .run();
    assert.deepEqual(Names(bundle?.skus), ["Atlas", "Cable"]);
  });

  it("still replaces a single key with its document", async () => {
    const db = schema.instance(INSTANCE);
    const [bundle] = await db
      .table("bundles")
      .lookup(db.table("products"), "productId", "_id")
      .run();
    assert.equal(bundle?.productId.name, "Brace");
  });
});
