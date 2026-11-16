import { expect } from "chai";
import {
  type ColumnProfile,
  Profile,
} from "@antelopejs/interface-database-catalog";

import { Received } from "./received";
import { CLIENT_DATABASE } from "./fixture";

async function ProfiledColumn(
  column: string,
): Promise<{ profile: ColumnProfile | undefined; received: string }> {
  const { answer, received } = await Received(() =>
    Profile({ relation: `${CLIENT_DATABASE}.grades`, columns: [column] }),
  );
  return {
    profile: answer.columns.find((profiled) => profiled.name === column),
    received,
  };
}

describe("the range of an external number field", function () {
  this.timeout(60_000);

  it("ends at values seen 5 times, past values seen 4 times, and receives no rarer value", async () => {
    const { profile, received } = await ProfiledColumn("level");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: 7002, max: 7008 },
    });
    expect(received).to.include("7002");
    expect(received).to.not.include("7001");
    expect(received).to.not.include("7009");
  });

  it("answers empty for a field whose every value is seen once", async () => {
    const { profile } = await ProfiledColumn("serial");
    expect(profile?.range).to.deep.equal({ status: "error", code: "empty" });
  });
});
