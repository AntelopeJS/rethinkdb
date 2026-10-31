import { expect } from "chai";
import { r } from "rethinkdb-ts";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import type { ExternalTable } from "../implementations/database/external-descriptor";
import { RunExternalWrite } from "../implementations/database/external-writes";
import { type ErpRow, Native } from "./erp";
import { CLIENT_DATABASE } from "./fixture";

const LINES: ExternalTable = {
  table: "order_lines",
  primaryKey: "id",
  key: "array",
  generatesKeys: false,
  indexes: {},
  multiIndexes: [],
  fields: {
    id: { field: "id", kind: "array" },
    sku: { field: "sku", kind: "string" },
    qty: { field: "qty", kind: "number" },
  },
};

const KEYS = [
  ["pin-a", 1],
  ["pin-b", 2],
];

describe("a replace on array-keyed rows selected by another field", () => {
  before(async () => {
    await Native((table) =>
      table("order_lines").insert(
        KEYS.map((id, index) => ({ id, sku: "PIN", qty: index + 3 })),
      ),
    );
  });

  it("pins each row by its whole key and removes the fields it leaves out", async () => {
    const target: TermJson = [
      TermType.FILTER,
      [
        [TermType.TABLE, [[TermType.DB, [CLIENT_DATABASE]], "order_lines"]],
        { sku: "PIN" },
      ],
    ];
    await RunExternalWrite(CLIENT_DATABASE, LINES, {
      kind: "replace",
      value: { sku: "PINNED" },
      target,
    });
    for (const key of KEYS) {
      const stored = await Native<ErpRow | null>((table) =>
        table("order_lines").get(r.expr(key)),
      );
      expect(stored).to.not.have.property("qty");
      expect(stored).to.include({ sku: "PINNED" });
    }
  });
});
