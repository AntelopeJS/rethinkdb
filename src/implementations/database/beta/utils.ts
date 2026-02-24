import { StagedObject } from '@ajs.local/database/beta/common';

export type QueryStage = StagedObject['stages'][number];

export type ArgumentProvider = (subQuery: QueryStage[]) => any;

let nextArgNumber = 0;
export function allocateArgNumber() {
  return nextArgNumber++;
}

export class DecodingContext {
  public args: Record<number, ArgumentProvider> = {};
}
