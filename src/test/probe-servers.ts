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
 * Whether a connection goes quiet from this chunk on, from the client or from the server: it
 * forwards nothing more in either direction, and closes nothing.
 */
export type Stall = (chunk: Buffer, fromClient: boolean) => boolean;

/** A stall that lets through the three NUL-ended messages a RethinkDB server sends to sign in. */
export function StallsAfterSignIn(): Stall {
  const HANDSHAKE_MESSAGES = 3;
  let ended = 0;
  return (chunk, fromClient) => {
    const signedIn = ended >= HANDSHAKE_MESSAGES;
    if (!fromClient) {
      ended += chunk.filter((byte) => byte === 0).length;
    }
    return signedIn;
  };
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
 * Forwards each connection to the server on `targetPort`. A connection whose `Stall` answers
 * `true` forwards nothing more, as a server does that hangs after signing a client in.
 */
export function StartRelay(
  targetPort: number,
  newStall?: () => Stall,
): Promise<Relay> {
  const clients = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    const stall = newStall?.();
    let stalled = false;
    const forward = (chunk: Buffer, fromClient: boolean) => {
      stalled = stalled || (stall?.(chunk, fromClient) ?? false);
      if (!stalled) {
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
