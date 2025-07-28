import 'reflect-metadata';
import { RConnectionOptions, RPoolConnectionOptions } from 'rethinkdb-ts';
import { ImplementInterface } from '@ajs/core/beta';
import { ConnectDirect, ConnectPool, Disconnect } from './connection';

interface Options {
  connection?: RConnectionOptions;
  pool?: RPoolConnectionOptions;
}

export async function construct(options: Options) {
  if (options?.pool) {
    await ConnectPool(options.pool);
  } else if (options?.connection) {
    await ConnectDirect(options.connection);
  } else {
    throw new Error('Invalid RethinkDB options');
  }

  ImplementInterface(await import('@ajs.local/database/beta/runtime'), await import('./implementations/database/beta'));
  ImplementInterface(await import('@ajs.local/rethinkdb/beta'), await import('./implementations/rethinkdb/beta'));
}

export async function start() {}

export function stop() {}

export function destroy() {
  Disconnect();
}
