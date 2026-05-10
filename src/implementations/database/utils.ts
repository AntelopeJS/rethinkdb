import type { StagedObject } from "@antelopejs/interface-database/common";

export const TENANT_ID_FIELD = "tenant_id";

export type QueryStage = StagedObject["stages"][number];

export type ArgumentProvider = (subQuery: QueryStage[]) => any;

let nextArgNumber = 0;
export function allocateArgNumber() {
  return nextArgNumber++;
}

export class DecodingContext {
  public args: Record<number, ArgumentProvider> = {};
}
