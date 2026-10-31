import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
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

/** A stage as a route rebuilds it from a request's JSON: any number of arguments, read after `receiver`. */
function JsonStage(
  receiver: ValueProxy<number>,
  stage: "add" | "date_during",
  args: (number | string)[],
) {
  const rebuilt: unknown = JSON.parse(JSON.stringify({ stage, args }));
  return Object.assign(
    new ValueProxy<number>(QueryStage("add", undefined, null), receiver),
    { stages: [...receiver.build(), rebuilt] },
  );
}

describe("the operations a caller reaches past the contract, with a JSON stage", () => {
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
        two: JsonStage(row.key("age"), "add", [1, 2]),
        text: JsonStage(row.key("name").cast<number>(), "add", ["x", "y"]),
      })),
      [{ two: 39, text: "adaxy" }],
    );
  });

  it("add answers its receiver for a hand-written JSON stage with no operand", async () => {
    assert.deepEqual(
      await Rows().map((row) => JsonStage(row.key("age"), "add", [])),
      [36],
    );
  });

  it("during refuses a hand-written JSON stage without exactly two bounds", async () => {
    for (const bounds of [[0], [0, 10_000, 5]]) {
      await assert.rejects(
        Rows()
          .map((row) => JsonStage(row.key("age"), "date_during", bounds))
          .run(),
        /Expected 3 arguments/,
      );
    }
  });
});
