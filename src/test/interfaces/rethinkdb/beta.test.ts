import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RQuery, RunOptions } from 'rethinkdb-ts';
import type { TermJson } from 'rethinkdb-ts/lib/internal-types';
import type { Cursor } from 'rethinkdb-ts/lib/response/cursor';
import * as connectionModule from '../../../connection';
import { RunQuery } from '../../../implementations/rethinkdb/beta';

type SendQueryType = typeof connectionModule.SendQuery;

type MutableConnectionModule = {
  SendQuery: SendQueryType;
};

type CursorType = 'Atom' | 'Cursor';

class CursorStub {
  constructor(
    private readonly resolvedValues: unknown[],
    private readonly cursorValues: unknown[],
    private readonly cursorType: CursorType,
  ) {}

  async resolve(): Promise<unknown[]> {
    return this.resolvedValues;
  }

  getType(): CursorType {
    return this.cursorType;
  }

  async toArray(): Promise<unknown[]> {
    return this.cursorValues;
  }
}

const mutableConnection = connectionModule as unknown as MutableConnectionModule;
const originalSendQuery = connectionModule.SendQuery;

function createQuery(term: TermJson): RQuery {
  return {
    term,
    run: async () => undefined,
  } as unknown as RQuery;
}

afterEach(() => {
  mutableConnection.SendQuery = originalSendQuery;
});

describe('rethinkdb interface', () => {
  it('forwards query term and run options to SendQuery', async () => {
    let receivedTerm: TermJson | undefined;
    let receivedOptions: RunOptions | undefined;
    const term: TermJson = [1, []];
    const options: RunOptions = { readMode: 'outdated' };

    mutableConnection.SendQuery = async (inputTerm, inputOptions) => {
      receivedTerm = inputTerm;
      receivedOptions = inputOptions;
      return new CursorStub(['ok'], [], 'Atom') as unknown as Cursor;
    };

    const result = await RunQuery(createQuery(term), options);

    assert.equal(result, 'ok');
    assert.deepEqual(receivedTerm, term);
    assert.deepEqual(receivedOptions, options);
  });

  it('returns toArray() when the cursor type is Cursor', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    mutableConnection.SendQuery = async () => new CursorStub([], rows, 'Cursor') as unknown as Cursor;

    const result = await RunQuery(createQuery([1, []]));

    assert.deepEqual(result, rows);
  });

  it('returns undefined when no cursor is returned', async () => {
    mutableConnection.SendQuery = async () => undefined;

    const result = await RunQuery(createQuery([1, []]));

    assert.equal(result, undefined);
  });
});
