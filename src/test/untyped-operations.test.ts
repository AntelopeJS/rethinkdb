import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "untyped-operations";
const INSTANCE = "one";

interface Row {
  _id: string;
  age: number;
}

const schema = new Schema<{ rows: Row }>(SCHEMA_ID, {
  rows: { fields: { age: "number" }, indexes: {} },
});

function Rows() {
  return schema.instance(INSTANCE).table("rows");
}

describe("a stage a caller writes by hand, past the contract", () => {
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows().insert({ _id: "ada", age: 36 }).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("during refuses a hand-written stage with one bound", async () => {
    await assert.rejects(
      Rows()
        .map(
          (row) =>
            new ValueProxy<number>(
              // @ts-expect-error one bound where date_during takes two, which the server refuses by its argument count
              { stage: "date_during", args: [0] },
              row.key("age"),
            ),
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
            new ValueProxy<number>(
              // @ts-expect-error three bounds where date_during takes two, which the server refuses by its argument count
              { stage: "date_during", args: [0, 10_000, 5] },
              row.key("age"),
            ),
        )
        .run(),
      /Expected 3 arguments/,
    );
  });
});
