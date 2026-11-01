import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const SEED = `const schema = new db.Schema("verify-reads", {
  products: { fields: { name: "string", price: "number", category: "string", addedAt: "date", secret: "string", note: "string", meta: "object" }, indexes: { category: {}, price: {}, addedAt: {}, cat_name: { fields: ["category", "name"] } } },
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
  { _id: "p5", name: "Easel", price: 50, category: "art", addedAt: new Date("2024-05-01T00:00:00.000Z"), secret: "s5", note: null, meta: { dims: { w: 3 } } },
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
  title: "map, key, a document's key with a fallback, default, do, union, distinct, count, count(field), sum, avg, min, max, group, join, joinInner, lookup, nth, orderBy on a compound index, cursor and run compute the answers docs/1.query_types describes",
  entryPoint: "`table.map/key/default/do/union/distinct/count/sum/avg/min/max/group/join/joinInner/lookup/nth/orderBy/cursor/run` from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "read streams",
      `${SEED}
out.keys = (await products.key("name")).sort();
out.keysByProxy = (await products.key(db.ValueProxy.constant("name"))).sort();
out.defaulted = await products.get("p1").key("missing").default("N/A");
out.map = (await products.map((p) => ({ label: p.key("name"), double: p.key("price").mul(2) }))).sort((a, b) => a.double - b.double).slice(0, 2);
out.union = names(await products.filter((p) => p.key("category").eq("art")).union(products.filter((p) => p.key("category").eq("books")))).sort();
out.unionOverlap = names(await products.filter((p) => p.key("price").ge(20)).union(products.filter((p) => p.key("category").eq("tools")))).sort();
out.distinct = (await products.distinct("category")).sort();
out.sum = await products.sum("price");
out.avg = await products.avg("price");
out.min = await products.min("price");
out.max = await products.max("price");
out.group = (await products.group("category", (stream, category) => ({ category, total: stream.count(), sum: stream.sum("price") }))).sort((a, b) => a.category < b.category ? -1 : 1);
out.joinInner = (await products.joinInner(orders, (p, o) => o.key("productId").eq(p.key("_id")), (p, o) => ({ name: p.key("name"), qty: o.key("qty") }))).sort((a, b) => a.qty - b.qty);
out.join = (await orders.join(products, (o, p) => p.key("_id").eq(o.key("productId")), (o, p) => ({ order: o.key("_id"), name: p.key("name").default("-") }))).map((row) => row.order + ":" + row.name).sort();
out.joinRight = await (async () => { try { return (await orders.join(products, (o, p) => p.key("_id").eq(o.key("productId")), (o, p) => ({ order: o.key("_id"), product: p }))).filter((row) => row.order === "o4").map((row) => row.product); } catch (error) { return String(error.message); } })();
out.lookupOne = (await orders.lookup(products, "productId", "_id")).filter((o) => o._id !== "o4").map((o) => [o._id, o.productId.name]).sort();
const looked = await orders.get("o3").lookup(products, "productId", "_id");
out.lookupDatum = [looked._id, looked.qty, looked.productId.name, looked.productId.price];
out.nthFirst = (await products.orderBy("price").nth(0)).name;
out.nthFourth = (await products.orderBy("addedAt").nth(3)).name;
out.countField = await products.count("category");
out.countAll = await orders.count();
out.datumKeyFallback = [await products.get("p5").key("note", "none"), await products.get("p2").key("name", "none"), await products.get("p2").key("color", "plain")];
out.datumKeyChain = await products.get("p5").key("meta").key("dims").key("w");
out.datumDefault = await products.get("nope").default({ name: "Guest" });
out.datumDo = await products.get("p1").do((p) => ({ label: p.key("name"), twice: p.key("price").mul(2) }));
out.distinctMapped = (await orders.map((o) => o.key("productId")).distinct()).sort();
out.sumStream = await products.key("price").sum();
out.orderCompoundDesc = names(await products.orderBy("cat_name", "desc"));
out.orderCompoundAsc = names(await products.orderBy("cat_name"));
const cursor = products.orderBy("addedAt", "desc").cursor();
const pulled = [];
for (let step = await cursor.next(); !step.done; step = await cursor.next()) pulled.push(step.value.name);
out.cursor = pulled;
out.run = (await products.filter((p) => p.key("category").ne("books")).run()).length;
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("key reads one field of every row", part(result, "keys"), ["Atlas", "Bible", "Cable", "Drill", "Easel"]),
      sees("key with a ValueProxy yielding the field name reads that field of every row", part(result, "keysByProxy"), ["Atlas", "Bible", "Cable", "Drill", "Easel"]),
      sees("default replaces a missing field", part(result, "defaulted"), "N/A"),
      sees("map builds the computed documents", part(result, "map"), [{ double: 20, label: "Atlas" }, { double: 40, label: "Bible" }]),
      sees("union concatenates two streams", part(result, "union"), ["Atlas", "Bible", "Easel"]),
      sees("union keeps a row both streams hold, twice", part(result, "unionOverlap"), ["Bible", "Cable", "Cable", "Drill", "Drill", "Easel"]),
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
      sees("join answers null for the right side of a left row nothing matches, without a default", part(result, "joinRight"), [null]),
      sees("lookup of a single key replaces it with the document it names", part(result, "lookupOne"), [["o1", "Atlas"], ["o2", "Atlas"], ["o3", "Cable"]]),
      sees("lookup on a single document replaces its key with the document and keeps its fields", part(result, "lookupDatum"), ["o3", 1, "Cable", 30]),
      sees("nth(0) reads the first row in order", part(result, "nthFirst"), "Atlas"),
      sees("nth(3) reads the fourth row in order", part(result, "nthFourth"), "Drill"),
      sees("count(field) counts the distinct values of the field", part(result, "countField"), 3),
      sees("count() counts every row", part(result, "countAll"), 4),
      sees("key(field, fallback) of a document reads the fallback for null and missing, and the value otherwise", part(result, "datumKeyFallback"), ["none", "Bible", "plain"]),
      sees("key chains read a nested field", part(result, "datumKeyChain"), 3),
      sees("default replaces a missing document", part(result, "datumDefault"), { name: "Guest" }),
      sees("do builds a value from the document", part(result, "datumDo"), { label: "Atlas", twice: 20 }),
      sees("distinct() of a mapped stream reads each value once", part(result, "distinctMapped"), ["none", "p1", "p3"]),
      sees("sum() of a stream of numbers adds them", part(result, "sumStream"), 140),
      sees("orderBy on a compound index descending orders by every field of the index", part(result, "orderCompoundDesc"), ["Drill", "Cable", "Bible", "Atlas", "Easel"]),
      sees("orderBy on a compound index ascending orders by every field of the index", part(result, "orderCompoundAsc"), ["Easel", "Atlas", "Bible", "Cable", "Drill"]),
      sees("cursor() yields the rows one at a time, in order", part(result, "cursor"), ["Easel", "Drill", "Cable", "Bible", "Atlas"]),
      sees("run() executes the query", part(result, "run"), 3),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
