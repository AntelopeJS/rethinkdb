import assert from "node:assert/strict";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database/schema";

import { SelectionQuery } from "../implementations/database/selection";
import { RunQuery } from "../implementations/database/query";
import {
  DecodingContext,
  type QueryStage,
} from "../implementations/database/utils";

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

function Stage(stage: string, id?: string | typeof CROSS_INSTANCE): QueryStage {
  return { stage, options: { id }, args: [] };
}

const PREFIX = [
  Stage("schema", SCHEMA_ID),
  Stage("instance", CROSS_INSTANCE),
  Stage("table", "items"),
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
        .map((row) => row.key("a").add(1))
        .build();
      stages[3].args[0].args[1].stages[2].stage = name;
      assert.throws(
        () => SelectionQuery.buildTermJson(stages, new DecodingContext()),
        { message: `Unimplemented expression stage: ${name}` },
      );
    }
  });

  it("refuses them as schema stages, like an unknown stage", async () => {
    for (const name of ["nope", ...INHERITED_NAMES]) {
      await assert.rejects(
        RunQuery([Stage("schema", SCHEMA_ID), Stage(name)]),
        {
          message: `Unknown schema stage '${name}'`,
        },
      );
    }
  });
});
