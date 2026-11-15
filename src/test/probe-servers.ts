import { strict as assert } from "node:assert";
import net from "node:net";

const SETTLE_POLL_MS = 20;

function IsTcpAddress(
  address: ReturnType<net.Server["address"]>,
): address is net.AddressInfo {
  return (
    address !== null &&
    typeof address !== "string" &&
    Number.isInteger(address.port)
  );
}

function PortOf(server: net.Server): number {
  const address = server.address();
  assert(IsTcpAddress(address), "a TCP server has a port");
  return address.port;
}

async function Listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return PortOf(server);
}

/** A local port nothing listens on. */
export async function ClosedPort(): Promise<number> {
  const server = net.createServer();
  const port = await Listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A local server and the client sockets still open to it. */
export interface Relay {
  port: number;
  /** The client sockets still open once none is left, or after `settleMs`. */
  openAfter: (settleMs: number) => Promise<number>;
  /** How many connections it has accepted. */
  accepted: () => number;
  close: () => Promise<void>;
}

/**
 * What a relay does with a chunk of one connection, from the client or from the server: forward
 * it, go quiet from this chunk on (forward nothing more and close nothing), or drop the connection.
 */
export type Route = (chunk: Buffer, fromClient: boolean) => Fate;

/** Forward the chunk, go quiet, drop the connection, or send the client these bytes instead. */
type Fate = "forward" | "stall" | "drop" | Buffer;

const HANDSHAKE_MESSAGES = 3;

/**
 * Routes the three NUL-ended messages a RethinkDB server sends to sign in, then `afterSignIn` for
 * the `n`th chunk the client sends after them, counted from 1.
 */
function AfterSignIn(
  afterSignIn: (clientChunk: number, chunk: Buffer) => Fate,
): Route {
  let ended = 0;
  let sent = 0;
  return (chunk, fromClient) => {
    if (ended < HANDSHAKE_MESSAGES) {
      if (!fromClient) {
        ended += chunk.filter((byte) => byte === 0).length;
      }
      return "forward";
    }
    if (!fromClient) {
      return "forward";
    }
    sent += 1;
    return afterSignIn(sent, chunk);
  };
}

/** The server goes quiet once the client has signed in. */
export function StallsAfterSignIn(): Route {
  return AfterSignIn(() => "stall");
}

/**
 * The server answers the query of the `n`th chunk the client sends after the sign-in with a
 * runtime error of `errorType`, a ReQL `ErrorType` code, in place of the real answer.
 */
export function FailsChunk(
  n: number,
  errorType: number,
  message: string,
): () => Route {
  const RUNTIME_ERROR = 18;
  const TOKEN_BYTES = 8;
  return () =>
    AfterSignIn((clientChunk, chunk) => {
      if (clientChunk !== n) {
        return "forward";
      }
      const body = Buffer.from(
        JSON.stringify({ t: RUNTIME_ERROR, e: errorType, r: [message], b: [] }),
      );
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      return Buffer.concat([chunk.subarray(0, TOKEN_BYTES), length, body]);
    });
}

/** A route, and how many queries it has forwarded. */
export interface QueryCounter {
  route: () => Route;
  queries: () => number;
}

/** A route that counts the queries the client sends after the sign-in, and forwards them. */
export function CountsQueries(): QueryCounter {
  const HEADER_BYTES = 12;
  const LENGTH_OFFSET = 8;
  let queries = 0;
  const route = () => {
    let pending = Buffer.alloc(0);
    return AfterSignIn((_clientChunk, chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (
        pending.length >= HEADER_BYTES &&
        pending.length >= HEADER_BYTES + pending.readUInt32LE(LENGTH_OFFSET)
      ) {
        pending = pending.subarray(
          HEADER_BYTES + pending.readUInt32LE(LENGTH_OFFSET),
        );
        queries += 1;
      }
      return "forward";
    });
  };
  return { route, queries: () => queries };
}

/** The server drops the connection on the `n`th chunk the client sends after the sign-in. */
export function DropsOnChunk(n: number): () => Route {
  return () =>
    AfterSignIn((clientChunk) => (clientChunk >= n ? "drop" : "forward"));
}

function Track(
  server: net.Server,
  clients: Set<net.Socket>,
  others: Set<net.Socket>,
): () => Promise<void> {
  return async () => {
    for (const socket of [...clients, ...others]) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  };
}

async function Served(
  server: net.Server,
  clients: Set<net.Socket>,
  others: Set<net.Socket>,
): Promise<Relay> {
  let accepted = 0;
  server.on("connection", () => {
    accepted += 1;
  });
  return {
    port: await Listen(server),
    accepted: () => accepted,
    openAfter: async (settleMs) => {
      const until = Date.now() + settleMs;
      while (clients.size > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
      return clients.size;
    },
    close: Track(server, clients, others),
  };
}

/** A server that accepts connections and never says a word, as a host behind a dropped packet. */
export function SilentServer(): Promise<Relay> {
  const clients = new Set<net.Socket>();
  const server = net.createServer((client) => {
    clients.add(client);
    client.resume();
    client.on("close", () => clients.delete(client));
    client.on("error", () => undefined);
  });
  return Served(server, clients, new Set());
}

/**
 * Forwards each connection to the server on `targetPort`, each chunk as its `Route` says: a
 * stalled connection forwards nothing more, as a server does that hangs after signing a client in.
 */
export function StartRelay(
  targetPort: number,
  newRoute?: () => Route,
): Promise<Relay> {
  const clients = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    const route = newRoute?.();
    let stalled = false;
    const forward = (chunk: Buffer, fromClient: boolean) => {
      const fate = stalled
        ? "stall"
        : (route?.(chunk, fromClient) ?? "forward");
      stalled = fate === "stall";
      if (Buffer.isBuffer(fate)) {
        client.write(fate);
      } else if (fate === "drop") {
        client.destroy();
        upstream.destroy();
      } else if (fate === "forward") {
        (fromClient ? upstream : client).write(chunk);
      }
    };
    clients.add(client);
    upstreams.add(upstream);
    client.on("data", (chunk) => forward(Buffer.from(chunk), true));
    upstream.on("data", (chunk) => forward(Buffer.from(chunk), false));
    client.on("close", () => {
      clients.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      if (!stalled) {
        client.destroy();
      }
    });
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  return Served(server, clients, upstreams);
}
