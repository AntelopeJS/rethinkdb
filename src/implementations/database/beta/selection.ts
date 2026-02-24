import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { DecodingContext, QueryStage, allocateArgNumber } from './utils';
import { DecodeValue, executeTermJson } from './query';
import { CreateInstance, IsValidInstance, WaitForRegistration, existingSchemas } from './schema';
import { applyStreamStages } from './stream';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';

type ResultType = 'stream' | 'table' | 'selection' | 'insert' | 'update' | 'replace' | 'delete' | 'createInstance';

const WRITE_STAGES = new Set(['insert', 'update', 'replace', 'delete']);
const PRE_STREAM_STAGES = new Set(['get', 'getAll', 'between', 'insert', 'update', 'replace', 'delete']);

export class SelectionQuery {
  public resultType: ResultType = 'table';
  public isChangeStream = false;
  public singleElement = false;
  private newValue: any;
  private term: TermJson;

  public constructor(
    public readonly schemaId: string,
    public readonly instanceId: string,
    public readonly tableName: string,
    public readonly database: string,
    private context: DecodingContext,
  ) {
    this.term = [TermType.TABLE, [[TermType.DB, [database]], tableName]];
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
      const instanceId = stages[1].options?.id ?? uuidv4();
      const query = new SelectionQuery(schemaId, instanceId, '', `${schemaId}-${instanceId}`, context);
      query.resultType = 'createInstance';
      return query;
    }

    assert(stages[1]?.stage === 'instance', 'Expected instance stage');
    const instanceId = stages[1].options?.id;
    assert(instanceId, 'Missing instance');
    assert(stages[2]?.stage === 'table', 'Expected table stage');
    const tableName = stages[2].options.id;
    const database = `${schemaId}-${instanceId}`;

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
    if (this.resultType !== 'createInstance') {
      await this.ensureInstance();
    }

    const RUN_HANDLERS: Record<string, () => Promise<any>> = {
      createInstance: () => this.runCreateInstance(),
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
    await CreateInstance(this.schemaId, this.instanceId);
    return this.instanceId;
  }

  private async runInsert() {
    const insertTerm: TermJson = [TermType.INSERT, [this.term, this.newValue]];
    const result = await executeTermJson(insertTerm);
    return result?.generated_keys ?? [];
  }

  private async runUpdate() {
    const updateTerm: TermJson = [TermType.UPDATE, [this.term, this.newValue]];
    const result = await executeTermJson(updateTerm);
    return result?.replaced ?? 0;
  }

  private async runReplace() {
    const argId = allocateArgNumber();
    const oldDoc: TermJson = [TermType.VAR, [argId]];
    const merged: TermJson = [TermType.MERGE, [this.newValue, { _id: [TermType.BRACKET, [oldDoc, '_id']] }]];
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
    const currentTerm = query.buildTerm();
    query.setTerm([TermType.GET, [currentTerm, stage.args[0]]]);
  },
  getAll: (query, stage) => {
    query.resultType = 'selection';
    const currentTerm = query.buildTerm();
    const index = stage.options?.index;
    const keys = stage.args[0];
    if (Array.isArray(keys)) {
      query.setTerm([TermType.GET_ALL, [currentTerm, ...keys], index ? { index } : {}]);
    } else {
      query.setTerm([TermType.GET_ALL, [currentTerm, keys], index ? { index } : {}]);
    }
  },
  between: (query, stage) => {
    query.resultType = 'selection';
    const currentTerm = query.buildTerm();
    const index = stage.options?.index;
    const low = stage.args[0];
    const high = stage.args[1];
    query.setTerm([TermType.BETWEEN, [currentTerm, low, high], index ? { index } : {}]);
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
