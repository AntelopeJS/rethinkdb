import { r } from "rethinkdb-ts";

import { ExternalDatabaseName } from "../../config";

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

interface TableInfo {
  primary_key?: string;
  doc_count_estimates?: number[];
}

const DEFAULT_PRIMARY_KEY = "id";

const SAMPLE_SIZE = 1000;

/** The uuid shape the server generates, and a uuid-keyed table holds. */
export const UUID_TEXT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLE_FIELD = /return \w+\.getField\("([^"]+)"\); \}/;
const COMPOUND_FIELDS = /return r\.expr\(\[(.*)\]\); \}/;
const ROW_FIELD = /r\.row\("([^"]+)"\)/g;

/** The fields an index definition reads: one `getField`, or an array of `r.row` fields. */
export function IndexFields(query: string): string[] {
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
  const [first]: string[] = await Table(name)
    .orderBy({ index: primaryKey })
    .limit(1)
    .map((row) => row(primaryKey).typeOf())
    .run();
  const [last]: string[] = await Table(name)
    .orderBy({ index: r.desc(primaryKey) })
    .limit(1)
    .map((row) => row(primaryKey).typeOf())
    .run();
  return first && last ? [first, last] : undefined;
}

/** The ReQL types of the top-level fields of the first rows, grouped and counted. */
async function SampleTypes(
  name: string,
  size = SAMPLE_SIZE,
): Promise<SampledType[]> {
  const groups: [string, string, number][] = await Table(name)
    .limit(size)
    .concatMap((row) =>
      row.keys().map((key) => ({ f: key, t: row(key).typeOf() })),
    )
    .group("f", "t")
    .count()
    .ungroup()
    .map((group) => group("group").append(group("reduction")))
    .run();
  return groups.map(([field, type, count]) => ({ field, type, count }));
}

async function UuidKeys(name: string, primaryKey: string): Promise<boolean> {
  const keys: string[] = await Table(name).limit(SAMPLE_SIZE)(primaryKey).run();
  return (
    keys.length > 0 && keys.every((key) => UUID_TEXT_PATTERN.test(String(key)))
  );
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
  const statuses: IndexStatus[] = await Table(name)
    .indexStatus()
    .map((status) => ({
      index: status("index"),
      multi: status("multi"),
      query: status("query"),
    }))
    .run();
  return {
    name,
    primaryKey,
    estimatedRows: (info.doc_count_estimates ?? []).reduce(
      (sum, count) => sum + count,
      0,
    ),
    indexes: statuses.map((status) => ({
      name: status.index,
      fields: IndexFields(status.query),
      multi: status.multi,
    })),
    ends: await Ends(name, primaryKey),
    uuidKeys: await UuidKeys(name, primaryKey),
    sample: await SampleTypes(name),
  };
}
