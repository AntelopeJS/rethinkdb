import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, pick, poolConfig, server, same, type Json } from "./session.ts";

const EXPRESSIONS = `const schema = new db.Schema("verify-expressions", { docs: { fields: {}, indexes: {} } });
await schema.createInstance("a");
const docs = schema.instance("a").table("docs");
const at = new Date("2024-03-05T06:07:08.125Z");
await docs.insert({ _id: "x", n: 7, f: 2.4, neg: -2.6, flags: 12, s: "Hello", e: "ann@gmail.com", u: "n\\u00e9\\u{1F600}", list: [3, 1, 2], nums: [0, 1, 2], empty: [], words: ["be", "alpha"], dates: [new Date("2024-02-01T00:00:00.000Z"), new Date("2024-01-01T00:00:00.000Z")], obj: { a: 1, b: "two" }, at, nil: null, yes: true, no: false });
const { ValueProxy } = db;
const ms = (proxy) => proxy.mul(1000).round();
return await docs.get("x").do((d) => ({
  add: d.key("n").add(3), sub: d.key("n").sub(2), mul: d.key("n").mul(2), div: d.key("n").div(2), mod: d.key("n").mod(3),
  round: d.key("f").round(), ceil: d.key("f").ceil(), floor: d.key("f").floor(), negRound: d.key("neg").round(), negCeil: d.key("neg").ceil(), negFloor: d.key("neg").floor(),
  band: d.key("flags").band(10), bor: d.key("flags").bor(3), bxor: d.key("flags").bxor(5), bnot: d.key("flags").bnot(), blshift: d.key("flags").blshift(2), brshift: d.key("flags").brshift(2), brshiftSign: d.key("flags").brshiftPreserveSign(2),
  gt: d.key("n").gt(6), ge: d.key("n").ge(7), lt: d.key("n").lt(7), le: d.key("n").le(7), textGt: d.key("s").gt("Apple"), dateLt: d.key("at").lt(new Date("2025-01-01T00:00:00.000Z")), dateGe: d.key("at").ge(new Date("2024-03-06T00:00:00.000Z")),
  eq: d.key("s").eq("Hello"), ne: d.key("s").ne("Hello"), and: d.key("yes").and(d.key("no")), or: d.key("yes").or(d.key("no")), not: d.key("no").not(),
  upcase: d.key("s").upcase(), downcase: d.key("s").downcase(), split: d.key("e").split("@"), concat: d.key("s").concat(" world"), addText: d.key("s").add("!"), strlen: d.key("u").strlen(), match: d.key("e").match("@gmail\\\\.com$"), noMatch: d.key("s").match("^x"),
  addNullText: d.key("s").add(null), addNullNumber: d.key("n").add(null), addNullField: d.key("n").add(d.key("nil")), addList: d.key("list").add([4]),
  index: d.key("list").index(0), includes: d.key("list").includes(2), includesNot: d.key("list").includes(9), slice: d.key("list").slice(0, 2), sliceFrom: d.key("list").slice(1),
  map: d.key("list").map((x) => x.mul(10)), filter: d.key("list").filter((x) => x.gt(1)), filterNumber: d.key("nums").filter((x) => x), isempty: d.key("list").isempty(), emptyIsempty: d.key("empty").isempty(),
  count: d.key("list").count(), sum: d.key("list").sum(), avg: d.key("list").avg(), min: d.key("list").min(), max: d.key("list").max(), textMin: d.key("words").min(), textMax: d.key("words").max(), dateMin: d.key("dates").min(), dateMax: d.key("dates").max(),
  merge: d.key("obj").merge({ c: 3 }), keys: d.key("obj").keys(), values: d.key("obj").values(), hasfields: d.hasfields("n", "s"), hasfieldsNot: d.hasfields("n", "zzz"),
  objKey: d.key("obj").key("a"), objKeyFallback: d.key("obj").key("zz", "fb"), nullFallback: d.key("nil", "fb"), proxyFallback: d.key("zzz", d.key("s")), nullDefault: d.key("nil").default(5), missingDefault: d.key("missing").default(6),
  constant: ValueProxy.constant(42).add(1),
  dayLater: d.key("at").add(86400), minuteEarlier: d.key("at").sub(60), sinceMidnightMs: ms(d.key("at").sub(new Date("2024-03-05T00:00:00.000Z"))),
  year: d.key("at").year("+00:00"), month: d.key("at").month("+00:00"), day: d.key("at").day("+00:00"), dayofweek: d.key("at").dayofweek("+00:00"), dayofyear: d.key("at").dayofyear("+00:00"),
  hours: d.key("at").hours("+00:00"), hoursAtPlus2: d.key("at").hours("+02:00"), minutes: d.key("at").minutes("+00:00"), secondsMs: ms(d.key("at").seconds("+00:00")), timeofdayMs: ms(d.key("at").timeofday("+00:00")), epochMs: ms(d.key("at").epoch()),
  during: d.key("at").during(ValueProxy.constant(new Date("2024-01-01T00:00:00.000Z")), ValueProxy.constant(new Date("2025-01-01T00:00:00.000Z"))),
  duringMs: d.key("at").during(Date.parse("2024-03-05T06:07:08.125Z"), Date.parse("2024-03-05T06:07:08.126Z")),
  duringMsAfter: d.key("at").during(Date.parse("2024-03-05T06:07:08.126Z"), Date.parse("2024-03-06T00:00:00.000Z")),
}));`;

const EXPECTED_EXPRESSIONS: [string, string, Json][] = [
  ["add", "add adds", 10], ["sub", "sub subtracts", 5], ["mul", "mul multiplies", 14], ["div", "div divides", 3.5], ["mod", "mod is the remainder", 1],
  ["round", "round rounds to the nearest integer", 2], ["ceil", "ceil rounds up", 3], ["floor", "floor rounds down", 2], ["negRound", "round of a negative number", -3], ["negCeil", "ceil of a negative number", -2], ["negFloor", "floor of a negative number", -3],
  ["band", "band", 8], ["bor", "bor", 15], ["bxor", "bxor", 9], ["bnot", "bnot", -13], ["blshift", "blshift", 48], ["brshift", "brshift", 3], ["brshiftSign", "brshiftPreserveSign", 3],
  ["gt", "gt", true], ["ge", "ge holds for an equal value", true], ["lt", "lt fails for an equal value", false], ["le", "le holds for an equal value", true], ["textGt", "gt compares text", true], ["dateLt", "lt compares dates", true], ["dateGe", "ge compares dates", false],
  ["eq", "eq", true], ["ne", "ne", false], ["and", "and", false], ["or", "or", true], ["not", "not", true],
  ["upcase", "upcase", "HELLO"], ["downcase", "downcase", "hello"], ["split", "split by a separator", ["ann", "gmail.com"]], ["concat", "concat", "Hello world"], ["addText", "add concatenates text", "Hello!"], ["strlen", "strlen counts Unicode codepoints", 3], ["match", "match tests a regex", true], ["noMatch", "match fails for another text", false],
  ["addNullText", "add of null on text answers null", null], ["addNullNumber", "add of null on a number answers null", null], ["addNullField", "add of a null field answers null", null], ["addList", "add concatenates lists", [3, 1, 2, 4]],
  ["index", "index", 3], ["includes", "includes", true], ["includesNot", "includes of an absent value", false], ["slice", "slice(start, end)", [3, 1]], ["sliceFrom", "slice(start)", [1, 2]],
  ["map", "map of a list", [30, 10, 20]], ["filter", "filter of a list", [3, 2]], ["filterNumber", "filter keeps a number unless it is 0", [1, 2]], ["isempty", "isempty of a list", false], ["emptyIsempty", "isempty of an empty list", true],
  ["count", "count of a list", 3], ["sum", "sum of a list", 6], ["avg", "avg of a list", 2], ["min", "min of numbers", 1], ["max", "max of numbers", 3], ["textMin", "min of text", "alpha"], ["textMax", "max of text", "be"], ["dateMin", "min of dates", "2024-01-01T00:00:00.000Z"], ["dateMax", "max of dates", "2024-02-01T00:00:00.000Z"],
  ["merge", "merge", { a: 1, b: "two", c: 3 }], ["keys", "keys", ["a", "b"]], ["values", "values", [1, "two"]], ["hasfields", "hasfields of present fields", true], ["hasfieldsNot", "hasfields of a missing field", false],
  ["objKey", "key of an object", 1], ["objKeyFallback", "key of a missing field with a fallback", "fb"], ["nullFallback", "key of a null field with a fallback", "fb"], ["proxyFallback", "key with a ValueProxy fallback", "Hello"], ["nullDefault", "default replaces null", 5], ["missingDefault", "default replaces a missing field", 6],
  ["constant", "ValueProxy.constant", 43],
  ["dayLater", "add of seconds to a date", "2024-03-06T06:07:08.125Z"], ["minuteEarlier", "sub of seconds from a date", "2024-03-05T06:06:08.125Z"], ["sinceMidnightMs", "sub of two dates is their difference in seconds, to the millisecond", 22028125],
  ["year", "year", 2024], ["month", "month", 3], ["day", "day", 5], ["dayofweek", "dayofweek", 2], ["dayofyear", "dayofyear", 65],
  ["hours", "hours", 6], ["hoursAtPlus2", "hours in another timezone", 8], ["minutes", "minutes", 7], ["secondsMs", "seconds, to the millisecond", 8125], ["timeofdayMs", "timeofday, to the millisecond", 22028125], ["epochMs", "epoch, to the millisecond", 1709618828125],
  ["during", "during with date bounds", true], ["duringMs", "during with millisecond bounds includes the lower one", true], ["duringMsAfter", "during with millisecond bounds after the instant", false],
];

export const readExpressions: Journey = {
  title: "every ValueProxy operation of docs/1.query_types/9.valueproxy.md computes its documented answer on a stored document: arithmetic, rounding, bitwise, comparison, logic, text, lists, objects, fallbacks and dates to the millisecond",
  entryPoint: "`table.get(id).do((d) => ({ ... }))` with each ValueProxy operation, from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run("compute every operation on one stored document", EXPRESSIONS);
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(
      result.folder,
      EXPECTED_EXPRESSIONS.map(([key, label, expected]) => same(label, pick(result.value, key), expected)),
    );
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
