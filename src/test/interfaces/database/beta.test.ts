import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Database, ListDatabases } from '../../../interfaces/database/beta';
import { internal as databaseInternal, translateQuery } from '../../../implementations/database/beta';
import * as connectionModule from '../../../connection';
import type { Cursor } from 'rethinkdb-ts/lib/response/cursor';

type QueryBuilderContext = Parameters<typeof translateQuery>[0];
type SendQueryType = typeof connectionModule.SendQuery;

type MutableConnectionModule = {
  SendQuery: SendQueryType;
};

type CursorType = 'Atom' | 'Cursor';

class CursorStub implements AsyncIterableIterator<unknown> {
  private readonly closeCallbacks: Array<() => void> = [];
  private index = 0;
  closeCallCount = 0;
  initCallCount = 0;

  constructor(
    private readonly resolvedValues: unknown[],
    private readonly streamValues: unknown[],
    private readonly cursorType: CursorType,
  ) {}

  async resolve(): Promise<unknown[]> {
    return this.resolvedValues;
  }

  getType(): CursorType {
    return this.cursorType;
  }

  async toArray(): Promise<unknown[]> {
    return this.streamValues;
  }

  init(): void {
    this.initCallCount += 1;
  }

  async close(): Promise<void> {
    this.closeCallCount += 1;
    for (const callback of this.closeCallbacks) {
      callback();
    }
  }

  on(event: string, callback: () => void): void {
    if (event === 'close') {
      this.closeCallbacks.push(callback);
    }
  }

  async next(): Promise<IteratorResult<unknown, void>> {
    if (this.index >= this.streamValues.length) {
      return { done: true, value: undefined };
    }
    const value = this.streamValues[this.index];
    this.index += 1;
    return { done: false, value };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }
}

const mutableConnection = connectionModule as unknown as MutableConnectionModule;
const originalSendQuery = connectionModule.SendQuery;

function extractQueryContext(query: unknown): QueryBuilderContext {
  const runtimeQuery = query as {
    build: (value: unknown) => { type: string; value: QueryBuilderContext };
  };
  const queryArg = runtimeQuery.build(runtimeQuery);
  assert.equal(queryArg.type, 'query');
  return queryArg.value;
}

afterEach(async () => {
  mutableConnection.SendQuery = originalSendQuery;
  await databaseInternal.closeCursor(7);
});

describe('database interface', () => {
  it('returns atom results through internal.runQuery', async () => {
    const cursor = new CursorStub(['app', 'analytics'], [], 'Atom');
    mutableConnection.SendQuery = async () => cursor as unknown as Cursor;

    const queryContext = extractQueryContext(ListDatabases());
    const result = await databaseInternal.runQuery(queryContext);

    assert.equal(result, 'app');
  });

  it('returns array results through internal.runQuery for cursor responses', async () => {
    const cursorRows = [{ id: 1 }, { id: 2 }];
    const cursor = new CursorStub([], cursorRows, 'Cursor');
    mutableConnection.SendQuery = async () => cursor as unknown as Cursor;

    const queryContext = extractQueryContext(Database('app').table('users'));
    const result = await databaseInternal.runQuery(queryContext);

    assert.deepEqual(result, cursorRows);
  });

  it('reuses an opened cursor for repeated readCursor calls', async () => {
    const cursor = new CursorStub([], [{ id: 1 }, { id: 2 }], 'Cursor');
    let sendQueryCallCount = 0;
    mutableConnection.SendQuery = async () => {
      sendQueryCallCount += 1;
      return cursor as unknown as Cursor;
    };

    const queryContext = extractQueryContext(Database('app').table('users'));
    const first = await databaseInternal.readCursor(7, queryContext);
    const second = await databaseInternal.readCursor(7, queryContext);
    const third = await databaseInternal.readCursor(7, queryContext);

    assert.deepEqual(first, { done: false, value: { id: 1 } });
    assert.deepEqual(second, { done: false, value: { id: 2 } });
    assert.deepEqual(third, { done: true, value: undefined });
    assert.equal(sendQueryCallCount, 1);
    assert.equal(cursor.initCallCount, 1);

    await databaseInternal.closeCursor(7);
    assert.equal(cursor.closeCallCount, 1);
  });
});
