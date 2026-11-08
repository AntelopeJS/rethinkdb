import { has, interrupted, lacks, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, logs, open, owner, pick, poolConfig, same, server } from "./session.ts";

const MESSAGE = /Index 'status' of table 'verify-gate\.items' is declared unique: true/;

const DECLARE_AND_QUERY = `const schema = new db.Schema("verify-gate", { items: { fields: {}, indexes: { status: { unique: true } } } });
await waitFor(1000);
const out = {};
try { await schema.createInstance("a"); out.createInstance = "answered"; } catch (error) { out.createInstance = String(error && error.message); }
try { await schema.instance("a").table("items").count(); out.count = "answered"; } catch (error) { out.count = String(error && error.message); }
return out;`;

/** A refused registration is kept by the schema gate: `ajs project dev` stays up, every query on the schema fails with the refusal, and the module logs it once. */
export const refusedRegistrationKept: Journey = {
  title: "a schema whose registration is refused leaves `ajs project dev` running, every query on it rejects with the refusal's message, and the project logs the failure once",
  entryPoint: "`new Schema(id, { items: { indexes: { status: { unique: true } } } })` in a consumer module, then `createInstance` and a query on it, then another request to the same project",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const refused = await session.run("declare the refused schema and query it", DECLARE_AND_QUERY);
    context.expect(refused.folder, [
      answered(refused),
      has("createInstance rejects with the refusal's message", JSON.stringify(pick(refused.value, "createInstance") ?? null), MESSAGE),
      has("a query on the schema rejects with the refusal's message", JSON.stringify(pick(refused.value, "count") ?? null), MESSAGE),
    ]);
    const alive = await session.run("ask the project again after the refusal", `return "alive";`);
    context.expect(alive.folder, [answered(alive), same("the project still answers after the refusal", alive.value, "alive")], { critical: true });
    const output = await logs(session);
    context.expect(alive.folder, [
      same("the project logs the failure once", output.match(/Schema 'verify-gate' failed to register/g)?.length ?? 0, 1),
      has("the logged failure carries the refusal's message", output, MESSAGE),
      lacks("no rejection is left unhandled", output, /unhandled/i),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
    const native = await owner(context, "list the databases", `return await r.dbList().run(c);`);
    context.expect(native.folder, [same("no database was created for the refused schema", native.value, ["rethinkdb", "test"])]);
  },
};
