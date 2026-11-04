import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database/schema";

import { SelectionQuery } from "../implementations/database/selection";
import { RunQuery } from "../implementations/database/query";
import { DecodingContext } from "../implementations/database/utils";

const SCHEMA_ID = "stage-names";
const INHERITED_NAMES = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "__proto__",
];

interface Item {
  _id: string;
  a: number;
}

const PREFIX = [
  QueryStage("schema", { id: SCHEMA_ID }),
  QueryStage("instance", { id: CROSS_INSTANCE }),
  QueryStage("table", { id: "items" }),
];

let schema: Schema<{ items: Item }>;

describe("stage names inherited from Object.prototype", () => {
  before(() => {
    schema = new Schema<{ items: Item }>(SCHEMA_ID, {
      items: { fields: {}, indexes: {} },
    });
  });

  it("refuses them as stream stages, like an unknown stage", () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      assert.throws(
        () =>
          SelectionQuery.buildTermJson(
            // @ts-expect-error a stage name outside the union, which the stream dispatch refuses as unimplemented
            [...PREFIX, { stage: name, args: [] }],
            new DecodingContext(),
          ),
        { message: `Unimplemented stream stage: ${name}` },
      );
    }
  });

  it("refuses them as expression stages, like an unknown stage", () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      const stages = schema
        .instance(CROSS_INSTANCE)
        .table("items")
        .map(
          (row) =>
            // @ts-expect-error a stage name outside the union, which the expression dispatch refuses as unimplemented
            new ValueProxy({ stage: name, args: [] }, row.key("a")),
        )
        .build();
      assert.throws(
        () => SelectionQuery.buildTermJson(stages, new DecodingContext()),
        { message: `Unimplemented expression stage: ${name}` },
      );
    }
  });

  it("refuses them as schema stages, like an unknown stage", async () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      await assert.rejects(
        RunQuery([
          QueryStage("schema", { id: SCHEMA_ID }),
          // @ts-expect-error a stage name outside the union, which the schema dispatch refuses as unknown
          { stage: name, args: [] },
        ]),
        {
          message: `Unknown schema stage '${name}'`,
        },
      );
    }
  });
});
