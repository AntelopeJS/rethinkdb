import { expect } from "chai";
import { pbkdf2 } from "node:crypto";

import { probe } from "../probe";
import {
  ProofFor,
  type ScramRecorder,
  type SignIn,
  StartScramRecorder,
} from "./scram-recorder";

const TIMEOUT_MS = 1000;
const ENVIRONMENT_SECRET = "secret-from-the-probing-process";
const ENVIRONMENT = [
  "RETHINKDB_USER",
  "RETHINKDB_PASSWORD",
  "RETHINKDB_AUTH_KEY",
  "RETHINKDB_URL",
];

describe("the connection probe's credentials", function () {
  this.timeout(TIMEOUT_MS * 10);

  let recorder: ScramRecorder | undefined;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    recorder = await StartScramRecorder();
    for (const name of ENVIRONMENT) {
      saved.set(name, process.env[name]);
      process.env[name] =
        name === "RETHINKDB_URL"
          ? `rethinkdb://intruder:${ENVIRONMENT_SECRET}@127.0.0.1:1/x`
          : ENVIRONMENT_SECRET;
    }
  });

  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await recorder?.close();
  });

  async function SignInOf(path: string): Promise<SignIn> {
    const answer = await probe({
      url: `rethinkdb://${path.replace("PORT", String(recorder?.port))}`,
      timeoutMs: TIMEOUT_MS,
      signal: new AbortController().signal,
    });
    expect(answer).to.deep.include({
      outcome: "refused",
      refusal: "credentials",
    });
    expect(recorder?.signIns).to.have.length(1);
    return recorder?.signIns[0] ?? { tls: false };
  }

  it("signs in as admin with an empty password when the URL names no account", async () => {
    const signIn = await SignInOf("127.0.0.1:PORT/shop");
    expect(signIn.user).to.equal("admin");
    expect(signIn.proof).to.equal(ProofFor("", signIn));
  });

  it("signs in with an empty password when the URL names a user and no password", async () => {
    const signIn = await SignInOf("reader@127.0.0.1:PORT/shop");
    expect(signIn.user).to.equal("reader");
    expect(signIn.proof).to.equal(ProofFor("", signIn));
  });

  it("signs in with the URL's password, not one from the environment", async () => {
    const signIn = await SignInOf("reader:from-the-url@127.0.0.1:PORT/shop");
    expect(signIn.user).to.equal("reader");
    expect(signIn.proof).to.equal(ProofFor("from-the-url", signIn));
    expect(signIn.proof).to.not.equal(ProofFor(ENVIRONMENT_SECRET, signIn));
  });

  it("opens no TLS and reads no file that options of the URL name", async () => {
    const signIn = await SignInOf(
      "127.0.0.1:PORT/shop?tls=true&ssl=true&ca=/etc/ssl/key.pem&cert=/etc/ssl/cert.pem&password=x",
    );
    expect(signIn.tls).to.equal(false);
    expect(signIn.proof).to.equal(ProofFor("", signIn));
  });
});

describe("the connection probe on a server that asks for a costly password derivation", () => {
  const HOSTILE_ITERATIONS = 2_147_483_647;
  const PROBES = 4;
  const THREAD_POOL_ANSWER_MS = 1000;

  function ThreadPoolAnswers(): Promise<boolean> {
    return Promise.race([
      new Promise<boolean>((resolve) =>
        pbkdf2("", "", 1, 32, "sha256", () => resolve(true)),
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), THREAD_POOL_ANSWER_MS),
      ),
    ]);
  }

  async function ProbesOf(field: string) {
    const hostile = await StartScramRecorder(HOSTILE_ITERATIONS, field);
    try {
      const answers = await Promise.all(
        Array.from({ length: PROBES }, () =>
          probe({
            url: `rethinkdb://127.0.0.1:${hostile.port}/shop`,
            timeoutMs: TIMEOUT_MS,
            signal: new AbortController().signal,
          }),
        ),
      );
      return { answers, poolFree: await ThreadPoolAnswers() };
    } finally {
      await hostile.close();
    }
  }

  for (const field of [
    `i=${HOSTILE_ITERATIONS}`,
    `x=${HOSTILE_ITERATIONS}`,
    `i${HOSTILE_ITERATIONS}`,
  ]) {
    it(`refuses it before deriving when the count is written ${field}, so the shared thread pool stays free`, async () => {
      const { answers, poolFree } = await ProbesOf(field);
      for (const answer of answers) {
        expect(answer).to.deep.include({
          outcome: "refused",
          refusal: "other",
        });
        expect(answer).to.have.property("message").that.includes("iterations");
      }
      expect(poolFree).to.equal(true);
    });
  }
});
