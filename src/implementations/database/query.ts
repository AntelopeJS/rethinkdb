import assert from "node:assert";
import { Query, ValueProxy } from "@antelopejs/interface-database";
import type { Value } from "@antelopejs/interface-database/common";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";
import { SendQuery } from "../../connection";
import { Logger } from "../../utils/logger";
import { decodeExpression } from "./expression";
import { WaitForSchemaReady } from "./schema";
import { SelectionQuery } from "./selection";
import { DecodingContext, type QueryStage } from "./utils";

export function DecodeValue(
  value: Value<unknown>,
  context: DecodingContext,
): TermJson {
  if (value instanceof ValueProxy) {
    return decodeExpression(value.build(), context);
  }

  if (value instanceof Query) {
    return decodeSubquery(value.build(), context);
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return [
        TermType.MAKE_ARRAY,
        value.map((val) => DecodeValue(val, context)),
      ] as TermJson;
    }
    if (value instanceof Date) {
      return dateToReql(value);
    }
    if (value instanceof Object) {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          DecodeValue(val, context),
        ]),
      );
    }
  }

  if (value === undefined) {
    return undefined as any;
  }

  return value as TermJson;
}

function dateToReql(date: Date): TermJson {
  const timeZone = date.getTimezoneOffset();
  return {
    $reql_type$: "TIME",
    epoch_time: +date / 1000,
    timezone: `${timeZone <= 0 ? "+" : "-"}${Math.abs(Math.floor(timeZone / 60))
      .toFixed(0)
      .padStart(2, "0")}:${Math.abs(timeZone % 60)
      .toFixed(0)
      .padStart(2, "0")}`,
  };
}

function decodeSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): TermJson {
  if (stages[0]?.stage === "arg") {
    const num = stages[0].args[0];
    const provider = context.args[num];
    assert(provider, "Unknown arg used");
    return provider(stages);
  }
  return SelectionQuery.buildTermJson(stages, context);
}

export function DecodeFunction(
  func: QueryStage,
  context: DecodingContext,
  argTerms: TermJson[],
): TermJson {
  const argNumbers: number[] = func.args[0];
  const oldArgs: Record<number, any> = {};
  for (let i = 0; i < argNumbers.length; ++i) {
    oldArgs[argNumbers[i]] = context.args[argNumbers[i]];
    const argTerm = argTerms[i];
    context.args[argNumbers[i]] = () => argTerm;
  }
  const val = DecodeValue(func.args[1], context);
  for (let i = 0; i < argNumbers.length; ++i) {
    if (oldArgs[argNumbers[i]] !== undefined) {
      context.args[argNumbers[i]] = oldArgs[argNumbers[i]];
    } else {
      delete context.args[argNumbers[i]];
    }
  }
  return val;
}

export async function RunQuery(stages: QueryStage[]) {
  const context = new DecodingContext();
  const query = SelectionQuery.decode(stages, context);
  return query.run();
}

interface OpenCursor {
  cursor: Cursor;
  iterator: AsyncIterableIterator<any>;
  isChangeStream: boolean;
}

const openCursors = new Map<number, OpenCursor>();

export async function ReadCursor(reqId: number, stages: QueryStage[]) {
  if (!openCursors.has(reqId)) {
    const context = new DecodingContext();
    const query = SelectionQuery.decode(stages, context);
    await WaitForSchemaReady(query.schemaId);
    const term = query.buildTerm();
    Logger.Debug("Opening cursor #", reqId);
    const cursor = await SendQuery(term);
    assert(cursor, "Query returned no cursor.");
    const entry: OpenCursor = {
      cursor,
      iterator: cursor[Symbol.asyncIterator](),
      isChangeStream: query.isChangeStream,
    };
    openCursors.set(reqId, entry);
    cursor.on("close", () => {
      Logger.Debug("Cursor #", reqId, "closed by server");
      openCursors.delete(reqId);
    });
    cursor.init();
  }

  const entry = openCursors.get(reqId);
  assert(entry, `Cursor #${reqId} not found.`);
  const result = await entry.iterator.next();

  if (result.done) {
    openCursors.delete(reqId);
    return { done: true, value: undefined };
  }

  if (entry.isChangeStream) {
    return { done: false, value: mapChangeEvent(result.value) };
  }

  return { done: false, value: result.value };
}

function mapChangeEvent(change: any) {
  if (change.old_val === null || change.old_val === undefined) {
    return { changeType: "added" as const, newValue: change.new_val };
  }
  if (change.new_val === null || change.new_val === undefined) {
    return { changeType: "removed" as const, oldValue: change.old_val };
  }
  return {
    changeType: "modified" as const,
    oldValue: change.old_val,
    newValue: change.new_val,
  };
}

export async function CloseCursor(reqId: number) {
  const entry = openCursors.get(reqId);
  if (entry) {
    Logger.Debug("Closing cursor #", reqId);
    openCursors.delete(reqId);
    await entry.cursor.close();
  }
}

export { executeTermJson } from "../../connection";
