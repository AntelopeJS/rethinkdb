import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "match-mixed-types";
const INSTANCE = "one";

const schema = new Schema(SCHEMA_ID, {
  rows: { fields: { label: "string" }, indexes: {} },
});

describe("match over a column holding values of several types", () => {
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await schema
      .instance(INSTANCE)
      .table("rows")
      .insert([
        { _id: "text", label: "ada" },
        { _id: "other", label: "bob" },
        { _id: "number", label: 5 },
        { _id: "null", label: null },
        { _id: "list", label: ["ada"] },
      ])
      .run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("answers true for a matching text and false for every other value", async () => {
    const answers = await schema
      .instance(INSTANCE)
      .table("rows")
      .map((row) => ({
        id: row.key("_id"),
        found: new ValueProxy(
          { stage: "str_match", args: ["^a"] },
          row.key("label"),
        ),
      }))
      .run();
    assert.deepEqual(
      Object.fromEntries(answers.map(({ id, found }) => [id, found])),
      { text: true, other: false, number: false, null: false, list: false },
    );
  });
});
