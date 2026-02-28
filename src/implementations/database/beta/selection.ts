import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { DecodingContext, QueryStage, allocateArgNumber } from './utils';
import { DecodeValue, executeTermJson } from './query';
import {
  CreateInstance,
  DestroyInstance,
  IsRowLevel,
  IsValidInstance,
  WaitForRegistration,
  buildDatabaseName,
  existingSchemas,
} from './schema';
import { applyStreamStages } from './stream';
import assert from 'assert';

type ResultType = 'stream' | 'table' | 'selection' | 'insert' | 'update' | 'replace' | 'delete' | 'createInstance' | 'destroyInstance';

const WRITE_STAGES = new Set(['insert', 'update', 'replace', 'delete']);
const PRE_STREAM_STAGES = new Set(['get', 'getAll', 'between', 'insert', 'update', 'replace', 'delete']);

export class SelectionQuery {
  public resultType: ResultType = 'table';
  public isChangeStream = false;
  public singleElement = false;
  private newValue: any;
  private term: TermJson;
  private readonly rowLevel: boolean;

  public constructor(
    public readonly schemaId: string,
    public readonly instanceId: string | undefined,
    public readonly tableName: string,
    public readonly database: string,
    private context: DecodingContext,
  ) {
    this.rowLevel = IsRowLevel(schemaId);
    const baseTerm: TermJson = [TermType.TABLE, [[TermType.DB, [database]], tableName]];
    if (this.rowLevel) {
      if (instanceId === undefined) {
        throw new Error(`Row-level schema '${schemaId}' requires a tenant ID`);
      }
      this.term = this.buildTenantFilterTerm(baseTerm);
    } else {
      this.term = baseTerm;
    }
  }

  public static buildTermJson(stages: QueryStage[], context: DecodingContext): TermJson {
    const query = SelectionQuery.decode(stages, context);
    return query.buildTerm();
  }

  public static decode(stages: QueryStage[], context: DecodingContext): SelectionQuery {
    assert(stages[0]?.stage === 'schema', 'Expected schema stage');
    const schemaId = stages[0].options?.id;
    assert(schemaId, 'Unknown schema');

    if (stages[1]?.stage === 'createInstance') {
      const instanceId = stages[1].options?.id;
      const database = buildDatabaseName(schemaId, instanceId);
      const query = new SelectionQuery(schemaId, instanceId, '', database, context);
      query.resultType = 'createInstance';
      return query;
    }

    if (stages[1]?.stage === 'destroyInstance') {
      const instanceId = stages[1].options?.id;
      const database = buildDatabaseName(schemaId, instanceId);
      const query = new SelectionQuery(schemaId, instanceId, '', database, context);
      query.resultType = 'destroyInstance';
      return query;
    }

    assert(stages[1]?.stage === 'instance', 'Expected instance stage');
    const instanceId = stages[1].options?.id;
    assert(stages[2]?.stage === 'table', 'Expected table stage');
    const tableName = stages[2].options.id;
    const database = IsRowLevel(schemaId) ? schemaId : buildDatabaseName(schemaId, instanceId);

    const query = new SelectionQuery(schemaId, instanceId, tableName, database, context);
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
    if (this.resultType !== 'createInstance' && this.resultType !== 'destroyInstance') {
      await this.ensureInstance();
    }

    const RUN_HANDLERS: Record<string, () => Promise<any>> = {
      createInstance: () => this.runCreateInstance(),
      destroyInstance: () => this.runDestroyInstance(),
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

  public async ensureReady() {
    await this.ensureInstance();
  }

  private async ensureInstance() {
    await WaitForRegistration(this.schemaId);
    if (IsValidInstance(this.schemaId, this.instanceId)) {
      return;
    }
    if (this.schemaId in existingSchemas) {
      await CreateInstance(this.schemaId, this.instanceId);
    }
  }

  private async runCreateInstance() {
    if (this.rowLevel) {
      return this.instanceId;
    }
    await CreateInstance(this.schemaId, this.instanceId);
    return this.instanceId;
  }

  private async runDestroyInstance() {
    if (this.rowLevel) {
      return;
    }
    await DestroyInstance(this.schemaId, this.instanceId);
  }

  private async runInsert() {
    let value = this.newValue;
    if (this.rowLevel && this.instanceId !== undefined) {
      value = this.stampTenantId(value);
    }
    const insertTerm: TermJson = [TermType.INSERT, [this.getTableTerm(), value]];
    const result = await executeTermJson(insertTerm);
    return result?.generated_keys ?? [];
  }

  private stampTenantId(value: any): any {
    if (Array.isArray(value) && value[0] === TermType.MAKE_ARRAY) {
      return [TermType.MAKE_ARRAY, value[1].map((doc: any) => this.stampTenantId(doc))];
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value, tenant_id: this.instanceId };
    }
    return value;
  }

  public getTableTerm(): TermJson {
    return [TermType.TABLE, [[TermType.DB, [this.database]], this.tableName]];
  }

  public buildTenantFilterTerm(baseTerm: TermJson): TermJson {
    const argId = allocateArgNumber();
    const filterFn: TermJson = [
      TermType.FUNC,
      [
        [TermType.MAKE_ARRAY, [argId]],
        [TermType.EQ, [[TermType.BRACKET, [[TermType.VAR, [argId]], 'tenant_id']], this.instanceId]],
      ],
    ];
    return [TermType.FILTER, [baseTerm, filterFn]];
  }

  public isRowLevel(): boolean {
    return this.rowLevel;
  }

  private async runUpdate() {
    const updateTerm: TermJson = [TermType.UPDATE, [this.term, this.newValue]];
    const result = await executeTermJson(updateTerm);
    return result?.replaced ?? 0;
  }

  private async runReplace() {
    const argId = allocateArgNumber();
    const oldDoc: TermJson = [TermType.VAR, [argId]];
    let replaceValue = this.newValue;
    if (this.rowLevel && this.instanceId !== undefined) {
      replaceValue = { ...replaceValue, tenant_id: this.instanceId };
    }
    const merged: TermJson = [TermType.MERGE, [replaceValue, { _id: [TermType.BRACKET, [oldDoc, '_id']] }]];
    const func: TermJson = [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], merged]];
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
}

type SelectionStageHandler = (query: SelectionQuery, stage: QueryStage) => void;

const SELECTION_STAGES: Record<string, SelectionStageHandler> = {
  get: (query, stage) => {
    query.resultType = 'selection';
    query.singleElement = true;
    const tableTerm = query.isRowLevel() ? query.getTableTerm() : query.buildTerm();
    query.setTerm([TermType.GET, [tableTerm, stage.args[0]]]);
  },
  getAll: (query, stage) => {
    query.resultType = 'selection';
    const baseTerm = query.isRowLevel() ? query.getTableTerm() : query.buildTerm();
    const index = stage.options?.index;
    const keys = stage.args[0];
    let term: TermJson;
    if (Array.isArray(keys)) {
      term = [TermType.GET_ALL, [baseTerm, ...keys], index ? { index } : {}];
    } else {
      term = [TermType.GET_ALL, [baseTerm, keys], index ? { index } : {}];
    }
    query.setTerm(query.isRowLevel() ? query.buildTenantFilterTerm(term) : term);
  },
  between: (query, stage) => {
    query.resultType = 'selection';
    const baseTerm = query.isRowLevel() ? query.getTableTerm() : query.buildTerm();
    const index = stage.options?.index;
    const low = stage.args[0];
    const high = stage.args[1];
    const term: TermJson = [TermType.BETWEEN, [baseTerm, low, high], index ? { index } : {}];
    query.setTerm(query.isRowLevel() ? query.buildTenantFilterTerm(term) : term);
  },
  insert: (query, stage) => {
    query.resultType = 'insert';
    query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
  },
  update: (query, stage) => {
    query.resultType = 'update';
    query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
  },
  replace: (query, stage) => {
    query.resultType = 'replace';
    query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
  },
  delete: (query) => {
    query.resultType = 'delete';
  },
};
