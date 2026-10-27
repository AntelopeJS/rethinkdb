import type {
  Measure,
  ReferenceCheck,
  ReferenceMatch,
} from "@antelopejs/interface-database-catalog";
import { r, type RDatum } from "rethinkdb-ts";

import { Table } from "../database/external-probe";
import { Locate, SelectColumns } from "./locate";
import { Measured } from "./measures";
import { type RowValue, TextOf } from "./text";

/** The most distinct child values a check probes the target with. */
const CHECKED_VALUES = 1000;

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * A child value with the form a key of the other type would hold, as a key is addressed: `"42"`
 * also probes `42`, and `42` also probes `"42"`.
 */
function AddressedAs(value: RowValue): RowValue[] {
  if (value?.constructor === String && NUMBER_TEXT.test(String(value))) {
    return [value, Number(value)];
  }
  return value?.constructor === Number ? [value, String(value)] : [value];
}

/**
 * How many of a field's non-null values another field holds, for a reference RethinkDB does not
 * declare: up to 1000 distinct child values from the sample, probed through the target's primary
 * key, or the target field's index when it has one, else a scan.
 */
export async function CheckTableReference(
  check: ReferenceCheck,
): Promise<Measure<ReferenceMatch>> {
  const from = await Locate(check.from.relation);
  SelectColumns(from, [check.from.column]);
  const to = await Locate(check.to.relation);
  SelectColumns(to, [check.to.column]);
  const grouped = await Measured<[RowValue, number][]>(
    from.source
      .rows()
      .filter((row: RDatum) => row(check.from.column).default(null).ne(null))
      .group(check.from.column)
      .count()
      .ungroup()
      .orderBy(r.desc("reduction"))
      .limit(CHECKED_VALUES)
      .map((group) => [group("group"), group("reduction")]),
  );
  if (grouped.status !== "ok") {
    return grouped;
  }
  const values = r.expr(
    grouped.value.flatMap(([value]) => AddressedAs(value ?? null)),
  );
  const isKey = check.to.column === to.table.primaryKey;
  const index = to.description.indexes.find(
    (candidate) =>
      candidate.columns.length === 1 &&
      candidate.columns[0] === check.to.column,
  );
  const target = isKey
    ? Table(to.table.name).getAll(r.args(values))
    : index
      ? Table(to.table.name).getAll(r.args(values), { index: index.name })
      : Table(to.table.name).filter((row: RDatum) =>
          values.contains(row(check.to.column)),
        );
  const found = await Measured<RowValue[]>(target(check.to.column).distinct());
  if (found.status !== "ok") {
    return found;
  }
  const texts = new Set(found.value.map((value) => TextOf(value)));
  const checkedRows = grouped.value.reduce(
    (total, [, count]) => total + count,
    0,
  );
  const foundRows = grouped.value
    .filter(([value]) => texts.has(TextOf(value)))
    .reduce((total, [, count]) => total + count, 0);
  return {
    status: "ok",
    value: {
      containment: checkedRows > 0 ? foundRows / checkedRows : 0,
      checkedRows,
      sampled:
        from.source.sample !== null || grouped.value.length === CHECKED_VALUES,
      targetIsKey: isKey,
    },
  };
}
