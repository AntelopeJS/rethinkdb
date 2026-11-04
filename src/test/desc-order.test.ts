import assert from "node:assert/strict";
import { r } from "rethinkdb-ts";
import { TermType } from "rethinkdb-ts/lib/proto/enums";

describe("the local typing of r.desc in rethinkdb-ts.d.ts", () => {
  it("is a term an array's orderBy compiles as a descending field", () => {
    assert.equal(
      r.serialize(r.expr([1]).orderBy(r.desc("x"), "y")),
      JSON.stringify([
        TermType.ORDER_BY,
        [[TermType.MAKE_ARRAY, [1]], [TermType.DESC, ["x"]], "y"],
      ]),
    );
  });

  it("is a term a stream's orderBy compiles as a descending index", () => {
    assert.equal(
      r.serialize(
        r
          .db("d")
          .table("t")
          .orderBy({ index: r.desc("x") }),
      ),
      JSON.stringify([
        TermType.ORDER_BY,
        [[TermType.TABLE, [[TermType.DB, ["d"]], "t"]]],
        { index: [TermType.DESC, ["x"]] },
      ]),
    );
  });
});
