import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import net from "node:net";

import { Listen } from "./probe-servers";

/** What a client sent a recording server to sign in. */
export interface SignIn {
  /** The first byte was a TLS record, so the client asked for TLS; nothing else is recorded. */
  tls: boolean;
  user?: string;
  proof?: string;
  authMessage?: string;
  salt?: Buffer;
  iterations?: number;
}

/** A server that speaks the RethinkDB sign-in, records what each client sends, and refuses it. */
export interface ScramRecorder {
  port: number;
  signIns: SignIn[];
  close: () => Promise<void>;
}

type Fields = Record<string, string | number | boolean>;

const MAGIC_BYTES = 4;
const TLS_HANDSHAKE_RECORD = 0x16;
const ITERATIONS = 64;
const KEY_BYTES = 32;
const AUTH_ERROR_CODE = 12;
const NUL = 0;
const AUTHENTICATION = /"authentication":"([^"]*)"/;

function Message(fields: Fields): Buffer {
  return Buffer.concat([
    Buffer.from(JSON.stringify(fields)),
    Buffer.from([NUL]),
  ]);
}

/** The `authentication` field of the JSON message in `bytes`. */
function AuthenticationOf(bytes: Buffer): string {
  return AUTHENTICATION.exec(bytes.toString("utf8"))?.[1] ?? "";
}

function Field(authentication: string, name: string): string {
  const prefix = `${name}=`;
  const part = authentication
    .split(",")
    .find((entry) => entry.startsWith(prefix));
  return part?.slice(prefix.length) ?? "";
}

function ServerFirst(
  clientFirst: string,
  salt: Buffer,
  iterationsField: string,
): string {
  const nonce = `${Field(clientFirst, "r")}${randomBytes(18).toString("base64")}`;
  return `r=${nonce},s=${salt.toString("base64")},${iterationsField}`;
}

function Record(
  socket: net.Socket,
  signIns: SignIn[],
  iterations: number,
  iterationsField: string,
): void {
  const salt = randomBytes(16);
  let pending = Buffer.alloc(0);
  let clientFirstBare = "";
  let serverFirst = "";
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!serverFirst && pending[0] === TLS_HANDSHAKE_RECORD) {
      signIns.push({ tls: true });
      socket.destroy();
      return;
    }
    const end = pending.indexOf(NUL, serverFirst ? 0 : MAGIC_BYTES);
    if (end < 0) {
      return;
    }
    if (!serverFirst) {
      const clientFirst = AuthenticationOf(pending.subarray(MAGIC_BYTES, end));
      clientFirstBare = clientFirst.slice(clientFirst.indexOf("n="));
      serverFirst = ServerFirst(clientFirst, salt, iterationsField);
      pending = pending.subarray(end + 1);
      socket.write(
        Buffer.concat([
          Message({
            success: true,
            min_protocol_version: 0,
            max_protocol_version: 0,
            server_version: "2.4.4",
          }),
          Message({ success: true, authentication: serverFirst }),
        ]),
      );
      return;
    }
    const final = AuthenticationOf(pending.subarray(0, end));
    signIns.push({
      tls: false,
      user: Field(clientFirstBare, "n"),
      proof: Field(final, "p"),
      authMessage: `${clientFirstBare},${serverFirst},${final.slice(0, final.indexOf(",p="))}`,
      salt,
      iterations,
    });
    socket.end(
      Message({
        success: false,
        error: "the recording server refuses every sign-in",
        error_code: AUTH_ERROR_CODE,
      }),
    );
  });
  socket.on("error", () => undefined);
}

/**
 * Starts a server that records each sign-in, asking for `iterations` of the password derivation in
 * the third field of its first SCRAM message, written as `iterationsField`.
 */
export async function StartScramRecorder(
  iterations = ITERATIONS,
  iterationsField = `i=${iterations}`,
): Promise<ScramRecorder> {
  const signIns: SignIn[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    Record(socket, signIns, iterations, iterationsField);
  });
  return {
    port: await Listen(server),
    signIns,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The SCRAM-SHA-256 client proof a client signing in with `password` sends for `signIn`. */
export function ProofFor(password: string, signIn: SignIn): string {
  const salted = pbkdf2Sync(
    password,
    signIn.salt ?? Buffer.alloc(0),
    signIn.iterations ?? 1,
    KEY_BYTES,
    "sha256",
  );
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const signature = createHmac("sha256", storedKey)
    .update(signIn.authMessage ?? "")
    .digest();
  return Buffer.from(
    clientKey.map((byte, index) => byte ^ (signature[index] ?? 0)),
  ).toString("base64");
}
