import type {
  ColumnDescription,
  RelationDescription,
} from "@antelopejs/interface-database-catalog";

import { ExternalDatabaseName } from "../../config";
import { TableNames } from "../database/external-probe";
import { DescribeTable, ListTable, type ListedTable } from "./discovery";
import { type Source, SourceFor } from "./measures";

/** A table a catalog call names, found, described, and its source of rows. */
export interface Located {
  table: ListedTable;
  description: RelationDescription;
  source: Source;
}

/** Finds `"database.table"` in the configured database, which is the only schema it has. */
export async function Locate(relation: string): Promise<Located> {
  const database = ExternalDatabaseName();
  const dot = relation.indexOf(".");
  const name = relation.slice(dot + 1);
  const found =
    dot > 0 &&
    relation.slice(0, dot) === database &&
    (await TableNames()).includes(name);
  if (!found) {
    throw new Error(
      `Relation '${relation}' does not exist in database ${database}, or the connected account cannot list it`,
    );
  }
  const table = await ListTable(name);
  return {
    table,
    description: await DescribeTable(table),
    source: SourceFor(table.name, table.estimatedRows, table.uuidKeys),
  };
}

/** The described columns a request names, in its order, every one when it names none. */
export function SelectColumns(
  located: Located,
  names: string[] | undefined,
): ColumnDescription[] {
  const columns = located.description.columns;
  const unknown = (names ?? []).filter(
    (name) => !columns.some((column) => column.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Relation '${located.table.name}' has no field ${unknown.join(", ")} in its sample`,
    );
  }
  return names
    ? names.flatMap((name) => columns.filter((column) => column.name === name))
    : columns;
}
