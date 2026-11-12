import assert from "node:assert/strict";
import { Schema } from "@antelopejs/interface-database/schema";

interface Item {
  _id: string;
}

type JavaScriptId = string | number | boolean | null | undefined;

interface UntypedCaller {
  createInstance(id: JavaScriptId): { run(): Promise<string> };
  listInstances(): { run(): Promise<string[]> };
}

const caller: UntypedCaller = new Schema<{ items: Item }>("instance-id-type", {
  items: { fields: {}, indexes: {} },
});

describe("createInstance from an untyped caller", () => {
  const cases: Array<[JavaScriptId, string]> = [
    [7, "number"],
    [null, "null"],
    [true, "boolean"],
  ];
  for (const [id, type] of cases) {
    it(`rejects the id ${String(id)}, naming its type ${type}, and registers nothing`, async () => {
      const before = await caller.listInstances().run();
      await assert.rejects(
        caller.createInstance(id).run(),
        new RegExp(`Instance id must be a string, got ${type}`),
      );
      assert.deepEqual(await caller.listInstances().run(), before);
    });
  }
});
