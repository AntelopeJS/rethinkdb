import assert from "node:assert";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

// oxlint-disable-next-line import/no-cycle -- sub-query building applies stream stages; see expression.ts
import { applyStreamStages } from "./stream";
import { executeBounded, executeTermJson } from "../../connection";
import { IsWriteResult } from "../../write-result";
// oxlint-disable-next-line import/no-cycle -- the stage handlers build this query's terms
import { SelectionStageHandlerOf } from "./selection-stages";
import { ExternalDatabaseName, GetOptions, IsExternal } from "../../config";
import { ExternalReads } from "./external-selection";
import { type ExternalWrite, RunExternalWrite } from "./external-writes";
import { FindIndex, IsValidInstance, WaitForSchemaReady } from "./schema";
import {
  buildIndexedRead,
  buildInstanceScope,
  type IndexedRead,
} from "./indexes";
import {
  allocateArgNumber,
  DecodingContext,
  IsList,
  IsObject,
  IsTermJson,
  type QueryStage,
  TENANT_ID_FIELD,
} from "./utils";

type WriteResultType = "insert" | "update" | "replace" | "delete";

type ResultType = "stream" | "table" | "selection" | WriteResultType;

type InstanceId = string | typeof CROSS_INSTANCE | undefined;

type TenantContext = { kind: "scoped"; tenantId: string } | { kind: "cross" };

const WRITE_STAGES = new Set(["insert", "update", "replace", "delete"]);

function isWriteResult(resultType: ResultType): resultType is WriteResultType {
  return WRITE_STAGES.has(resultType);
}
const PRE_STREAM_STAGES = new Set([
  "get",
  "getAll",
  "between",
  "insert",
  "update",
  "replace",
  "delete",
]);

/** Throws unless `instanceId` is a string, `CROSS_INSTANCE` or undefined, whatever a JavaScript caller passed. */
function assertInstanceId<Value>(
  tableName: string,
  instanceId: Value,
): asserts instanceId is Value & InstanceId {
  if (
    instanceId !== CROSS_INSTANCE &&
    instanceId !== undefined &&
    typeof instanceId !== "string"
  ) {
    throw new Error(
      `Invalid instance id for table '${tableName}': expected string or CROSS_INSTANCE, got ${typeof instanceId}`,
    );
  }
}

function resolveTenantContext(
  schemaId: string,
  tableName: string,
  instanceId: InstanceId,
): TenantContext {
  if (instanceId === CROSS_INSTANCE) {
    return { kind: "cross" };
  }
  assertInstanceId(tableName, instanceId);
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
  private newValue: TermJson = null;
  private conflictMode?: "update" | "replace";
  private insertRawArgs?: QueryStage<
    "insert" | "update" | "replace"
  >["args"][0];
  private term: TermJson;
  private readonly tenant: TenantContext;
  private scopedGet = false;
  /** The reads of an external instance's table; undefined on an owned instance. */
  public readonly external?: ExternalReads;
  private streamStages: QueryStage[] = [];
  private rawTarget?: TermJson;

  public constructor(
    public readonly schemaId: string,
    public readonly instanceId: InstanceId,
    public readonly tableName: string,
    public readonly database: string,
    private context: DecodingContext,
  ) {
    if (IsExternal()) {
      this.external = new ExternalReads(schemaId, tableName, instanceId);
      this.database = ExternalDatabaseName();
    }
    this.tenant = this.external
      ? { kind: "cross" }
      : resolveTenantContext(schemaId, tableName, instanceId);
    const baseTerm: TermJson = [
      TermType.TABLE,
      [[TermType.DB, [this.database]], tableName],
    ];
    this.term =
      this.tenant.kind === "scoped"
        ? buildInstanceScope(baseTerm, this.tenant.tenantId)
        : baseTerm;
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
    let streamStages: QueryStage[] = [];

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

    this.external?.refuseFeed(streamStages);
    this.rawTarget = this.term;
    if (this.external && (!writeStage || streamStages.length > 0)) {
      const ordered = this.external.indexedOrder(
        this.schemaId,
        this.term,
        streamStages[0],
      );
      this.term = this.external.normalized(
        ordered ?? this.term,
        this.singleElement,
      );
      streamStages = ordered ? streamStages.slice(1) : streamStages;
    }
    this.streamStages = streamStages;

    if (streamStages.length > 0) {
      const result = applyStreamStages(
        this.term,
        streamStages,
        this.context,
        { schemaId: this.schemaId, tableName: this.tableName },
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
    const handler = SelectionStageHandlerOf(stage.stage);
    if (handler) {
      handler(this, stage);
    }
  }

  public buildTerm(): TermJson {
    return this.term;
  }

  public async run(): Promise<any> {
    await WaitForSchemaReady(this.schemaId);
    const RUN_HANDLERS = {
      insert: () => this.runInsert(),
      update: () => this.runUpdate(),
      replace: () => this.runReplace(),
      delete: () => this.runDelete(),
    } satisfies Record<WriteResultType, () => Promise<any>>;

    const resultType = this.resultType;
    if (isWriteResult(resultType)) {
      if (this.external) {
        return RunExternalWrite(this.database, this.external.table, {
          kind: resultType,
          value: this.insertRawArgs as ExternalWrite["value"],
          target: await this.external.writeTarget(
            this.streamStages.length > 0 ? this.term : undefined,
            this.rawTarget ?? this.term,
          ),
          conflict: this.conflictMode,
        });
      }
      return RUN_HANDLERS[resultType]();
    }

    const timeoutMs = this.external
      ? GetOptions().statementTimeoutMs
      : undefined;
    const result: unknown =
      timeoutMs === undefined
        ? await executeTermJson(this.term)
        : await executeBounded(this.term, timeoutMs);
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
    const result: unknown = await executeTermJson(insertTerm);
    const generatedKeys = IsWriteResult(result)
      ? (result.generated_keys ?? [])
      : [];
    if (!this.conflictMode) {
      return generatedKeys;
    }
    return this.buildConflictInsertKeys(generatedKeys);
  }

  private buildConflictInsertKeys(generatedKeys: string[]): unknown[] {
    const rawDocs: unknown[] = Array.isArray(this.insertRawArgs)
      ? this.insertRawArgs
      : [this.insertRawArgs];
    let genIdx = 0;
    return rawDocs.map((doc) => {
      if (!IsObject(doc)) {
        return generatedKeys[genIdx++];
      }
      return (
        ("_id" in doc ? doc._id : undefined) ??
        ("id" in doc ? doc.id : undefined) ??
        generatedKeys[genIdx++]
      );
    });
  }

  private stampTenantId(value: TermJson, tenantId: string): TermJson {
    if (Array.isArray(value) && value[0] === TermType.MAKE_ARRAY) {
      const documents: unknown = value[1];
      return [
        TermType.MAKE_ARRAY,
        IsList(documents)
          ? documents.map((doc) =>
              IsTermJson(doc) ? this.stampTenantId(doc, tenantId) : doc,
            )
          : documents,
      ];
    }
    if (IsObject(value) && !Array.isArray(value)) {
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

  public selectByIndex(
    indexName: string | undefined,
    read: IndexedRead,
  ): TermJson {
    const definition =
      indexName === undefined
        ? undefined
        : FindIndex(this.schemaId, this.tableName, indexName);
    if (indexName === undefined || definition === undefined) {
      return this.selectWithoutDeclaredIndex(indexName, read);
    }
    return buildIndexedRead(
      {
        schemaId: this.schemaId,
        tableName: this.tableName,
        indexName,
        definition,
        table: this.getTableTerm(),
        source: this.term,
        tenantId:
          this.tenant.kind === "scoped" ? this.tenant.tenantId : undefined,
      },
      read,
    );
  }

  private selectWithoutDeclaredIndex(
    index: string | undefined,
    read: IndexedRead,
  ): TermJson {
    const lookup = { index, key: (value: TermJson) => value };
    if (!this.isScopedTenant()) {
      return read.lookup(this.term, lookup);
    }
    return this.buildTenantFilterTerm(read.lookup(this.getTableTerm(), lookup));
  }

  public isScopedTenant(): boolean {
    return this.tenant.kind === "scoped";
  }

  /**
   * The rows a lookup into this external table matches, by primary key or a native index, with
   * this query's own stream stages applied after them; undefined when no index serves it.
   */
  public externalLookup(
    otherKey: string,
    local: TermJson,
  ): TermJson | undefined {
    const source = this.external?.lookup(this.schemaId, otherKey, local);
    if (!source || this.resultType !== "table") {
      return undefined;
    }
    return applyStreamStages(source, this.streamStages, this.context, {
      schemaId: this.schemaId,
      tableName: this.tableName,
    }).term;
  }

  public isSimpleTable(): boolean {
    return (
      !this.external &&
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
    const result: unknown = await executeTermJson(updateTerm);
    return IsWriteResult(result) ? result.replaced : 0;
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
      replaceValue = Object.assign({}, replaceValue, {
        [TENANT_ID_FIELD]: this.tenant.tenantId,
      });
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
    const result: unknown = await executeTermJson(replaceTerm);
    return IsWriteResult(result) ? result.replaced : 0;
  }

  private async runDelete() {
    const deleteTerm: TermJson = [TermType.DELETE, [this.term]];
    const result: unknown = await executeTermJson(deleteTerm);
    return IsWriteResult(result) ? result.deleted : 0;
  }

  public setTerm(term: TermJson) {
    this.term = term;
  }

  public setNewValue(value: TermJson) {
    this.newValue = value;
  }

  public setConflictMode(mode?: "update" | "replace") {
    this.conflictMode = mode;
  }

  public setInsertRawArgs(
    args: QueryStage<"insert" | "update" | "replace">["args"][0],
  ) {
    this.insertRawArgs = args;
  }
}
