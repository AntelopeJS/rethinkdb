import { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Schema } from "@antelopejs/interface-database";

import * as connection from "../connection";
import { RunQuery } from "../implementations/database/query";

const schema = new Schema("test-atomic-mutation-untyped", {
  records: { fields: { value: "string", revision: "string" }, indexes: {} },
});

const TERMINAL = {
  stage: "atomicMutation",
  args: [
    randomUUID(),
    {
      type: "update",
      revisionField: "revision",
      expectedRevision: "initial",
      nextRevision: "revision-invalid",
      patch: { value: "invalid" },
    },
  ],
};

const PREFIX = [
  { stage: "schema", options: { id: schema.id }, args: [] },
  { stage: "instance", options: { id: "owner" }, args: [] },
  { stage: "table", options: { id: "records" }, args: [] },
];

/** Records every query sent from now on, and counts the ones that target this schema. */
function spySchemaExecution() {
  const spy = mock.method(connection, "executeTermJson");
  return () =>
    spy.mock.calls.filter(({ arguments: [term] }) =>
      JSON.stringify(term).includes(JSON.stringify(schema.id)),
    ).length;
}

describe("an atomicMutation stage a caller writes by hand, past the contract", () => {
  before(async () => {
    await schema.createInstance("owner").run();
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    await schema.destroyInstance("owner").run();
  });

  it("refuses options before sending", async () => {
    const sent = spySchemaExecution();
    await assert.rejects(
      RunQuery([...PREFIX, { ...TERMINAL, options: {} }]),
      /Atomic mutation requires one key and request without options/,
    );
    assert.equal(sent(), 0);
  });

  it("refuses a stage without its key and request before sending", async () => {
    const sent = spySchemaExecution();
    await assert.rejects(
      RunQuery([...PREFIX, { ...TERMINAL, args: [] }]),
      /Atomic mutation requires one key and request without options/,
    );
    assert.equal(sent(), 0);
  });
});
