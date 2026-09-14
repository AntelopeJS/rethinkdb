import assert from "node:assert";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

// oxlint-disable-next-line import/no-cycle -- sub-query building applies stream stages; see expression.ts
import { applyStreamStages } from "./stream";
import { executeTermJson } from "../../connection";
// oxlint-disable-next-line import/no-cycle -- sub-query building decodes values; see expression.ts
import { DecodeFunction, DecodeValue } from "./expression";
import { IsValidInstance, WaitForSchemaReady } from "./schema";
import {
  allocateArgNumber,
  DecodingContext,
  type QueryStage,
  TENANT_ID_FIELD,
} from "./utils";

type ResultType =
  | "stream"
  | "table"
  | "selection"
  | "insert"
  | "update"
  | "replace"
  | "delete";

type TenantContext = { kind: "scoped"; tenantId: string } | { kind: "cross" };

const WRITE_STAGES = new Set(["insert", "update", "replace", "delete"]);
const PRE_STREAM_STAGES = new Set([
  "get",
  "getAll",
  "between",
  "insert",
  "update",
  "replace",
  "delete",
]);

function resolveTenantContext(
  schemaId: string,
  tableName: string,
  instanceId: unknown,
): TenantContext {
  if (instanceId === CROSS_INSTANCE) {
    return { kind: "cross" };
  }
  if (instanceId !== undefined && typeof instanceId !== "string") {
    throw new Error(
      `Invalid instance id for table '${tableName}': expected string or CROSS_INSTANCE, got ${typeof instanceId}`,
    );
  }
  const tenantId = instanceId ?? "";
  if (!IsValidInstance(schemaId, tenantId)) {
    throw new Error(
      `Instance '${tenantId}' of schema '${schemaId}' does not exist; call createInstance first`,
    );
  }
  return { kind: "scoped", tenantId };
}

export class SelectionQuery {
  public resultType: ResultType = "table";
  public isChangeStream = false;
  public singleElement = false;
  private newValue: any;
  private conflictMode?: "update" | "replace";
  private insertRawArgs?: any;
  private term: TermJson;
  private readonly tenant: TenantContext;
  private scopedGet = false;

  public constructor(
    public readonly schemaId: string,
    public readonly instanceId: string | typeof CROSS_INSTANCE | undefined,
    public readonly tableName: string,
    public readonly database: string,
    private context: DecodingContext,
  ) {
    this.tenant = resolveTenantContext(schemaId, tableName, instanceId);
    const baseTerm: TermJson = [
      TermType.TABLE,
      [[TermType.DB, [database]], tableName],
    ];
    if (this.tenant.kind === "scoped") {
      this.term = [
        TermType.GET_ALL,
        [baseTerm, this.tenant.tenantId],
        { index: TENANT_ID_FIELD },
      ];
    } else {
      this.term = baseTerm;
    }
  }

  public static buildTermJson(
    stages: QueryStage[],
    context: DecodingContext,
  ): TermJson {
    const query = SelectionQuery.decode(stages, context);
    return query.buildTerm();
  }

  public static decode(
    stages: QueryStage[],
    context: DecodingContext,
  ): SelectionQuery {
    assert(stages[0]?.stage === "schema", "Expected schema stage");
    const schemaId = stages[0].options?.id;
    assert(schemaId, "Unknown schema");

    assert(stages[1]?.stage === "instance", "Expected instance stage");
    const instanceId = stages[1].options?.id;
    assert(stages[2]?.stage === "table", "Expected table stage");
    const tableName = stages[2].options.id;

    const query = new SelectionQuery(
      schemaId,
      instanceId,
      tableName,
      schemaId,
      context,
    );
    query.addStages(stages.slice(3));
    return query;
  }

  private addStages(stages: QueryStage[]) {
    let writeStage: QueryStage | undefined;
    const lastStage = stages[stages.length - 1];
    if (lastStage && WRITE_STAGES.has(lastStage.stage)) {
      writeStage = lastStage;
      stages = stages.slice(0, -1);
    }

    const preStreamStages: QueryStage[] = [];
    const streamStages: QueryStage[] = [];

    for (const stage of stages) {
      if (PRE_STREAM_STAGES.has(stage.stage) && streamStages.length === 0) {
        preStreamStages.push(stage);
      } else {
        streamStages.push(stage);
      }
    }

    for (const stage of preStreamStages) {
      this.applySelectionStage(stage);
    }

    if (this.scopedGet && !writeStage && streamStages[0]?.stage !== "changes") {
      this.term = [TermType.DEFAULT, [[TermType.NTH, [this.term, 0]], null]];
    }

    if (streamStages.length > 0) {
      const result = applyStreamStages(
        this.term,
        streamStages,
        this.context,
        this.schemaId,
        this.tableName,
        this.singleElement,
      );
      this.term = result.term;
      this.isChangeStream = result.isChangeStream;
      if (result.singleElement) {
        this.singleElement = true;
      }
    }

    if (writeStage) {
      this.applySelectionStage(writeStage);
    }
  }

  private applySelectionStage(stage: QueryStage) {
    const handler = SELECTION_STAGES[stage.stage];
    if (handler) {
      handler(this, stage);
    }
  }

  public buildTerm(): TermJson {
    return this.term;
  }

  public async run(): Promise<any> {
    await WaitForSchemaReady(this.schemaId);
    const RUN_HANDLERS: Record<string, () => Promise<any>> = {
      insert: () => this.runInsert(),
      update: () => this.runUpdate(),
      replace: () => this.runReplace(),
      delete: () => this.runDelete(),
    };

    const handler = RUN_HANDLERS[this.resultType];
    if (handler) {
      return handler();
    }

    const result = await executeTermJson(this.term);
    if (result === null && this.singleElement) {
      return undefined;
    }
    return result;
  }

  private async runInsert() {
    if (this.tenant.kind === "cross") {
      throw new Error(
        `Insert with CROSS_INSTANCE is not supported on table '${this.tableName}'`,
      );
    }
    let value = this.newValue;
    if (this.tenant.kind === "scoped") {
      value = this.stampTenantId(value, this.tenant.tenantId);
    }
    const insertOpts = this.conflictMode ? { conflict: this.conflictMode } : {};
    const insertTerm: TermJson = [
      TermType.INSERT,
      [this.getTableTerm(), value],
      insertOpts,
    ];
    const result = await executeTermJson(insertTerm);
    if (!this.conflictMode) {
      return result?.generated_keys ?? [];
    }
    return this.buildConflictInsertKeys(result?.generated_keys ?? []);
  }

  private buildConflictInsertKeys(generatedKeys: string[]): string[] {
    const rawDocs = Array.isArray(this.insertRawArgs)
      ? this.insertRawArgs
      : [this.insertRawArgs];
    let genIdx = 0;
    return rawDocs.map(
      (doc: any) => doc._id ?? doc.id ?? generatedKeys[genIdx++],
    );
  }

  private stampTenantId(value: any, tenantId: string): any {
    if (Array.isArray(value) && value[0] === TermType.MAKE_ARRAY) {
      return [
        TermType.MAKE_ARRAY,
        value[1].map((doc: any) => this.stampTenantId(doc, tenantId)),
      ];
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...value, [TENANT_ID_FIELD]: tenantId };
    }
    return value;
  }

  public getTableTerm(): TermJson {
    return [TermType.TABLE, [[TermType.DB, [this.database]], this.tableName]];
  }

  public setGet(key: TermJson) {
    this.resultType = "selection";
    this.singleElement = true;
    this.scopedGet = this.isScopedTenant();
    this.term = this.scopedGet
      ? this.buildTenantFilterTerm([
          TermType.GET_ALL,
          [this.getTableTerm(), key],
        ])
      : [TermType.GET, [this.term, key]];
  }

  public buildTenantFilterTerm(baseTerm: TermJson): TermJson {
    assert(this.tenant.kind === "scoped");
    const tenantId = this.tenant.tenantId;
    const argId = allocateArgNumber();
    const filterFn: TermJson = [
      TermType.FUNC,
      [
        [TermType.MAKE_ARRAY, [argId]],
        [
          TermType.EQ,
          [
            [TermType.BRACKET, [[TermType.VAR, [argId]], TENANT_ID_FIELD]],
            tenantId,
          ],
        ],
      ],
    ];
    return [TermType.FILTER, [baseTerm, filterFn]];
  }

  public isScopedTenant(): boolean {
    return this.tenant.kind === "scoped";
  }

  public isSimpleTable(): boolean {
    return (
      !this.isScopedTenant() &&
      Array.isArray(this.term) &&
      this.term[0] === TermType.TABLE
    );
  }

  public getContext(): DecodingContext {
    return this.context;
  }

  private async runUpdate() {
    const updateTerm: TermJson = [TermType.UPDATE, [this.term, this.newValue]];
    const result = await executeTermJson(updateTerm);
    return result?.replaced ?? 0;
  }

  private async runReplace() {
    if (this.tenant.kind === "cross") {
      throw new Error(
        `Replace with CROSS_INSTANCE is not supported on table '${this.tableName}' (would silently strip the tenant_id from the replaced document; use update for cross-instance mutations)`,
      );
    }
    const argId = allocateArgNumber();
    const oldDoc: TermJson = [TermType.VAR, [argId]];
    let replaceValue = this.newValue;
    if (this.tenant.kind === "scoped") {
      replaceValue = {
        ...replaceValue,
        [TENANT_ID_FIELD]: this.tenant.tenantId,
      };
    }
    const merged: TermJson = [
      TermType.MERGE,
      [replaceValue, { _id: [TermType.BRACKET, [oldDoc, "_id"]] }],
    ];
    const func: TermJson = [
      TermType.FUNC,
      [[TermType.MAKE_ARRAY, [argId]], merged],
    ];
    const replaceTerm: TermJson = [TermType.REPLACE, [this.term, func]];
    const result = await executeTermJson(replaceTerm);
    return result?.replaced ?? 0;
  }

  private async runDelete() {
    const deleteTerm: TermJson = [TermType.DELETE, [this.term]];
    const result = await executeTermJson(deleteTerm);
    return result?.deleted ?? 0;
  }

  public setTerm(term: TermJson) {
    this.term = term;
  }

  public setNewValue(value: any) {
    this.newValue = value;
  }

  public setConflictMode(mode?: "update" | "replace") {
    this.conflictMode = mode;
  }

  public setInsertRawArgs(args: any) {
    this.insertRawArgs = args;
  }
}

type SelectionStageHandler = (query: SelectionQuery, stage: QueryStage) => void;

const SELECTION_STAGES: Record<string, SelectionStageHandler> = {
  get: (query, stage) => {
    const key = DecodeValue(stage.args[0], query.getContext());
    query.setGet(key);
  },
  getAll: (query, stage) => {
    query.resultType = "selection";
    const baseTerm = query.isScopedTenant()
      ? query.getTableTerm()
      : query.buildTerm();
    const index = stage.options?.index;
    const rawKeys = stage.args[0];
    const context = query.getContext();
    const decodedKeys = Array.isArray(rawKeys)
      ? rawKeys.map((k) => DecodeValue(k, context))
      : [DecodeValue(rawKeys, context)];
    const term: TermJson = [
      TermType.GET_ALL,
      [baseTerm, ...decodedKeys],
      index ? { index } : {},
    ];
    query.setTerm(
      query.isScopedTenant() ? query.buildTenantFilterTerm(term) : term,
    );
  },
  between: (query, stage) => {
    query.resultType = "selection";
    const baseTerm = query.isScopedTenant()
      ? query.getTableTerm()
      : query.buildTerm();
    const index = stage.options?.index;
    const low = DecodeValue(stage.args[0], query.getContext());
    const high = DecodeValue(stage.args[1], query.getContext());
    const term: TermJson = [
      TermType.BETWEEN,
      [baseTerm, low, high],
      index ? { index } : {},
    ];
    query.setTerm(
      query.isScopedTenant() ? query.buildTenantFilterTerm(term) : term,
    );
  },
  insert: (query, stage) => {
    query.resultType = "insert";
    query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
    query.setConflictMode(stage.options?.conflict);
    query.setInsertRawArgs(stage.args[0]);
  },
  update: (query, stage) => {
    query.resultType = "update";
    if (stage.args[0]?.stage === "func") {
      const argId = allocateArgNumber();
      const docVar: TermJson = [TermType.VAR, [argId]];
      const body = DecodeFunction(stage.args[0], new DecodingContext(), [
        docVar,
      ]);
      query.setNewValue([
        TermType.FUNC,
        [[TermType.MAKE_ARRAY, [argId]], body],
      ]);
    } else {
      query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
    }
  },
  replace: (query, stage) => {
    query.resultType = "replace";
    query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
  },
  delete: (query) => {
    query.resultType = "delete";
  },
};
