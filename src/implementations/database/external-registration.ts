import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Logger } from "../../utils/logger";
import { DescribeTable, type ExternalTable } from "./external-descriptor";
import { ProbeTable } from "./external-probe";

export type { ExternalTable } from "./external-descriptor";

/**
 * Describes every table of an external schema from the table of the same name, and creates,
 * alters and drops nothing. A table the database cannot honour fails the whole registration with
 * a message naming it; warnings and notices are logged once per registration.
 */
export async function RegisterExternalSchema(
  schemaId: string,
  schema: SchemaDefinition,
): Promise<Record<string, ExternalTable>> {
  const tables: Record<string, ExternalTable> = {};
  for (const [tableId, table] of Object.entries(schema)) {
    const facts = await ProbeTable(`${schemaId}.${tableId}`, tableId);
    const described = DescribeTable({ schemaId, tableId, table }, facts);
    described.warnings.forEach((warning) => Logger.Warn(warning));
    described.notices.forEach((notice) => Logger.Info(notice));
    tables[tableId] = described.table;
  }
  return tables;
}
