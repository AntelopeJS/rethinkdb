import assert from "node:assert/strict";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

interface Product {
  _id: string;
  name: string;
  note: string | null;
  color: string;
}

const schema = new Schema<{ products: Product }>("key-fallback", {
  products: {
    fields: { name: "string", note: "string", color: "string" },
    indexes: {},
  },
});

function Products() {
  return schema.instance(INSTANCE).table("products");
}

describe("key with a fallback", () => {
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Products()
      .insert([
        { _id: "p1", name: "Atlas" },
        { _id: "p2", name: "Bible", note: null },
        { _id: "p3", name: "Codex", note: "kept" },
      ])
      .run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("gives each row of a stream the fallback for a null or missing field", async () => {
    const notes = await Products().key("note", "none");
    assert.deepEqual([...notes].sort(), ["kept", "none", "none"]);
  });

  it("gives each row of a stream the fallback for a field no row has", async () => {
    const colors = await Products().key("color", "plain");
    assert.deepEqual([...colors].sort(), ["plain", "plain", "plain"]);
  });

  it("gives a document the fallback for a null field", async () => {
    assert.equal(await Products().get("p2").key("note", "none"), "none");
  });
});
