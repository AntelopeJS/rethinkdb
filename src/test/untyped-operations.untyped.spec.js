import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "untyped-operations";
const INSTANCE = "one";

const schema = new Schema(SCHEMA_ID, {
  rows: { fields: { name: "string", age: "number" }, indexes: {} },
});

function Rows() {
  return schema.instance(INSTANCE).table("rows");
}

describe("a stage a caller writes by hand, past the contract", () => {
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows().insert({ _id: "ada", name: "ada", age: 36 }).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("add sends every operand of a hand-written JSON stage", async () => {
    assert.deepEqual(
      await Rows()
        .map((row) => ({
          two: new ValueProxy({ stage: "add", args: [1, 2] }, row.key("age")),
          text: new ValueProxy(
            { stage: "add", args: ["x", "y"] },
            row.key("name").cast(),
          ),
        }))
        .run(),
      [{ two: 39, text: "adaxy" }],
    );
  });

  it("add answers its receiver for a hand-written JSON stage with no operand", async () => {
    assert.deepEqual(
      await Rows()
        .map(
          (row) => new ValueProxy({ stage: "add", args: [] }, row.key("age")),
        )
        .run(),
      [36],
    );
  });

  it("during refuses a hand-written stage with one bound", async () => {
    await assert.rejects(
      Rows()
        .map(
          (row) =>
            new ValueProxy({ stage: "date_during", args: [0] }, row.key("age")),
        )
        .run(),
      /Expected 3 arguments/,
    );
  });

  it("during refuses a hand-written stage with three bounds", async () => {
    await assert.rejects(
      Rows()
        .map(
          (row) =>
            new ValueProxy(
              { stage: "date_during", args: [0, 10_000, 5] },
              row.key("age"),
            ),
        )
        .run(),
      /Expected 3 arguments/,
    );
  });
});
