import { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RethinkDBErrorType } from "rethinkdb-ts";
import { RethinkDBError } from "rethinkdb-ts/lib/error/error";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import {
  Schema,
  CROSS_INSTANCE,
  type AtomicEqualityValue,
  type AtomicMutation,
  type AtomicUpdate,
} from "@antelopejs/interface-database";

import * as connection from "../connection";
import { validateWriteResult } from "../write-result";
import { RunQuery } from "../implementations/database/query";
import type { QueryStage } from "../implementations/database/utils";

interface AtomicRecord {
  _id: string;
  revision?: string | null;
  value: string;
  nested?: Record<string, unknown>;
  tenant_id?: string;
  equal?: AtomicEqualityValue | null;
}

interface AtomicTables {
  records: AtomicRecord;
}

const schema = new Schema<AtomicTables>("test-atomic-mutation", {
  records: { fields: { value: "string", revision: "string" }, indexes: {} },
});
const table = schema.instance("owner").table("records");
const other = schema.instance("other").table("records");
const initialRevision = "initial";
const raceRounds = 8;

function update(value: string): AtomicUpdate<AtomicRecord> {
  return {
    type: "update",
    revisionField: "revision",
    expectedRevision: initialRevision,
    nextRevision: `revision-${value}`,
    patch: { value },
  };
}

async function insertRecord(): Promise<string> {
  const key = randomUUID();
  await table
    .insert({ _id: key, revision: initialRevision, value: "original" })
    .run();
  return key;
}

describe("Atomic single-record mutations", () => {
  before(async () => {
    await schema.createInstance("owner").run();
    await schema.createInstance("other").run();
    await schema.createInstance().run();
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    await schema.destroyInstance("owner").run();
    await schema.destroyInstance("other").run();
    await schema.destroyInstance().run();
  });
  it("serializes competing patches", contendUpdates);
  it("serializes deletion against update", contendDelete);
  it("distinguishes absent and null revisions", missingRevision);
  it("isolates tenants", isolateTenants);
  it("supports default instance without upsert", defaultInstance);
  it("replaces fields literally, including dates", replaceFields);
  it("does not retry lost acknowledgements", lostAcknowledgement);
  it("does not retry absent acknowledgements", missingAcknowledgement);
  it("rejects malformed acknowledgement counts", malformedAcknowledgement);
  it("rejects invalid input before sending", rejectInvalid);
  it("checks scalar equality inside deletion", deleteEquality);
  it("protects refreshes from stale cleanup", contendEquality);
  it("distinguishes definite and uncertain errors", classifyErrors);
  it("fails closed on malformed stages", rejectStages);
});

async function contendUpdates() {
  for (let round = 0; round < raceRounds; round++) {
    const key = await insertRecord();
    const requests = [update("left"), update("right")];
    const outcomes = await Promise.all(
      requests.map((request) => table.atomicMutation(key, request).run()),
    );
    assert.deepEqual([...outcomes].sort(), ["applied", "not-applied"]);
    const winner = requests[outcomes.indexOf("applied")];
    const stored = await table.get(key).run();
    assert.equal(stored.value, winner.patch.value);
    assert.equal(stored.revision, winner.nextRevision);
  }
}

async function contendDelete() {
  const requests: AtomicMutation<AtomicRecord>[] = [
    {
      type: "delete",
      revisionField: "revision",
      expectedRevision: initialRevision,
    },
    update("survived"),
  ];
  for (let round = 0; round < raceRounds; round++) {
    const key = await insertRecord();
    requests.reverse();
    const outcomes = await Promise.all(
      requests.map((request) => table.atomicMutation(key, request).run()),
    );
    assert.deepEqual([...outcomes].sort(), ["applied", "not-applied"]);
    const stored = await table.get(key).run();
    if (requests[outcomes.indexOf("applied")].type === "delete") {
      assert.equal(stored, undefined);
      continue;
    }
    assert.equal(stored.value, "survived");
    assert.equal(stored.revision, "revision-survived");
  }
}

async function missingRevision() {
  const absent = randomUUID();
  const storedNull = randomUUID();
  const missingRow = randomUUID();
  await table
    .insert([
      { _id: absent, value: "legacy" },
      { _id: storedNull, value: "null", revision: null },
    ])
    .run();
  const request: AtomicUpdate<AtomicRecord> = {
    ...update("adopted"),
    expectedRevision: { kind: "missing" },
  };
  assert.equal(await table.atomicMutation(absent, request).run(), "applied");
  assert.equal(
    await table.atomicMutation(storedNull, request).run(),
    "not-applied",
  );
  assert.equal(
    await table.atomicMutation(missingRow, request).run(),
    "not-applied",
  );
  const deletion = table.atomicMutation(missingRow, {
    type: "delete",
    revisionField: "revision",
    expectedRevision: { kind: "missing" },
  });
  assert.equal(await deletion.run(), "not-applied");
  assert.equal(await table.get(missingRow).run(), undefined);
  assert.equal((await table.get(storedNull).run()).revision, null);
  assert.equal((await table.get(absent).run()).revision, request.nextRevision);
}

async function isolateTenants() {
  const key = await insertRecord();
  assert.equal(
    await other.atomicMutation(key, update("intruder")).run(),
    "not-applied",
  );
  assert.equal(
    await other
      .atomicMutation(key, {
        type: "delete",
        revisionField: "revision",
        expectedRevision: initialRevision,
      })
      .run(),
    "not-applied",
  );
  assert.throws(() =>
    schema
      .instance(CROSS_INSTANCE)
      .table("records")
      .atomicMutation(key, update("cross")),
  );
  assert.equal(await other.get(key).run(), undefined);
  assert.equal((await table.get(key).run()).revision, initialRevision);
}

async function defaultInstance() {
  const defaultTable = schema.instance().table("records");
  const key = randomUUID();
  assert.equal(
    await defaultTable.atomicMutation(key, update("default")).run(),
    "not-applied",
  );
  await defaultTable
    .insert({ _id: key, revision: initialRevision, value: "original" })
    .run();
  assert.equal(
    await defaultTable.atomicMutation(key, update("default")).run(),
    "applied",
  );
  assert.equal((await defaultTable.get(key).run()).value, "default");
}

async function replaceFields() {
  const key = await insertRecord();
  await table
    .get(key)
    .update({ nested: { removed: true, retained: "old" } })
    .run();
  const nested = {
    retained: "new",
    stage: "delete",
    args: ["data"],
    date: new Date("2026-01-02T03:04:05Z"),
  };
  const request = { ...update("unused"), patch: { nested } };
  assert.equal(await table.atomicMutation(key, request).run(), "applied");
  const stored = await table.get(key).run();
  assert.deepEqual(stored.nested, nested);
  assert.equal(stored.value, "original");
  assert.equal(stored.revision, request.nextRevision);
}

async function lostAcknowledgement() {
  const key = await insertRecord();
  const execute = connection.executeTermJson;
  const fault = mock.method(
    connection,
    "executeTermJson",
    async (...args: Parameters<typeof execute>) => {
      await execute(...args);
      throw new Error("Connection closed before acknowledgement");
    },
  );
  assert.equal(
    await table.atomicMutation(key, update("committed")).run(),
    "unknown",
  );
  assert.equal(fault.mock.callCount(), 1);
  mock.restoreAll();
  assert.equal((await table.get(key).run()).revision, "revision-committed");
}

async function missingAcknowledgement() {
  const key = await insertRecord();
  const fault = mock.method(
    connection,
    "executeTermJson",
    async () => undefined,
  );
  assert.equal(
    await table.atomicMutation(key, update("unconfirmed")).run(),
    "unknown",
  );
  assert.equal(fault.mock.callCount(), 1);
  mock.restoreAll();
  assert.equal((await table.get(key).run()).revision, initialRevision);
}

async function malformedAcknowledgement() {
  const key = await insertRecord();
  const empty = {
    errors: 0,
    inserted: 0,
    deleted: 0,
    replaced: 0,
    unchanged: 0,
    skipped: 0,
  };
  for (const result of [
    empty,
    { ...empty, replaced: 2 },
    { ...empty, unchanged: 1, skipped: 1 },
  ]) {
    const fault = mock.method(
      connection,
      "executeTermJson",
      async () => result,
    );
    assert.equal(
      await table.atomicMutation(key, update("malformed")).run(),
      "unknown",
    );
    assert.equal(fault.mock.callCount(), 1);
    mock.restoreAll();
  }
  assert.equal((await table.get(key).run()).revision, initialRevision);
}

async function rejectInvalid() {
  const key = await insertRecord();
  const fault = mock.method(connection, "executeTermJson", async () => {
    throw new Error("Must not send");
  });
  await assert.rejects(
    table
      .atomicMutation(key, {
        ...update("scope"),
        patch: { tenant_id: "other" },
      })
      .run(),
  );
  assert.throws(() =>
    table.atomicMutation(key, {
      ...update("undefined"),
      patch: { value: undefined },
    }),
  );
  assert.throws(() =>
    table.atomicMutation(key, { ...update("id"), patch: { _id: "other" } }),
  );
  assert.throws(() =>
    table.atomicMutation(key, {
      ...update("revision"),
      patch: { revision: "other" },
    }),
  );
  assert.equal(fault.mock.callCount(), 0);
}

async function deleteEquality() {
  const values: AtomicEqualityValue[] = [
    "saved",
    0,
    false,
    new Date("2026-02-03T04:05:06Z"),
  ];
  for (const expectedValue of values) {
    const key = await insertRecord();
    const request = {
      type: "deleteIfEqual" as const,
      field: "equal" as const,
      expectedValue,
    };
    assert.equal(await table.atomicMutation(key, request).run(), "not-applied");
    await table.get(key).update({ equal: null }).run();
    assert.equal(await table.atomicMutation(key, request).run(), "not-applied");
    await table.get(key).update({ equal: expectedValue }).run();
    assert.equal(await other.atomicMutation(key, request).run(), "not-applied");
    assert.equal(
      await table
        .atomicMutation(key, { ...request, expectedValue: "different" })
        .run(),
      "not-applied",
    );
    assert.equal(await table.atomicMutation(key, request).run(), "applied");
    assert.equal(await table.get(key).run(), undefined);
    assert.equal(await table.atomicMutation(key, request).run(), "not-applied");
  }
}

async function contendEquality() {
  const requests: AtomicMutation<AtomicRecord>[] = [
    { type: "deleteIfEqual", field: "equal", expectedValue: "expired" },
    { ...update("refresh"), patch: { equal: "refreshed" } },
  ];
  for (let round = 0; round < raceRounds; round++) {
    const key = await insertRecord();
    await table.get(key).update({ equal: "expired" }).run();
    requests.reverse();
    const outcomes = await Promise.all(
      requests.map((request) => table.atomicMutation(key, request).run()),
    );
    assert.deepEqual([...outcomes].sort(), ["applied", "not-applied"]);
    const stored = await table.get(key).run();
    if (requests[outcomes.indexOf("applied")].type === "deleteIfEqual") {
      assert.equal(stored, undefined);
      continue;
    }
    assert.equal(stored.equal, "refreshed");
    assert.equal(stored.revision, "revision-refresh");
  }
}

async function classifyErrors() {
  const key = await insertRecord();
  for (const type of [
    RethinkDBErrorType.CONNECTION,
    RethinkDBErrorType.OP_INDETERMINATE,
  ]) {
    const fault = mock.method(connection, "executeTermJson", async () => {
      throw new RethinkDBError("Uncertain", { type });
    });
    assert.equal(
      await table.atomicMutation(key, update("unknown")).run(),
      "unknown",
    );
    assert.equal(fault.mock.callCount(), 1);
    mock.restoreAll();
  }
  mock.method(connection, "executeTermJson", async (term: TermJson) => {
    validateWriteResult(term, {
      errors: 1,
      first_error: "Untyped write failure",
    });
  });
  assert.equal(
    await table.atomicMutation(key, update("untyped")).run(),
    "unknown",
  );
  mock.restoreAll();
  const error = new RethinkDBError("Invalid query", {
    type: RethinkDBErrorType.QUERY_LOGIC,
  });
  mock.method(connection, "executeTermJson", async () => {
    throw error;
  });
  await assert.rejects(
    table.atomicMutation(key, update("invalid")).run(),
    error,
  );
}

async function rejectStages() {
  const terminal: QueryStage = {
    stage: "atomicMutation",
    args: [randomUUID(), update("invalid")],
  };
  const prefix: QueryStage[] = [
    { stage: "schema", options: { id: schema.id }, args: [] },
    { stage: "instance", options: { id: "owner" }, args: [] },
    { stage: "table", options: { id: "records" }, args: [] },
  ];
  const fault = mock.method(connection, "executeTermJson", async () => {
    throw new Error("Must not send");
  });
  await assert.rejects(RunQuery([...prefix, { ...terminal, options: {} }]));
  await assert.rejects(RunQuery([...prefix, { ...terminal, args: [] }]));
  await assert.rejects(
    RunQuery([...prefix, { stage: "get", args: ["id"] }, terminal]),
  );
  await assert.rejects(
    RunQuery([...prefix, terminal, { stage: "delete", args: [] }]),
  );
  assert.equal(fault.mock.callCount(), 0);
}
