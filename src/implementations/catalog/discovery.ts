import type {
  CatalogInfo,
  Measure,
  ColumnDescription,
  DeclaredReading,
  RelationDescription,
  RelationSummary,
  RelationWrites,
} from "@antelopejs/interface-database-catalog";
import { r, type RStream } from "rethinkdb-ts";

import { ExternalDatabaseName, GetOptions } from "../../config";
import { KeyOf } from "../database/external-descriptor";
import {
  Ends,
  type IndexFacts,
  IndexFields,
  Table,
  UUID_TEXT_PATTERN,
} from "../database/external-probe";
import { Described, type Source, SourceFor, ValueOf } from "./measures";

/** A table of the configured database, with what its listing and its info say. */
export interface ListedTable {
  name: string;
  primaryKey: string;
  estimatedRows: number;
  uuidKeys: boolean;
}

interface TableInfo {
  primary_key?: string;
  doc_count_estimates?: number[];
}

interface IndexStatus {
  index: string;
  multi: boolean;
  query: string;
}

interface FieldType {
  type: string;
  count: number;
}

const DEFAULT_PRIMARY_KEY = "id";
const KEY_SAMPLE = 1000;
const FALLBACK_ROWS = 1000;
const UNREACHABLE_KEY = "__antelopejs_write_probe__ no row has this key";
const DOMINANT_SHARE = 0.8;
const PERCENT = 100;
const NULL_TYPE = "NULL";
const READ_ONLY =
  "an embedded value comes back altered by a read, so it is never written";

const READINGS = new Map<string, string>([
  ["STRING", "string"],
  ["NUMBER", "number"],
  ["BOOL", "boolean"],
  ["PTYPE<TIME>", "date"],
  ["OBJECT", "object"],
  ["ARRAY", "array"],
]);

export async function ReadInfo(): Promise<CatalogInfo> {
  const version: string = await r
    .db("rethinkdb")
    .table("server_status")
    .nth(0)("process")("version")
    .run()
    .catch(() => "unknown");
  return {
    engine: "rethinkdb",
    version,
    database: ExternalDatabaseName(),
    role: GetOptions().pool?.user ?? "admin",
  };
}

export async function ListTable(name: string): Promise<ListedTable> {
  const info: TableInfo = await Table(name).info().run();
  const primaryKey = info.primary_key ?? DEFAULT_PRIMARY_KEY;
  const keys: string[] = await Table(name).limit(KEY_SAMPLE)(primaryKey).run();
  return {
    name,
    primaryKey,
    estimatedRows: (info.doc_count_estimates ?? []).reduce(
      (sum, count) => sum + count,
      0,
    ),
    uuidKeys:
      keys.length > 0 &&
      keys.every((key) => UUID_TEXT_PATTERN.test(String(key))),
  };
}

/**
 * Whether the account may write a table, from a delete of a key no row has: it answers a
 * permission error to a reader and `skipped: 1` to a writer, and changes nothing either way.
 */
async function Writes(name: string): Promise<RelationWrites> {
  const allowed = await Table(name)
    .get(UNREACHABLE_KEY)
    .delete()
    .run()
    .then(
      () => true,
      () => false,
    );
  return { insert: allowed, update: allowed, delete: allowed };
}

export async function Summarize(table: ListedTable): Promise<RelationSummary> {
  const finding = KeyOf({ ends: await Ends(table.name, table.primaryKey) });
  return {
    schema: ExternalDatabaseName(),
    name: table.name,
    kind: "table",
    estimatedRows: table.estimatedRows,
    estimate: "statistics",
    key: finding.key
      ? { columns: [table.primaryKey], source: "primary" }
      : null,
    writes: await Writes(table.name),
    comment: null,
  };
}

async function Indexes(name: string): Promise<IndexFacts[]> {
  const statuses: IndexStatus[] = await Table(name)
    .indexStatus()
    .map((status) => ({
      index: status("index"),
      multi: status("multi"),
      query: status("query"),
    }))
    .run();
  return statuses.map((status) => ({
    name: status.index,
    fields: IndexFields(status.query),
    multi: status.multi,
  }));
}

function FieldTypes(
  rows: RStream,
): Promise<Measure<[string, string, number][]>> {
  return Described(
    rows
      .concatMap((row) =>
        row.keys().map((key) => ({ f: key, t: row(key).typeOf() })),
      )
      .group("f", "t")
      .count()
      .ungroup()
      .map((group) => group("group").append(group("reduction"))),
  );
}

/**
 * The ReQL types of every top-level field of the source, in first-seen order. A sample whose read
 * runs out of time is read again from its first 1,000 rows.
 */
async function SampledFields(
  source: Source,
): Promise<Map<string, FieldType[]>> {
  const measured = await FieldTypes(source.rows());
  const groups: [string, string, number][] =
    ValueOf(
      measured.status === "timeout"
        ? await FieldTypes(source.head(FALLBACK_ROWS))
        : measured,
    ) ?? [];
  const fields = new Map<string, FieldType[]>();
  for (const [field, type, count] of groups) {
    fields.set(field, [...(fields.get(field) ?? []), { type, count }]);
  }
  return fields;
}

function Values(types: FieldType[]): FieldType[] {
  return types
    .filter((entry) => entry.type !== NULL_TYPE)
    .sort((left, right) => right.count - left.count);
}

function Total(types: FieldType[]): number {
  return types.reduce((sum, entry) => sum + entry.count, 0);
}

function Shares(types: FieldType[]): string {
  const values = Values(types);
  return values
    .map(
      (entry) =>
        `${entry.type} ${Math.round((entry.count / Total(values)) * PERCENT)}%`,
    )
    .join(" | ");
}

function Accepts(types: FieldType[], elements: FieldType[]): DeclaredReading[] {
  const values = Values(types);
  const [first] = values;
  const kind =
    first && first.count >= DOMINANT_SHARE * Total(values)
      ? READINGS.get(first.type)
      : undefined;
  if (!kind) {
    return [];
  }
  const unread = values.filter((entry) => entry !== first);
  const lossy = unread.map(
    (entry) =>
      `${entry.count} of ${Total(values)} values are ${entry.type} and read as null`,
  );
  const declared = kind === "array" ? ArrayDeclaration(elements) : kind;
  if (!declared) {
    return [];
  }
  return [
    lossy.length > 0 ? { declared, lossy: lossy.join("; ") } : { declared },
  ];
}

function ArrayDeclaration(elements: FieldType[]): string | undefined {
  const values = Values(elements);
  const kind = values.length === 1 ? READINGS.get(values[0].type) : undefined;
  return kind && kind !== "array" ? `${kind}[]` : undefined;
}

async function ElementTypes(
  source: Source,
  field: string,
): Promise<FieldType[]> {
  const groups: [string, number][] =
    ValueOf(
      await Described(
        source
          .rows()
          .concatMap((row) => row(field).default([]))
          .group((element) => element.typeOf())
          .count()
          .ungroup()
          .map((group) => [group("group"), group("reduction")]),
      ),
    ) ?? [];
  return groups.map(([type, count]) => ({ type, count }));
}

async function Column(
  source: Source,
  table: ListedTable,
  name: string,
  types: FieldType[],
  rows: number,
): Promise<ColumnDescription> {
  const elements =
    Values(types)[0]?.type === "ARRAY" ? await ElementTypes(source, name) : [];
  const accepts = Accepts(types, elements);
  const kind = READINGS.get(Values(types)[0]?.type ?? "");
  const column: ColumnDescription = {
    name,
    native: Shares(types) || "NULL",
    nullable: Total(Values(types)) < rows,
    hasDefault: name === table.primaryKey && table.uuidKeys,
    generated: false,
    identity: null,
    accepts,
    comment: null,
  };
  if (accepts.length === 0) {
    column.unsupported =
      Values(types).length === 0
        ? "the sample holds only null for it"
        : `no type covers 80% of the sampled values: ${Shares(types)}`;
  }
  if (kind === "object" || kind === "array") {
    column.readOnly = READ_ONLY;
  }
  return column;
}

/** One table in full: its summary, its fields from a sample, and its indexes. */
export async function DescribeTable(
  table: ListedTable,
): Promise<RelationDescription> {
  const summary = await Summarize(table);
  const source = SourceFor(table.name, table.estimatedRows, table.uuidKeys);
  const fields = await SampledFields(source);
  const rows = Math.max(
    0,
    ...[...fields.values()].map((types) => Total(types)),
  );
  const names = [
    table.primaryKey,
    ...[...fields.keys()].filter((name) => name !== table.primaryKey),
  ];
  const columns: ColumnDescription[] = [];
  for (const name of names.filter((field) => fields.has(field))) {
    columns.push(
      await Column(source, table, name, fields.get(name) ?? [], rows),
    );
  }
  return {
    ...summary,
    columns,
    indexes: (await Indexes(table.name)).map((index) => ({
      name: index.name,
      columns: index.fields,
      unique: false,
    })),
    references: [],
    referencedBy: [],
  };
}
