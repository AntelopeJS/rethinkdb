import assert from "node:assert/strict";
import { Schema, type SchemaDefinition } from "@antelopejs/interface-database";

import { Schemas } from "../implementations/database/schema";

const TABLE = "items";
const INSTANCE = "alpha";

const REFUSED_SCHEMAS: Array<{
  name: string;
  schemaId: string;
  definition: SchemaDefinition;
  refusal: RegExp;
}> = [
  {
    name: "a reserved index suffix",
    schemaId: "test-refused-schema-reserved",
    definition: { [TABLE]: { fields: {}, indexes: { status__i: {} } } },
    refusal:
      /Index 'status__i' of table 'items' ends with the reserved suffix '__i'/,
  },
  {
    name: "a unique secondary index",
    schemaId: "test-refused-schema-unique",
    definition: {
      [TABLE]: { fields: {}, indexes: { status: { unique: true } } },
    },
    refusal:
      /Index 'status' of table 'test-refused-schema-unique\.items' is declared unique: true, but RethinkDB cannot enforce unique secondary indexes/,
  },
];

describe("a schema the module refuses at registration", () => {
  for (const { name, schemaId, definition, refusal } of REFUSED_SCHEMAS) {
    it(`registers ${name}, then fails every query on it with the refusal`, async () => {
      await Schemas.register(schemaId, definition);
      const refused = new Schema(schemaId, definition);
      await assert.rejects(refused.createInstance(INSTANCE).run(), refusal);
      await assert.rejects(
        refused.instance(INSTANCE).table(TABLE).run(),
        refusal,
      );
      await assert.rejects(refused.listInstances().run(), refusal);
    });
  }
});
