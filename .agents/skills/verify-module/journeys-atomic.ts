import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

export const atomicOutcomes: Journey = {
  title: "atomicMutation applies only when the revision or value matches, answers not-applied otherwise, never touches another instance, and replaces patched fields whole",
  entryPoint: "`table.atomicMutation(id, request)` from a consumer module, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "atomic mutations",
      `const schema = new db.Schema("verify-atomic", { jobs: { fields: { title: "string", revision: "string", seenAt: "date", meta: "object", tags: "string[]" }, indexes: {} } });
await schema.createInstance("a");
await schema.createInstance("b");
const jobs = schema.instance("a").table("jobs");
const other = schema.instance("b").table("jobs");
const seen = new Date("2024-05-01T00:00:00.000Z");
await jobs.insert([
  { _id: "j1", title: "One", revision: "r1", meta: { a: 1, b: 2 }, tags: ["x"] },
  { _id: "legacy", title: "Legacy" },
  { _id: "nullrev", title: "Null", revision: null },
  { _id: "stamp", title: "Stamp", seenAt: seen, tags: ["y"] },
]);
const out = {};
out.updateApplied = await jobs.atomicMutation("j1", { type: "update", revisionField: "revision", expectedRevision: "r1", nextRevision: "r2", patch: { title: "Updated", meta: { c: 3 } } });
out.afterUpdate = await jobs.get("j1");
out.updateStale = await jobs.atomicMutation("j1", { type: "update", revisionField: "revision", expectedRevision: "r1", nextRevision: "r3", patch: { title: "Stale" } });
out.missingMatchesAbsent = await jobs.atomicMutation("legacy", { type: "update", revisionField: "revision", expectedRevision: { kind: "missing" }, nextRevision: "r1", patch: { title: "Bootstrapped" } });
out.missingVsNull = await jobs.atomicMutation("nullrev", { type: "update", revisionField: "revision", expectedRevision: { kind: "missing" }, nextRevision: "r1", patch: { title: "No" } });
out.unknownRecord = await jobs.atomicMutation("ghost", { type: "update", revisionField: "revision", expectedRevision: "r1", nextRevision: "r2", patch: { title: "No" } });
out.otherInstance = await other.atomicMutation("j1", { type: "update", revisionField: "revision", expectedRevision: "r2", nextRevision: "r9", patch: { title: "Hijack" } });
out.nullPatch = await jobs.atomicMutation("j1", { type: "update", revisionField: "revision", expectedRevision: "r2", nextRevision: "r4", patch: { title: null } });
out.afterNullPatch = await jobs.get("j1");
try { await jobs.atomicMutation("j1", { type: "update", revisionField: "revision", expectedRevision: "r4", nextRevision: "r5", patch: { _id: "other" } }); out.idPatch = "applied"; } catch (error) { out.idPatch = error.name; }
out.deleteStale = await jobs.atomicMutation("j1", { type: "delete", revisionField: "revision", expectedRevision: "r1" });
out.deleteApplied = await jobs.atomicMutation("j1", { type: "delete", revisionField: "revision", expectedRevision: "r4" });
out.deleteIfEqualWrong = await jobs.atomicMutation("stamp", { type: "deleteIfEqual", field: "seenAt", expectedValue: new Date("2024-05-02T00:00:00.000Z") });
out.deleteIfEqualArray = await jobs.atomicMutation("stamp", { type: "deleteIfEqual", field: "tags", expectedValue: "y" });
out.deleteIfEqualMissingField = await jobs.atomicMutation("stamp", { type: "deleteIfEqual", field: "title2", expectedValue: "x" });
out.deleteIfEqualDate = await jobs.atomicMutation("stamp", { type: "deleteIfEqual", field: "seenAt", expectedValue: seen });
out.left = (await jobs).map((job) => job._id).sort();
const { CROSS_INSTANCE } = load("@antelopejs/interface-database/schema");
await schema.createInstance();
const home = schema.instance().table("jobs");
await home.insert([{ _id: "h1", title: "Home", revision: "r1", count: 1 }, { _id: "typed", title: "Typed", count: 1 }]);
try { await schema.instance(CROSS_INSTANCE).table("jobs").atomicMutation("h1", { type: "update", revisionField: "revision", expectedRevision: "r1", nextRevision: "r2", patch: { title: "Cross" } }); out.crossInstance = "applied"; } catch (error) { out.crossInstance = "refused"; }
out.defaultInstance = await home.atomicMutation("h1", { type: "update", revisionField: "revision", expectedRevision: "r1", nextRevision: "r2", patch: { seenAt: new Date("2024-06-01T12:00:00.250Z") } });
out.typeSensitive = await home.atomicMutation("typed", { type: "deleteIfEqual", field: "count", expectedValue: "1" });
out.numberEqual = await home.atomicMutation("typed", { type: "deleteIfEqual", field: "count", expectedValue: 1 });
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const updated = pick(result.value, "afterUpdate");
    const nulled = pick(result.value, "afterNullPatch");
    context.expect(result.folder, [
      sees("a matching revision applies the update", part(result, "updateApplied"), "applied"),
      same("the patch changed the title", pick(updated, "title"), "Updated"),
      same("the next revision was installed with it", pick(updated, "revision"), "r2"),
      same("a patched object replaces the previous one whole", pick(updated, "meta"), { c: 3 }),
      same("fields outside the patch stay", pick(updated, "tags"), ["x"]),
      sees("a stale revision is not-applied", part(result, "updateStale"), "not-applied"),
      sees("missing matches a record without the revision field", part(result, "missingMatchesAbsent"), "applied"),
      sees("missing does not match a stored null", part(result, "missingVsNull"), "not-applied"),
      sees("an unknown record is not-applied", part(result, "unknownRecord"), "not-applied"),
      sees("another instance's record is out of scope", part(result, "otherInstance"), "not-applied"),
      sees("a null patch value applies", part(result, "nullPatch"), "applied"),
      same("null is stored, not removed", pick(nulled, "title"), null),
      sees("a patch naming _id is refused with a TypeError", part(result, "idPatch"), "TypeError"),
      sees("a delete with a stale revision is not-applied", part(result, "deleteStale"), "not-applied"),
      sees("a delete with the current revision is applied", part(result, "deleteApplied"), "applied"),
      sees("deleteIfEqual with another instant is not-applied", part(result, "deleteIfEqualWrong"), "not-applied"),
      sees("deleteIfEqual does not match an array holding the scalar", part(result, "deleteIfEqualArray"), "not-applied"),
      sees("deleteIfEqual on a missing field never matches", part(result, "deleteIfEqualMissingField"), "not-applied"),
      sees("deleteIfEqual with the stored instant is applied", part(result, "deleteIfEqualDate"), "applied"),
      sees("only the untouched records are left", part(result, "left"), ["legacy", "nullrev"]),
      sees("a CROSS_INSTANCE atomic mutation is refused", part(result, "crossInstance"), "refused"),
      sees("the default instance is supported", part(result, "defaultInstance"), "applied"),
      sees("deleteIfEqual is type-sensitive: the text 1 does not match the number 1", part(result, "typeSensitive"), "not-applied"),
      sees("deleteIfEqual with the stored number is applied", part(result, "numberEqual"), "applied"),
    ]);
    const native = await owner(
      context,
      "read the bootstrapped and patched records back",
      `const t = r.db("verify-atomic").table("jobs");
return { legacy: await t.get("legacy").run(c), home: await t.get("h1").run(c), seenType: await t.get("h1")("seenAt").typeOf().run(c), seenEpoch: await t.get("h1")("seenAt").toEpochTime().run(c), typed: await t.get("typed").run(c) };`,
    );
    const home = pick(native.value, "home");
    context.expect(native.folder, [
      same("the bootstrapped record holds its new revision", pick(native.value, "legacy", "revision"), "r1"),
      same("and its new title", pick(native.value, "legacy", "title"), "Bootstrapped"),
      same("the CROSS_INSTANCE mutation changed nothing and the default-instance one installed its revision", pick(home, "revision"), "r2"),
      same("the default-instance patch kept the title", pick(home, "title"), "Home"),
      same("a Date in a patch is stored as a time", pick(native.value, "seenType"), "PTYPE<TIME>"),
      same("with its milliseconds", pick(native.value, "seenEpoch"), 1717243200.25),
      same("the record deleted by its number is gone", pick(native.value, "typed"), null),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
