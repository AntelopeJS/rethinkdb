import {
  type RowSample,
  SAMPLE_ROWS_LIMIT,
  SAMPLE_TEXT_LENGTH,
  type SampledValue,
  type SampleRequest,
} from "@antelopejs/interface-database-catalog";

import { Locate, SelectColumns } from "./locate";
import { Measured } from "./measures";
import { type RowValue, TextOf } from "./text";

interface SampledRow {
  [field: string]: RowValue | Buffer;
}

function CheckedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SAMPLE_ROWS_LIMIT) {
    throw new Error(
      `A sample answers from 1 to ${SAMPLE_ROWS_LIMIT} rows, not ${limit}`,
    );
  }
  return limit;
}

function Sampled(value: RowValue | Buffer): SampledValue {
  if (Buffer.isBuffer(value)) {
    return { bytes: value.length };
  }
  const text = TextOf(value);
  return text === undefined
    ? null
    : {
        text: text.slice(0, SAMPLE_TEXT_LENGTH),
        truncated: text.length > SAMPLE_TEXT_LENGTH,
      };
}

/**
 * The first rows of a table, or of its sample, as text cut at {@link SAMPLE_TEXT_LENGTH}: a binary
 * value by its length.
 */
export async function SampleTableRows(
  request: SampleRequest,
): Promise<RowSample> {
  const limit = CheckedLimit(request.limit);
  const located = await Locate(request.relation);
  const columns = SelectColumns(located, request.columns).map(
    (column) => column.name,
  );
  const measured = await Measured<SampledRow[]>(located.source.head(limit));
  if (measured.status !== "ok") {
    throw new Error(
      `The sample of '${request.relation}' did not finish: ${measured.status === "timeout" ? "timeout" : measured.code}`,
    );
  }
  return {
    relation: request.relation,
    columns,
    rows: measured.value.map((row) =>
      columns.map((column) => Sampled(row[column])),
    ),
    sample: located.source.sample && {
      ...located.source.sample,
      rows: measured.value.length,
    },
  };
}
