import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { r, type RDatum } from "rethinkdb-ts";
import { Schema } from "@antelopejs/interface-database";
import { CloseCursor, ReadCursor } from "@antelopejs/interface-database/query";

import { AdminConnection } from "../test-external/fixture";

const REQ_ID = Number.MAX_SAFE_INTEGER - 1;
const SETTLE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 50;
const TABLE = "close_while_opening_feed";

const schema = new Schema("test-cursor-close-while-opening", {
  [TABLE]: { fields: { n: "number" }, indexes: {} },
});
const feed = schema.instance("default").table(TABLE);

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

/** The change feed queries on the test table that the server still runs. */
async function RunningFeeds(): Promise<number> {
  const connection = await AdminConnection();
  try {
    const queries = await r
      .db("rethinkdb")
      .table("jobs")
      .filter({ type: "query" })
      .map<string>((job: RDatum) => job("info")("query"))
      .run(connection);
    return queries.filter(
      (query) => query.includes(TABLE) && query.includes(".changes("),
    ).length;
  } finally {
    await connection.close();
  }
}

/** The change feed queries left on the test table once they had `ms` to stop. */
async function FeedsLeftAfter(ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  let running = await RunningFeeds();
  while (running > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    running = await RunningFeeds();
  }
  return running;
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

  it("Ends the first read of a change feed with an empty batch and stops the feed", async () => {
    const read = ReadCursor(REQ_ID, feed.changes().build());
    await CloseCursor(REQ_ID);
    assert.equal(
      await SettlesWithin(read, SETTLE_TIMEOUT_MS),
      true,
      "a CloseCursor that ignores a cursor still opening leaves its feed read pending",
    );
    assert.deepEqual(await read, []);
    assert.equal(
      await FeedsLeftAfter(SETTLE_TIMEOUT_MS),
      0,
      "a CloseCursor that drops a cursor still opening without closing it leaves its feed running",
    );
  });
});
