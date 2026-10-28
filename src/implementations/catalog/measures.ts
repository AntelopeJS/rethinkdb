import type {
  Measure,
  SampleInfo,
} from "@antelopejs/interface-database-catalog";
import { type Connection, r, type RStream } from "rethinkdb-ts";

import { DirectConnection } from "../../connection";
import { Table } from "../database/external-probe";

const DEFAULT_MEASURE_TIMEOUT_MS = 5000;
const DEFAULT_SAMPLE_THRESHOLD_ROWS = 1_000_000;
const SAMPLE_SIZE = 50_000;
const SAMPLE_POINTS = 50;
const ROWS_PER_POINT = 1000;
const PERCENT = 100;
const HEX = 16;
const UUID_DIGITS = 32;

let measureTimeoutMs = DEFAULT_MEASURE_TIMEOUT_MS;
let sampleThresholdRows = DEFAULT_SAMPLE_THRESHOLD_ROWS;

/** Overrides the per-measure time limit, for the suite that proves a slow measure answers `timeout`. */
export function SetMeasureTimeoutForTests(ms?: number): void {
  measureTimeoutMs = ms ?? DEFAULT_MEASURE_TIMEOUT_MS;
}

/** Overrides the sampling threshold, for the suite that proves a uuid-keyed sample repeats. */
export function SetSampleThresholdForTests(rows?: number): void {
  sampleThresholdRows = rows ?? DEFAULT_SAMPLE_THRESHOLD_ROWS;
}

/** The rows a measure reads: the whole table, or a sample of a large one. */
export interface Source {
  rows: () => RStream;
  /** The first rows, in an order that a second read repeats. */
  head: (limit: number) => RStream;
  sample: SampleInfo | null;
  estimatedRows: number;
}

/** A query a measure runs, as the query builder gives it. */
interface Runnable<T> {
  run(connection: Connection): Promise<T>;
}

const TIMEOUT = new Error("the measure ran out of time");

function EvenUuid(index: number): string {
  const step = HEX ** UUID_DIGITS / SAMPLE_POINTS;
  const hex = BigInt(Math.floor(step * index))
    .toString(HEX)
    .padStart(UUID_DIGITS, "0")
    .slice(0, UUID_DIGITS);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The rows §3 reads: the whole table up to the threshold; above it, 1000 rows from each of 50
 * evenly spaced uuids of a uuid-keyed table, which a second profile reads again, else `sample()`.
 */
export function SourceFor(
  name: string,
  estimatedRows: number,
  uuidKeys: boolean,
): Source {
  if (estimatedRows <= sampleThresholdRows) {
    return {
      rows: () => Table(name),
      head: (limit) => Table(name).limit(limit),
      sample: null,
      estimatedRows,
    };
  }
  const sampled = uuidKeys ? SAMPLE_POINTS * ROWS_PER_POINT : SAMPLE_SIZE;
  const rows = uuidKeys
    ? () => {
        const [first, ...rest] = Array.from(
          { length: SAMPLE_POINTS },
          (_, index) =>
            Table(name)
              .between(EvenUuid(index), r.maxval)
              .limit(ROWS_PER_POINT),
        );
        return first.union(...rest);
      }
    : () => Table(name).sample(SAMPLE_SIZE);
  return {
    rows,
    head: (limit) =>
      uuidKeys
        ? Table(name).between(EvenUuid(0), r.maxval).limit(limit)
        : Table(name).sample(limit),
    sample: {
      percent: Math.min(PERCENT, (sampled / estimatedRows) * PERCENT),
      rows: sampled,
    },
    estimatedRows,
  };
}

/** One measure, on a connection of its own closed at the time limit, which stops it on the server. */
export function Measured<T>(query: Runnable<T>): Promise<Measure<T>> {
  return Bounded(query, measureTimeoutMs);
}

/** One read of a description, bounded by the default time limit whatever a test sets. */
export function Described<T>(query: Runnable<T>): Promise<Measure<T>> {
  return Bounded(query, DEFAULT_MEASURE_TIMEOUT_MS);
}

async function Bounded<T>(
  query: Runnable<T>,
  timeoutMs: number,
): Promise<Measure<T>> {
  const connection = await DirectConnection();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(TIMEOUT);
      void connection.close();
    }, timeoutMs);
  });
  try {
    return {
      status: "ok",
      value: await Promise.race([query.run(connection), expired]),
    };
  } catch (error) {
    if (error === TIMEOUT) {
      return { status: "timeout" };
    }
    return {
      status: "error",
      code: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    clearTimeout(timer);
    void connection.close().catch(() => undefined);
  }
}

export function ValueOf<T>(measured: Measure<T> | undefined): T | undefined {
  return measured?.status === "ok" ? measured.value : undefined;
}

export function Mapped<T, R>(
  measured: Measure<T>,
  read: (value: T) => R,
): Measure<R> {
  return measured.status === "ok"
    ? { status: "ok", value: read(measured.value) }
    : measured;
}

/** Runs `work` over `items` one after another, never two reads at once. */
export async function Sequentially<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await work(item));
  }
  return results;
}

let queue: Promise<void> = Promise.resolve();

/** Runs one catalog call at a time per instance. */
export function Serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
