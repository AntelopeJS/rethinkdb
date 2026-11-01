import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, pick, poolConfig, server, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const FEEDS = `const schema = new db.Schema("verify-feeds", { notes: { fields: { body: "string" }, indexes: {} } });
await schema.createInstance("a");
await schema.createInstance("b");
const a = schema.instance("a").table("notes");
const b = schema.instance("b").table("notes");
await a.insert({ _id: "n1", body: "first" });
const within = (promise, ms) => Promise.race([promise, waitFor(ms).then(() => null)]);
const watch = async (feed, write, expected) => {
  const iterator = feed[Symbol.asyncIterator]();
  const events = [];
  let pending = iterator.next();
  await waitFor(1500);
  await write();
  while (events.length < expected) {
    const step = await within(pending, 5000);
    if (!step || step.done) break;
    events.push(step.value);
    if (events.length < expected) pending = iterator.next();
  }
  await within(iterator.return(), 2000);
  return events.map((event) => ({ type: event.changeType, old: event.oldValue === undefined ? "<none>" : event.oldValue.body, new: event.newValue === undefined ? "<none>" : event.newValue.body }));
};
const out = {};
out.table = await watch(a.changes(), async () => {
  await b.insert({ _id: "m1", body: "other instance" });
  await a.insert({ _id: "n2", body: "second" });
  await a.get("n2").update({ body: "edited" });
  await a.get("n2").delete();
}, 3);
out.document = await watch(a.get("n1").changes(), async () => {
  await a.insert({ _id: "n3", body: "another document" });
  await a.get("n1").update({ body: "one" });
  await a.get("n1").delete();
}, 2);
out.left = (await a).map((note) => note._id).sort();
return out;`;

export const changeFeeds: Journey = {
  title: "changes() of a table and of one document yield added, modified and removed events with the old and new documents, one per iteration, and only for the instance they were opened on",
  entryPoint: "`for await (const change of table.changes())` and `table.get(id).changes()` from a consumer module, while the same module writes",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run("watch a table and a document while writing", FEEDS);
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("a table feed yields an added, a modified and a removed event, and nothing of another instance", part(result, "table"), [
        { new: "second", old: "<none>", type: "added" },
        { new: "edited", old: "second", type: "modified" },
        { new: "<none>", old: "edited", type: "removed" },
      ]),
      sees("a document feed yields its own modified and removed events, and nothing of another document", part(result, "document"), [
        { new: "one", old: "first", type: "modified" },
        { new: "<none>", old: "one", type: "removed" },
      ]),
      sees("the writes the feeds watched are stored", part(result, "left"), ["n3"]),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
