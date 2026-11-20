import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { Socket } from "node:net";

import type { ResultValue } from "@antelopejs/interface-database-catalog/testing";

import { IsObject } from "../implementations/database/utils";

/** What Node publishes on `net.client.socket` for each client socket it opens. */
function IsNewSocket(message: unknown): message is { socket: Socket } {
  return (
    IsObject(message) &&
    Object.prototype.hasOwnProperty.call(message, "socket") &&
    "socket" in message &&
    message.socket instanceof Socket
  );
}

/**
 * Every byte the server sends on a connection opened while `work` runs, as text. It wraps `emit`,
 * since rethinkdb-ts removes every listener of a socket once it connects.
 */
export async function Received<T>(
  work: () => Promise<T>,
): Promise<{ answer: T; received: string }> {
  const chunks: Buffer[] = [];
  const tap: Parameters<typeof subscribe>[1] = (message) => {
    if (IsNewSocket(message)) {
      const socket = message.socket;
      const emit = socket.emit.bind(socket);
      socket.emit = (event: string | symbol, ...args: unknown[]) => {
        if (event === "data" && Buffer.isBuffer(args[0])) {
          chunks.push(args[0]);
        }
        return emit(event, ...args);
      };
    }
  };
  subscribe("net.client.socket", tap);
  try {
    const answer = await work();
    return { answer, received: Buffer.concat(chunks).toString("utf8") };
  } finally {
    unsubscribe("net.client.socket", tap);
  }
}

const JSON_SCALAR =
  /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

/** The JSON scalars found in what the server sent, each a value to compare whole. */
export function ReceivedValues(received: string): ResultValue[] {
  return (received.match(JSON_SCALAR) ?? []).map((token) => {
    // SAFETY: JSON_SCALAR matches only a JSON string, number, boolean or null, each a ResultValue.
    return JSON.parse(token) as ResultValue;
  });
}
