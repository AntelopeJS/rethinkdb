import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database/schema";

import { SelectionQuery } from "../implementations/database/selection";
import { RunQuery } from "../implementations/database/query";

const SCHEMA_ID = "stage-names";
const INHERITED_NAMES = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "__proto__",
];

const PREFIX = [
  QueryStage("schema", { id: SCHEMA_ID }),
  QueryStage("instance", { id: CROSS_INSTANCE }),
  QueryStage("table", { id: "items" }),
];

const schema = new Schema(SCHEMA_ID, {
  items: { fields: {}, indexes: {} },
});

describe("stage names inherited from Object.prototype", () => {
  it("refuses them as stream stages, like an unknown stage", () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      assert.throws(
        () =>
          SelectionQuery.buildTermJson(
            [...PREFIX, { stage: name, args: [] }],
            SelectionQuery.newContext(),
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
        .map((row) => new ValueProxy({ stage: name, args: [] }, row.key("a")))
        .build();
      assert.throws(
        () => SelectionQuery.buildTermJson(stages, SelectionQuery.newContext()),
        { message: `Unimplemented expression stage: ${name}` },
      );
    }
  });

  it("refuses them as schema stages, like an unknown stage", async () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      await assert.rejects(
        RunQuery([
          QueryStage("schema", { id: SCHEMA_ID }),
          { stage: name, args: [] },
        ]),
        {
          message: `Unknown schema stage '${name}'`,
        },
      );
    }
  });
});
