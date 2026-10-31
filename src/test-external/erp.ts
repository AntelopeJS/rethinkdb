import { type Connection, r, type RTable } from "rethinkdb-ts";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { WaitForSchemaReady } from "../implementations/database/schema";
import { AdminConnection, CLIENT_DATABASE } from "./fixture";

const ERP = "erp";

/** The fixture declared as a generator writes it: native names, the key field and `_id` per keyed table. */
const ERP_DEFINITION: SchemaDefinition = {
  customers: {
    fields: {
      _id: "string",
      id: "string",
      name: "string",
      email: "string",
      segment: "string",
      created_at: "date",
      tags: "string[]",
      address: "object",
    },
    indexes: {
      email: { fields: ["email"] },
      tags: { fields: ["tags"], multi: true },
      tag_set: { fields: ["tags"] },
    },
  },
  products: {
    fields: {
      _id: "string",
      sku: "string",
      label: "string",
      price: "number",
      active: "boolean",
    },
    indexes: {},
  },
  products_mixed: { fields: { label: "string" }, indexes: {} },
  orders: {
    fields: {
      _id: "string",
      id: "string",
      customer_id: "string",
      status: "string",
      ordered_at: "date",
      total: "number",
      note: "string",
    },
    indexes: { customer_id: { fields: ["customer_id"] } },
  },
  order_lines: {
    fields: { _id: "string", sku: "string", qty: "number" },
    indexes: {},
  },
  events: {
    fields: { _id: "string", kind: "string", n: "number" },
    indexes: {},
  },
};

type ErpValue =
  | string
  | number
  | boolean
  | Date
  | null
  | (string | number)[]
  | ErpObject;

interface ErpObject {
  [field: string]: string | number;
}

export interface ErpRow {
  [field: string]: ErpValue;
}

export interface ErpTables {
  [table: string]: ErpRow;
}

/** Registers a declaration and waits for it, as a generated module's startup does. */
export async function RegisterErp(
  definition: SchemaDefinition = ERP_DEFINITION,
  schemaId: string = ERP,
): Promise<Schema<ErpTables>> {
  const schema = new Schema<ErpTables>(schemaId, definition);
  await WaitForSchemaReady(schemaId);
  return schema;
}

/** A ReQL query the client's owner runs. */
interface Runnable<T> {
  run(connection: Connection): Promise<T>;
}

/** The answer a native query over the same rows gives, as the client's owner runs it. */
export async function Native<T>(
  build: (table: (name: string) => RTable) => Runnable<T>,
): Promise<T> {
  const connection = await AdminConnection();
  try {
    return await build((name) => r.db(CLIENT_DATABASE).table(name)).run(
      connection,
    );
  } finally {
    await connection.close();
  }
}
