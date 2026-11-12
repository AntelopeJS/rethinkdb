import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database/schema";

import { SelectionQuery } from "../implementations/database/selection";
import { RunQuery } from "../implementations/database/query";
import { WithForeign } from "./foreign";

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

/** A stage without arguments named `name`, which no stage of the union carries. */
function ForeignStage(name: string): QueryStage {
  return WithForeign<QueryStage>({ stage: "not", args: [] }, "stage", name);
}

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
            [...PREFIX, ForeignStage(name)],
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
        .map((row) => new ValueProxy(ForeignStage(name), row.key("a")))
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
        RunQuery([QueryStage("schema", { id: SCHEMA_ID }), ForeignStage(name)]),
        {
          message: `Unknown schema stage '${name}'`,
        },
      );
    }
  });
});
