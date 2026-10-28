import type {
  Categories,
  ColumnDescription,
  ColumnProfile,
  ColumnTrait,
  LengthStats,
  Measure,
  MonthCount,
  ProfileRequest,
  RelationProfile,
  RowCount,
  ValueRange,
} from "@antelopejs/interface-database-catalog";
import { r, type RDatum } from "rethinkdb-ts";

import { Located, Locate, SelectColumns } from "./locate";
import {
  Mapped,
  Measured,
  Sequentially,
  type Source,
  ValueOf,
} from "./measures";

const CATEGORY_LIMIT = 25;
const CATEGORY_MIN_ROWS = 5;
const ENUM_LIKE_MIN_ROWS = 100;
const MONTH_LIMIT = 36;
const LABEL_DISTINCT_SHARE = 0.9;
const LABEL_MAX_LENGTH = 80;
const TIME_AXIS_FILLED_SHARE = 0.9;
const TIME_AXIS_MIN_MONTHS = 3;
const MONTHS_PER_YEAR = 12;
const MONTH_TEXT_LENGTH = 7;
const UTC = "+00:00";

const READ_TYPES = new Map<string, string>([
  ["string", "STRING"],
  ["number", "NUMBER"],
  ["boolean", "BOOL"],
  ["date", "PTYPE<TIME>"],
]);
const CATEGORY_KINDS = new Set(["string", "number", "boolean"]);
const TRAITS: readonly ColumnTrait[] = [
  "enum-like",
  "identifier-like",
  "label-candidate",
  "time-axis",
  "measure",
];

interface ProfiledColumn {
  description: ColumnDescription;
  kind: string;
  value: (row: RDatum) => RDatum;
}

function Profiled(description: ColumnDescription): ProfiledColumn | undefined {
  const kind = description.accepts[0]?.declared ?? "";
  const type = READ_TYPES.get(kind);
  if (!type) {
    return undefined;
  }
  return {
    description,
    kind,
    value: (row) =>
      r.branch(
        row(description.name).default(null).typeOf().eq(type),
        row(description.name),
        null,
      ),
  };
}

function Present(source: Source, column: ProfiledColumn) {
  return source
    .rows()
    .map((row) => column.value(row))
    .filter((value: RDatum) => value.ne(null));
}

function Extreme(source: Source, column: ProfiledColumn, max: boolean) {
  const values = Present(source, column);
  return max ? values.max() : values.min();
}

function RangeEnd(value: number | Date): number | string {
  return value instanceof Date ? value.toISOString() : value;
}

async function Range(
  source: Source,
  column: ProfiledColumn,
): Promise<Measure<ValueRange>> {
  const min = await Measured<number | Date>(Extreme(source, column, false));
  const max = await Measured<number | Date>(Extreme(source, column, true));
  if (min.status !== "ok") {
    return min;
  }
  return max.status === "ok"
    ? {
        status: "ok",
        value: { min: RangeEnd(min.value), max: RangeEnd(max.value) },
      }
    : max;
}

async function Length(
  source: Source,
  column: ProfiledColumn,
): Promise<Measure<LengthStats>> {
  const lengths = () => Present(source, column).map((value) => value.count());
  const min = await Measured<number>(lengths().min());
  const avg = await Measured<number>(lengths().avg());
  const max = await Measured<number>(lengths().max());
  if (min.status !== "ok") {
    return min;
  }
  if (avg.status !== "ok") {
    return avg;
  }
  return max.status === "ok"
    ? {
        status: "ok",
        value: { min: min.value, avg: avg.value, max: max.value },
      }
    : max;
}

function AsCategories(rows: [string | number | boolean, number][]): Categories {
  return {
    values: rows
      .filter(([, count]) => count >= CATEGORY_MIN_ROWS)
      .slice(0, CATEGORY_LIMIT)
      .map(([value, count]) => ({ value, rows: count })),
    other: rows
      .filter(
        ([, count], index) =>
          count < CATEGORY_MIN_ROWS || index >= CATEGORY_LIMIT,
      )
      .reduce((total, [, count]) => total + count, 0),
  };
}

async function CategoriesOf(
  source: Source,
  column: ProfiledColumn,
): Promise<Measure<Categories>> {
  return Mapped(
    await Measured<[string | number | boolean, number][]>(
      Present(source, column)
        .group((value) => value)
        .count()
        .ungroup()
        .orderBy(r.desc("reduction"), "group")
        .limit(CATEGORY_LIMIT + 1)
        .map((group) => [group("group"), group("reduction")]),
    ),
    AsCategories,
  );
}

async function Months(
  source: Source,
  column: ProfiledColumn,
): Promise<Measure<MonthCount[]>> {
  return Mapped(
    await Measured<[string, number][]>(
      Present(source, column)
        .group((value) =>
          value.inTimezone(UTC).toISO8601().slice(0, MONTH_TEXT_LENGTH),
        )
        .count()
        .ungroup()
        .orderBy(r.desc("group"))
        .limit(MONTH_LIMIT)
        .map((group) => [group("group"), group("reduction")]),
    ),
    (rows) => rows.map(([month, count]) => ({ month, rows: count })).reverse(),
  );
}

function MonthsSpanned(range: ValueRange): number {
  const start = new Date(String(range.min));
  const end = new Date(String(range.max));
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * MONTHS_PER_YEAR +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1
  );
}

interface TraitFacts {
  column: ProfiledColumn;
  profile: ColumnProfile;
  rows: number | undefined;
  primaryKey: string;
}

function Filled(facts: TraitFacts): number {
  const nulls = ValueOf(facts.profile.nulls);
  return facts.rows === undefined || nulls === undefined
    ? 0
    : facts.rows - nulls;
}

const TRAIT_RULES: Record<ColumnTrait, (facts: TraitFacts) => boolean> = {
  "enum-like": (facts) =>
    facts.profile.categories !== undefined &&
    (ValueOf(facts.profile.distinct) ?? Infinity) <= CATEGORY_LIMIT &&
    (facts.rows ?? 0) >= ENUM_LIKE_MIN_ROWS,
  "identifier-like": (facts) =>
    (facts.rows ?? 0) > 0 &&
    ValueOf(facts.profile.nulls) === 0 &&
    ValueOf(facts.profile.distinct) === facts.rows,
  "label-candidate": (facts) => {
    const filled = Filled(facts);
    const length = ValueOf(facts.profile.length);
    return (
      facts.column.kind === "string" &&
      facts.column.description.name !== facts.primaryKey &&
      filled > 0 &&
      (ValueOf(facts.profile.distinct) ?? 0) >= LABEL_DISTINCT_SHARE * filled &&
      length !== undefined &&
      length.avg <= LABEL_MAX_LENGTH
    );
  },
  "time-axis": (facts) => {
    const range = ValueOf(facts.profile.range);
    return (
      facts.column.kind === "date" &&
      range !== undefined &&
      Filled(facts) >= TIME_AXIS_FILLED_SHARE * (facts.rows ?? Infinity) &&
      MonthsSpanned(range) >= TIME_AXIS_MIN_MONTHS
    );
  },
  measure: (facts) =>
    facts.column.kind === "number" &&
    facts.column.description.name !== facts.primaryKey,
};

async function ProfileColumn(
  source: Source,
  column: ProfiledColumn,
  facts: Pick<TraitFacts, "rows" | "primaryKey">,
): Promise<ColumnProfile> {
  const name = column.description.name;
  const profile: ColumnProfile = {
    name,
    nulls: await Measured<number>(
      source
        .rows()
        .filter((row: RDatum) => column.value(row).eq(null))
        .count(),
    ),
    distinct: await Measured<number>(
      Present(source, column).distinct().count(),
    ),
    traits: [],
  };
  if (column.kind === "number" || column.kind === "date") {
    profile.range = await Range(source, column);
  }
  if (column.kind === "string") {
    profile.length = await Length(source, column);
  }
  const isCategorical =
    (ValueOf(profile.distinct) ?? Infinity) <= CATEGORY_LIMIT;
  if (
    CATEGORY_KINDS.has(column.kind) &&
    isCategorical &&
    name !== facts.primaryKey
  ) {
    profile.categories = await CategoriesOf(source, column);
  }
  if (column.kind === "date") {
    profile.months = await Months(source, column);
  }
  profile.traits = TRAITS.filter((trait) =>
    TRAIT_RULES[trait]({ column, profile, ...facts }),
  );
  return profile;
}

async function RowsOf(located: Located): Promise<Measure<RowCount>> {
  if (located.source.sample) {
    return {
      status: "ok",
      value: { rows: located.source.estimatedRows, exact: false },
    };
  }
  return Mapped(
    await Measured<number>(located.source.rows().count()),
    (rows) => ({
      rows,
      exact: true,
    }),
  );
}

/**
 * Aggregates over one table, each measure one query on a connection of its own closed at its time
 * limit, over the whole table or its sample above the threshold. A value is named only as a
 * category.
 */
export async function ProfileTable(
  request: ProfileRequest,
): Promise<RelationProfile> {
  const located = await Locate(request.relation);
  const rows = await RowsOf(located);
  const measuredRows = located.source.sample?.rows ?? ValueOf(rows)?.rows;
  const columns = SelectColumns(located, request.columns)
    .map(Profiled)
    .filter((column): column is ProfiledColumn => column !== undefined);
  return {
    relation: request.relation,
    rows,
    sample: located.source.sample,
    columns: await Sequentially(columns, (column) =>
      ProfileColumn(located.source, column, {
        rows: measuredRows,
        primaryKey: located.table.primaryKey,
      }),
    ),
    references: [],
    inbound: [],
  };
}
