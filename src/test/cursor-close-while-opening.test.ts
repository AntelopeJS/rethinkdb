import assert from "node:assert/strict";
import { Schema } from "@antelopejs/interface-database";
import { CloseCursor, ReadCursor } from "@antelopejs/interface-database/query";

const REQ_ID = Number.MAX_SAFE_INTEGER - 1;
const SETTLE_TIMEOUT_MS = 2000;

const schema = new Schema("test-cursor-close-while-opening", {
  events: { fields: { n: "number" }, indexes: {} },
});
const events = schema.instance("default").table("events");

function SettlesWithin(pending: Promise<unknown[]>, ms: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settle = () => {
      clearTimeout(timer);
      resolve(true);
    };
    pending.then(settle, settle);
  });
}

describe("CloseCursor while the first read opens the cursor", function () {
  this.timeout(3 * SETTLE_TIMEOUT_MS);

  before(async () => {
    await schema.createInstance("default").run();
  });

  after(async () => {
    await CloseCursor(REQ_ID);
    await schema.destroyInstance("default").run();
  });

  it("Ends the first read of a change feed with an empty batch", async () => {
    const read = ReadCursor(REQ_ID, events.changes().build());
    await CloseCursor(REQ_ID);
    assert.equal(
      await SettlesWithin(read, SETTLE_TIMEOUT_MS),
      true,
      "a CloseCursor that ignores a cursor still opening leaves its feed read pending",
    );
    assert.deepEqual(await read, []);
  });
});
