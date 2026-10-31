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

/** An `add` stage as a route rebuilds it from a request's JSON: any number of operands, read after `receiver`. */
function JsonAdd(receiver: ValueProxy<number>, args: (number | string)[]) {
  const rebuilt: unknown = JSON.parse(JSON.stringify({ stage: "add", args }));
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
        two: JsonAdd(row.key("age"), [1, 2]),
        text: JsonAdd(row.key("name").cast<number>(), ["x", "y"]),
      })),
      [{ two: 39, text: "adaxy" }],
    );
  });

  it("add answers its receiver for a hand-written JSON stage with no operand", async () => {
    assert.deepEqual(
      await Rows().map((row) => JsonAdd(row.key("age"), [])),
      [36],
    );
  });
});
