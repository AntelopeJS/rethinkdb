import { r } from "rethinkdb-ts";

import { ExternalDatabaseName } from "../../config";
import { IsList, IsNumber, IsObject, IsText, IsTextList } from "./utils";

/** One secondary index, with the fields its definition reads when it reads plain fields. */
export interface IndexFacts {
  name: string;
  fields: string[];
  multi: boolean;
}

/** How many sampled rows hold a top-level field with a value of one ReQL type. */
interface SampledType {
  field: string;
  type: string;
  count: number;
}

export interface TableFacts {
  name: string;
  primaryKey: string;
  estimatedRows: number;
  indexes: IndexFacts[];
  /** The `typeOf` of the primary index's first and last keys; absent for an empty table. */
  ends?: [string, string];
  /** Whether every sampled key is a uuid, which the server generates on insert. */
  uuidKeys: boolean;
  sample: SampledType[];
}

interface IndexStatus {
  index: string;
  multi: boolean;
  query: string;
}

/** Whether `value` is an index's status as `Indexes` maps it: its name, multi flag and definition. */
function IsIndexStatus(value: unknown): value is IndexStatus {
  return (
    IsObject(value) &&
    "index" in value &&
    IsText(value.index) &&
    "multi" in value &&
    typeof value.multi === "boolean" &&
    "query" in value &&
    IsText(value.query)
  );
}

/** Whether `value` is one sampled group: a field, a ReQL type and how many rows hold it. */
function IsSampledGroup(value: unknown): value is [string, string, number] {
  return (
    IsList(value) &&
    value.length === 3 &&
    IsText(value[0]) &&
    IsText(value[1]) &&
    IsNumber(value[2])
  );
}

interface TableInfo {
  primary_key?: string;
  doc_count_estimates?: number[];
}

const DEFAULT_PRIMARY_KEY = "id";

const SAMPLE_SIZE = 1000;

/** The uuid shape the server generates, and a uuid-keyed table holds. */
const UUID_TEXT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLE_FIELD = /return \w+\.getField\("([^"]+)"\); \}/;
const COMPOUND_FIELDS = /return r\.expr\(\[(.*)\]\); \}/;
const ROW_FIELD = /r\.row\("([^"]+)"\)/g;

/** The fields an index definition reads: one `getField`, or an array of `r.row` fields. */
function IndexFields(query: string): string[] {
  const single = SINGLE_FIELD.exec(query);
  if (single) {
    return [single[1]];
  }
  const compound = COMPOUND_FIELDS.exec(query)?.[1];
  return compound
    ? [...compound.matchAll(ROW_FIELD)].map((match) => match[1])
    : [];
}

export function Table(name: string) {
  return r.db(ExternalDatabaseName()).table(name);
}

export async function TableNames(): Promise<string[]> {
  return r.db(ExternalDatabaseName()).tableList().run();
}

export async function Ends(
  name: string,
  primaryKey: string,
): Promise<[string, string] | undefined> {
  const firsts: unknown = await Table(name)
    .orderBy({ index: primaryKey })
    .limit(1)
    .map((row) => row(primaryKey).typeOf())
    .run();
  const lasts: unknown = await Table(name)
    .orderBy({ index: r.desc(primaryKey) })
    .limit(1)
    .map((row) => row(primaryKey).typeOf())
    .run();
  const [first] = IsTextList(firsts) ? firsts : [];
  const [last] = IsTextList(lasts) ? lasts : [];
  return first && last ? [first, last] : undefined;
}

/** The ReQL types of the top-level fields of the first rows, grouped and counted. */
async function SampleTypes(
  name: string,
  size = SAMPLE_SIZE,
): Promise<SampledType[]> {
  const groups: unknown = await Table(name)
    .limit(size)
    .concatMap((row) =>
      row.keys().map((key) => ({ f: key, t: row(key).typeOf() })),
    )
    .group("f", "t")
    .count()
    .ungroup()
    .map((group) => group("group").append(group("reduction")))
    .run();
  return IsList(groups)
    ? groups
        .filter(IsSampledGroup)
        .map(([field, type, count]) => ({ field, type, count }))
    : [];
}

/** Whether the first keys of a table are all uuids, which the server generates on insert. */
export async function UuidKeys(
  name: string,
  primaryKey: string,
): Promise<boolean> {
  const keys: unknown = await Table(name).limit(SAMPLE_SIZE)(primaryKey).run();
  return (
    IsList(keys) &&
    keys.length > 0 &&
    keys.every((key) => UUID_TEXT_PATTERN.test(String(key)))
  );
}

/** A table's secondary indexes, with the fields each definition reads. */
export async function Indexes(name: string): Promise<IndexFacts[]> {
  const statuses: unknown = await Table(name)
    .indexStatus()
    .map((status) => ({
      index: status("index"),
      multi: status("multi"),
      query: status("query"),
    }))
    .run();
  return IsList(statuses)
    ? statuses.filter(IsIndexStatus).map((status) => ({
        name: status.index,
        fields: IndexFields(status.query),
        multi: status.multi,
      }))
    : [];
}

/** Reads one table's facts, writing nothing; a table the database lacks fails, naming it. */
export async function ProbeTable(
  path: string,
  name: string,
): Promise<TableFacts> {
  if (!(await TableNames()).includes(name)) {
    throw new Error(
      `Table '${path}' reads table ${name}, which database ${ExternalDatabaseName()} does not have`,
    );
  }
  const info: TableInfo = await Table(name).info().run();
  const primaryKey = info.primary_key ?? DEFAULT_PRIMARY_KEY;
  const indexes = await Indexes(name);
  return {
    name,
    primaryKey,
    estimatedRows: (info.doc_count_estimates ?? []).reduce(
      (sum, count) => sum + count,
      0,
    ),
    indexes,
    ends: await Ends(name, primaryKey),
    uuidKeys: await UuidKeys(name, primaryKey),
    sample: await SampleTypes(name),
  };
}
