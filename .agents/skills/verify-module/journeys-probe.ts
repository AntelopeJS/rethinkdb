import type { Journey, JourneyContext } from "@antelopejs/tooling-configs/verify";

import { parseJson, tuple, type Json } from "./json.ts";
import { begin, owner, pick, same, server } from "./session.ts";

const SETUP = `const make = async (name) => { await r.dbCreate(name).run(c); };
await make("probe_empty");
await make("probe_shop");
await r.db("probe_shop").tableCreate("orders").run(c);
await r.db("probe_shop").table("orders").insert({ id: 1 }).run(c);
for (const user of ["reader", "builder"]) await r.db("rethinkdb").table("users").insert({ id: user, password: "pw" }).run(c);
await r.db("probe_empty").grant("reader", { read: true }).run(c);
await r.db("probe_empty").grant("builder", { read: true, config: true }).run(c);
await r.db("probe_shop").grant("reader", { read: true }).run(c);
await r.db("probe_shop").grant("builder", { read: true, config: true }).run(c);
return null;`;

/** Runs `probe` of the built module outside the AntelopeJS runtime, once per URL, and answers what it resolved with, latency left out. */
async function probes(context: JourneyContext, name: string, paths: string[]): Promise<{ folder: string; answers: Json | undefined }> {
  const endpoint = server(context);
  const code = `const { probe } = require(process.argv[1] + "/dist/probe");
(async () => {
  const answers = [];
  for (const url of process.argv.slice(4)) {
    const answer = await probe({ url: url.replace("HOST", process.argv[2] + ":" + process.argv[3]), timeoutMs: 5000, signal: new AbortController().signal });
    const { latencyMs, message, ...rest } = answer;
    answers.push(rest);
  }
  console.log(JSON.stringify(answers));
})();`;
  const result = await context.command(name, "node", ["-e", code, context.repo, endpoint.host, String(endpoint.port), ...paths], { cwd: context.repo });
  return { folder: result.folder, answers: parseJson(result.stdout.trim().split("\n").pop() ?? "") };
}

export const connectionProbe: Journey = {
  title: "the connection probe signs in with a URL and answers read and write access, counting the right to create tables as write access, and changes nothing",
  entryPoint: "`probe({ url, timeoutMs })` required from `@antelopejs/rethinkdb/dist/probe` outside the AntelopeJS runtime",
  async run(context) {
    await begin(context);
    const setup = await owner(context, "create the databases and accounts the probe asks about", SETUP);
    context.expect(setup.folder, [same("the setup ran", setup.exitCode, 0)], { critical: true });
    const answered = await probes(context, "probe each account and database", [
      "rethinkdb://admin@HOST/probe_empty",
      "rethinkdb://reader:pw@HOST/probe_empty",
      "rethinkdb://builder:pw@HOST/probe_empty",
      "rethinkdb://reader:pw@HOST/probe_shop",
      "rethinkdb://builder:pw@HOST/probe_shop",
      "rethinkdb://admin@HOST/probe_missing",
      "rethinkdb://admin@HOST",
      "rethinkdb://reader:wrong@HOST/probe_shop",
    ]);
    const answer = (position: number, key: string) => pick(answered.answers, position, key);
    context.expect(answered.folder, [
      same("every URL was answered", Array.isArray(answered.answers) ? answered.answers.length : -1, 8),
      same("admin on a database with no table reads it and may build in it", tuple(answer(0, "outcome"), answer(0, "canRead"), answer(0, "canWrite")), ["signed-in", true, true]),
      same("an account that may only read a database with no table does not write", tuple(answer(1, "outcome"), answer(1, "user"), answer(1, "canRead"), answer(1, "canWrite")), ["signed-in", "reader", true, false]),
      same("an account with the config right on a database with no table writes", tuple(answer(2, "user"), answer(2, "canRead"), answer(2, "canWrite")), ["builder", true, true]),
      same("an account that may only read a database with tables does not write", tuple(answer(3, "canRead"), answer(3, "canWrite")), [true, false]),
      same("an account with the config right on a database with tables writes, though it may not write a table", tuple(answer(4, "canRead"), answer(4, "canWrite")), [true, true]),
      same("a database the server lacks answers no access", tuple(answer(5, "outcome"), answer(5, "canRead"), answer(5, "canWrite"), answer(5, "unreadable")), ["signed-in", false, false, "no-database"]),
      same("a URL with no database answers no access", tuple(answer(6, "canRead"), answer(6, "canWrite"), answer(6, "unreadable")), [false, false, "no-database-named"]),
      same("a wrong password is refused", tuple(answer(7, "outcome"), answer(7, "refusal")), ["refused", "credentials"]),
    ]);
    const after = await owner(context, "read the structure the probes left", `return { empty: await r.db("probe_empty").tableList().run(c), shop: await r.db("probe_shop").tableList().run(c), rows: await r.db("probe_shop").table("orders").count().run(c) };`);
    context.expect(after.folder, [same("the probes created no table and wrote no row", after.value, { empty: [], rows: 1, shop: ["orders"] })]);
  },
};
