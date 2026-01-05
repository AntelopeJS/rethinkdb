import assert from 'assert';
import { Connection, MasterPool, RConnectionOptions, RPoolConnectionOptions, RunOptions, r } from 'rethinkdb-ts';
import { RethinkDBConnection } from 'rethinkdb-ts/lib/connection/connection';
import { MasterConnectionPool } from 'rethinkdb-ts/lib/connection/master-pool';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { Cursor } from 'rethinkdb-ts/lib/response/cursor';
import { Logger } from './utils/logger';

let connection:
  | {
      type: 'direct';
      connection: Connection;
    }
  | {
      type: 'pool';
      connection: MasterPool;
    }
  | undefined;

export async function ConnectDirect(options: RConnectionOptions) {
  Logger.Debug('Connecting directly to RethinkDB', options.host ?? 'localhost');
  Disconnect();
  connection = {
    type: 'direct',
    connection: await r.connect(options),
  };
  Logger.Debug('Connected directly to RethinkDB');
}

export async function ConnectPool(options: RPoolConnectionOptions) {
  Logger.Debug('Connecting to RethinkDB pool');
  Disconnect();
  connection = {
    type: 'pool',
    connection: await r.connectPool(options),
  };
  Logger.Debug('Connected to RethinkDB pool');
}

export function Disconnect() {
  if (connection) {
    Logger.Debug('Disconnecting from RethinkDB', connection.type);
    switch (connection.type) {
      case 'direct':
        void connection.connection.close();
        break;
      case 'pool':
        void connection.connection.drain();
        break;
    }
  }
}

export function GetConnection(): Connection | MasterPool | undefined {
  return connection?.connection;
}

export function GetConnectionType() {
  return connection?.type ?? 'none';
}

export function SendQuery(query: TermJson, opts?: RunOptions): Promise<Cursor | undefined> {
  assert(connection, 'TODO: queueing');
  Logger.Debug('Sending query via', connection.type);
  switch (connection.type) {
    case 'direct':
      return (<RethinkDBConnection>connection.connection).query(query, opts);
    case 'pool':
      return (<MasterConnectionPool>connection.connection).queue(query, opts);
  }
}
