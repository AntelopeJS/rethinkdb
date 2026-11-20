import { expect } from "chai";
import {
  type ColumnProfile,
  type RelationProfile,
  Profile,
} from "@antelopejs/interface-database-catalog";

import { AssertNoRareValue } from "@antelopejs/interface-database-catalog/testing";

import { Received, ReceivedValues } from "./received";
import { CLIENT_DATABASE, GRADE_LEVEL_COUNTS } from "./fixture";

async function ProfiledColumn(column: string): Promise<{
  profile: ColumnProfile | undefined;
  relation: RelationProfile;
  received: string;
}> {
  const { answer, received } = await Received(() =>
    Profile({ relation: `${CLIENT_DATABASE}.grades`, columns: [column] }),
  );
  return {
    relation: answer,
    profile: answer.columns.find((profiled) => profiled.name === column),
    received,
  };
}

describe("the range of an external number field", function () {
  this.timeout(60_000);

  it("ends at values seen 5 times, past values seen 4 times, and receives no rarer value", async () => {
    const { profile, relation, received } = await ProfiledColumn("level");
    expect(profile?.range).to.deep.equal({
      status: "ok",
      value: { min: 7002, max: 7008 },
    });
    expect(received).to.include("7002");
    AssertNoRareValue({
      profile: relation,
      results: ReceivedValues(received),
      counts: { level: GRADE_LEVEL_COUNTS },
    });
  });

  it("keeps the true ends of a date field, and its time-axis trait", async () => {
    const { answer } = await Received(() =>
      Profile({
        relation: `${CLIENT_DATABASE}.orders`,
        columns: ["ordered_at"],
      }),
    );
    const profile = answer.columns[0];
    expect(profile?.range?.status).to.equal("ok");
    expect(profile?.traits).to.include("time-axis");
  });

  it("answers empty for a field whose every value is seen once", async () => {
    const { profile } = await ProfiledColumn("serial");
    expect(profile?.range).to.deep.equal({ status: "error", code: "empty" });
  });
});
