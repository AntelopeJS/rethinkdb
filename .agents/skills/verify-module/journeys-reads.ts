import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const SEED = `const schema = new db.Schema("verify-reads", {
  products: { fields: { name: "string", price: "number", category: "string", addedAt: "date", secret: "string" }, indexes: { category: {}, price: {}, addedAt: {} } },
  orders: { fields: { productId: "string", qty: "number" }, indexes: {} },
});
await schema.createInstance("a");
const products = schema.instance("a").table("products");
const orders = schema.instance("a").table("orders");
await products.insert([
  { _id: "p1", name: "Atlas", price: 10, category: "books", addedAt: new Date("2024-01-01T00:00:00.000Z"), secret: "s1" },
  { _id: "p2", name: "Bible", price: 20, category: "books", addedAt: new Date("2024-02-01T00:00:00.000Z"), secret: "s2" },
  { _id: "p3", name: "Cable", price: 30, category: "tools", addedAt: new Date("2024-03-01T00:00:00.000Z"), secret: "s3" },
  { _id: "p4", name: "Drill", price: 30, category: "tools", addedAt: new Date("2024-04-01T00:00:00.000Z"), secret: "s4" },
  { _id: "p5", name: "Easel", price: 50, category: "art", addedAt: new Date("2024-05-01T00:00:00.000Z"), secret: "s5" },
]);
await orders.insert([{ _id: "o1", productId: "p1", qty: 2 }, { _id: "o2", productId: "p1", qty: 3 }, { _id: "o3", productId: "p3", qty: 1 }, { _id: "o4", productId: "none", qty: 9 }]);
const names = (rows) => rows.map((row) => row.name);
const out = {};
`;

export const readSelections: Journey = {
  title: "get, getAll, between, filter, pluck, without, orderBy, slice and iteration read the stored rows the way docs/1.query_types and docs/2.operations describe",
  entryPoint: "`table.get/getAll/between/filter/pluck/without/orderBy/slice` and `for await` from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "read selections",
      `${SEED}
out.get = (await products.get("p2")).name;
out.getMissing = (await products.get("nope")) == null ? "absent" : "present";
out.getAllKeys = names(await products.getAll(["p5", "p1"])).sort();
out.getAllIndex = names(await products.getAll("books", "category")).sort();
out.getAllIndexList = names(await products.getAll(["art", "tools"], "category")).sort();
out.between = names(await products.between("price", 20, 50)).sort();
out.betweenDates = names(await products.between("addedAt", new Date("2024-02-01T00:00:00.000Z"), new Date("2024-04-01T00:00:00.000Z"))).sort();
out.filter = names(await products.filter((p) => p.key("price").gt(15).and(p.key("category").eq("tools")))).sort();
out.pluck = await products.get("p1").pluck("name", "price");
out.without = Object.keys((await products.filter((p) => p.key("_id").eq("p1")).without("secret", "addedAt"))[0]).filter((key) => key !== "tenant_id").sort();
out.orderDesc = names(await products.orderBy("price", "desc").slice(0, 1));
out.orderAsc = (await products.orderBy("price", "asc").slice(0, 2)).map((p) => p.price);
out.page = names(await products.orderBy("addedAt").slice(1, 2));
out.count = await products.count();
const seen = [];
for await (const row of products.orderBy("addedAt")) seen.push(row.name);
out.iterated = seen;
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("get reads one row by its primary key", part(result, "get"), "Bible"),
      sees("get of an unknown key reads nothing", part(result, "getMissing"), "absent"),
      sees("getAll with a list reads the rows of those keys", part(result, "getAllKeys"), ["Atlas", "Easel"]),
      sees("getAll with an index reads the rows with that value", part(result, "getAllIndex"), ["Atlas", "Bible"]),
      sees("getAll with a list of values and an index reads each value", part(result, "getAllIndexList"), ["Cable", "Drill", "Easel"]),
      sees("between includes the lower bound and excludes the upper", part(result, "between"), ["Bible", "Cable", "Drill"]),
      sees("between works on dates", part(result, "betweenDates"), ["Bible", "Cable"]),
      sees("filter keeps the rows the predicate holds for", part(result, "filter"), ["Cable", "Drill"]),
            sees("without removes the listed fields", part(result, "without"), ["_id", "category", "name", "price"]),
      sees("orderBy ascending with slice reads the cheapest rows", part(result, "orderAsc"), [10, 20]),
      sees("orderBy descending with slice reads the dearest row", part(result, "orderDesc"), ["Easel"]),
      sees("slice(offset, count) pages the ordered rows", part(result, "page"), ["Bible", "Cable"]),
      sees("count counts the rows", part(result, "count"), 5),
      sees("iterating the table reads every row in order", part(result, "iterated"), ["Atlas", "Bible", "Cable", "Drill", "Easel"]),
    ]);
    const plucked = pick(result.value, "pluck");
    context.expect(result.folder, [same("pluck keeps name", pick(plucked, "name"), "Atlas"), same("pluck keeps price", pick(plucked, "price"), 10), same("pluck drops the others", pick(plucked, "category"), undefined)]);
    const native = await owner(context, "count the stored products", `return await r.db("verify-reads").table("products").count().run(c);`);
    context.expect(native.folder, [same("five rows are stored", native.value, 5)]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

export const readStreams: Journey = {
  title: "map, key, default, union, distinct, aggregates, group, join, joinInner and lookup compute the answers docs/1.query_types/5.stream.md describes",
  entryPoint: "`table.map/key/union/distinct/sum/avg/min/max/group/join/joinInner/lookup` from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "read streams",
      `${SEED}
out.keys = (await products.key("name")).sort();
out.defaulted = await products.get("p1").key("missing").default("N/A");
out.map = (await products.map((p) => ({ label: p.key("name"), double: p.key("price").mul(2) }))).sort((a, b) => a.double - b.double).slice(0, 2);
out.union = names(await products.filter((p) => p.key("category").eq("art")).union(products.filter((p) => p.key("category").eq("books")))).sort();
out.distinct = (await products.distinct("category")).sort();
out.sum = await products.sum("price");
out.avg = await products.avg("price");
out.min = await products.min("price");
out.max = await products.max("price");
out.group = (await products.group("category", (stream, category) => ({ category, total: stream.count(), sum: stream.sum("price") }))).sort((a, b) => a.category < b.category ? -1 : 1);
out.joinInner = (await products.joinInner(orders, (p, o) => o.key("productId").eq(p.key("_id")), (p, o) => ({ name: p.key("name"), qty: o.key("qty") }))).sort((a, b) => a.qty - b.qty);
out.join = (await orders.join(products, (o, p) => p.key("_id").eq(o.key("productId")), (o, p) => ({ order: o.key("_id"), name: p.key("name").default("-") }))).map((row) => row.order + ":" + row.name).sort();
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("key reads one field of every row", part(result, "keys"), ["Atlas", "Bible", "Cable", "Drill", "Easel"]),
      sees("default replaces a missing field", part(result, "defaulted"), "N/A"),
      sees("map builds the computed documents", part(result, "map"), [{ double: 20, label: "Atlas" }, { double: 40, label: "Bible" }]),
      sees("union concatenates two streams", part(result, "union"), ["Atlas", "Bible", "Easel"]),
      sees("distinct of a field reads each value once", part(result, "distinct"), ["art", "books", "tools"]),
      sees("sum adds the field", part(result, "sum"), 140),
      sees("avg averages the field", part(result, "avg"), 28),
      sees("min reads the smallest", part(result, "min"), 10),
      sees("max reads the largest", part(result, "max"), 50),
      sees("group applies the mapper to each group", part(result, "group"), [
        { category: "art", sum: 50, total: 1 },
        { category: "books", sum: 30, total: 2 },
        { category: "tools", sum: 60, total: 2 },
      ]),
      sees("joinInner keeps the pairs that match", part(result, "joinInner"), [{ name: "Cable", qty: 1 }, { name: "Atlas", qty: 2 }, { name: "Atlas", qty: 3 }]),
      sees("join keeps every left row, with the default for an unmatched one", part(result, "join"), ["o1:Atlas", "o2:Atlas", "o3:Cable", "o4:-"]),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
