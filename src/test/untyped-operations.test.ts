import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "untyped-operations";
const INSTANCE = "one";

interface Row {
  _id: string;
  name: string;
  age: number;
}

const schema = new Schema<{ rows: Row }>(SCHEMA_ID, {
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
      await Rows().map((row) => ({
        two: new ValueProxy<number>(
          // @ts-expect-error two operands where add takes one, which the driver answers by adding both
          { stage: "add", args: [1, 2] },
          row.key("age"),
        ),
        text: new ValueProxy<number>(
          // @ts-expect-error two text operands where add takes one number, which the driver answers by concatenating both
          { stage: "add", args: ["x", "y"] },
          row.key("name").cast<number>(),
        ),
      })),
      [{ two: 39, text: "adaxy" }],
    );
  });

  it("add answers its receiver for a hand-written JSON stage with no operand", async () => {
    assert.deepEqual(
      await Rows().map(
        (row) =>
          new ValueProxy<number>(
            // @ts-expect-error no operand where add takes one, which the driver answers with its receiver
            { stage: "add", args: [] },
            row.key("age"),
          ),
      ),
      [36],
    );
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
