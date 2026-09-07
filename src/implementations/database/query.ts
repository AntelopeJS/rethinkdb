import assert from "node:assert";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";

import { Logger } from "../../utils/logger";
import { SendQuery } from "../../connection";
import { SelectionQuery } from "./selection";
import { DecodingContext, type QueryStage } from "./utils";
import {
  CreateInstance,
  DestroyInstance,
  ListInstances,
  WaitForSchemaReady,
} from "./schema";

type SchemaStageHandler = (
  schemaId: string,
  stages: QueryStage[],
) => Promise<any>;

const SCHEMA_STAGE_HANDLERS: Record<string, SchemaStageHandler> = {
  instance: async (schemaId, stages) => {
    await WaitForSchemaReady(schemaId);
    const context = new DecodingContext();
    return SelectionQuery.decode(stages, context).run();
  },
  createInstance: (schemaId, stages) =>
    CreateInstance(schemaId, stages[1]?.options?.id),
  destroyInstance: (schemaId, stages) =>
    DestroyInstance(schemaId, stages[1]?.options?.id),
  listInstances: (schemaId) => ListInstances(schemaId),
};

export async function RunQuery(stages: QueryStage[]) {
  assert(stages[0]?.stage === "schema", "Expected schema stage");
  const schemaId = stages[0].options?.id;
  assert(schemaId, "Unknown schema");

  const next = stages[1]?.stage;
  const handler = next ? SCHEMA_STAGE_HANDLERS[next] : undefined;
  assert(handler, `Unknown schema stage '${next}'`);
  return handler(schemaId, stages);
}

interface OpenCursor {
  cursor: Cursor;
  iterator: AsyncIterableIterator<any>;
  isChangeStream: boolean;
}

const openCursors = new Map<number, OpenCursor>();

export async function ReadCursor(reqId: number, stages: QueryStage[]) {
  if (!openCursors.has(reqId)) {
    assert(stages[0]?.stage === "schema", "Expected schema stage");
    const schemaId = stages[0].options?.id;
    assert(schemaId, "Unknown schema");
    await WaitForSchemaReady(schemaId);
    const context = new DecodingContext();
    const query = SelectionQuery.decode(stages, context);
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
