import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uniqueName, isProd, sendMsg, a2a } from "../helpers.js";
import { isAddressedTo, isAfterCursor, advanceCursor } from "../../src/client/wait.js";

const SERVER = process.env.TEST_URL ?? "http://localhost:3000";

// ============================================================
// pure logic -- no server
// ============================================================
describe("wait: isAddressedTo", () => {
  const m = (body: string, extra: { from?: string; to?: string } = {}) => ({ from: "lead", body, ...extra });

  it("matches a DM to me", () => {
    expect(isAddressedTo(m("anything", { to: "worker-1" }), "worker-1")).toBe(true);
  });
  it("matches @me at start, middle, end, and before punctuation", () => {
    for (const body of ["@worker-1 go", "hey @worker-1 go", "go @worker-1", "@worker-1: go", "(@worker-1)", "@Worker-1 go"]) {
      expect(isAddressedTo(m(body), "worker-1"), body).toBe(true);
    }
  });
  it("matches @all", () => {
    expect(isAddressedTo(m("@all stop"), "worker-1")).toBe(true);
  });
  it("does not match a longer name sharing the prefix", () => {
    expect(isAddressedTo(m("@worker-12 go"), "worker-1")).toBe(false);
    expect(isAddressedTo(m("@worker-1x go"), "worker-1")).toBe(false);
  });
  it("does not match an email-ish token or a bare name", () => {
    expect(isAddressedTo(m("mail foo@worker-1 now"), "worker-1")).toBe(false);
    expect(isAddressedTo(m("worker-1 go"), "worker-1")).toBe(false);
  });
  it("ignores my own messages and room-bot", () => {
    expect(isAddressedTo(m("@worker-1", { from: "worker-1" }), "worker-1")).toBe(false);
    expect(isAddressedTo(m("@worker-1 joined", { from: "room-bot" }), "worker-1")).toBe(false);
  });
  it("ignores a DM to someone else even if it mentions me", () => {
    expect(isAddressedTo(m("ask @worker-1", { to: "worker-2" }), "worker-1")).toBe(false);
  });
  it("escapes regex characters in names", () => {
    expect(isAddressedTo(m("@a.b go"), "a.b")).toBe(true);
    expect(isAddressedTo(m("@aXb go"), "a.b")).toBe(false);
  });
});

describe("wait: cursor", () => {
  it("treats everything as new without a cursor", () => {
    expect(isAfterCursor({ id: "a", timestamp: "2026-01-01T00:00:00.000Z" }, undefined)).toBe(true);
  });
  it("handles timestamp ties by id", () => {
    const c = advanceCursor(undefined, [{ id: "a", timestamp: "T1" }]);
    expect(isAfterCursor({ id: "a", timestamp: "T1" }, c)).toBe(false);
    expect(isAfterCursor({ id: "b", timestamp: "T1" }, c)).toBe(true);
    const c2 = advanceCursor(c, [{ id: "b", timestamp: "T1" }]);
    expect(c2).toEqual({ ts: "T1", ids: ["a", "b"] });
    expect(isAfterCursor({ id: "b", timestamp: "T1" }, c2)).toBe(false);
  });
  it("moves to the newest timestamp regardless of input order", () => {
    const c = advanceCursor(undefined, [{ id: "b", timestamp: "T2" }, { id: "a", timestamp: "T1" }]);
    expect(c).toEqual({ ts: "T2", ids: ["b"] });
  });
});

// ============================================================
// CLI against the local test server
// ============================================================
describe.skipIf(isProd)("CLI wait", () => {
  // Own HOME so saved tokens and cursors never touch the developer's.
  const home = mkdtempSync(join(tmpdir(), "jc-wait-"));
  const env = { ...process.env, HOME: home, JOINCLOUD_URL: SERVER };
  const cli = (...args: string[]) =>
    execFileSync("node", ["dist/cli.js", ...args, "--url", SERVER], { encoding: "utf-8", env, timeout: 20000 }).trim();

  /** Run `wait` asynchronously; resolves with exit code and parsed lines. */
  const wait = (name: string, ...extra: string[]) =>
    new Promise<{ code: number; messages: any[]; stderr: string }>((resolve) => {
      execFile("node", ["dist/cli.js", "wait", room, "--name", name, "--url", SERVER, "--debounce", "0", ...extra],
        { encoding: "utf-8", env, timeout: 30000 },
        (err: any, stdout, stderr) => {
          const messages = stdout.trim() ? stdout.trim().split("\n").map((l) => JSON.parse(l)) : [];
          resolve({ code: err ? (err.code ?? 1) : 0, messages, stderr });
        });
    });

  let room: string;
  let leadToken: string;
  let workerToken: string;

  beforeAll(() => {
    room = uniqueName("wait-room");
    const created = JSON.parse(cli("create", room, "--name", "lead", "--password", "pw", "--json"));
    leadToken = created.agentToken;
    room = created.roomId;
    const joined = JSON.parse(cli("join", room, "--name", "worker-1", "--password", "pw", "--detach"));
    workerToken = joined.agentToken;
    expect(workerToken).toBeTruthy();
    // also join a worker-12 so "@worker-12" is a real participant
    cli("join", room, "--name", "worker-12", "--password", "pw", "--detach");
    cli("wait", room, "--name", "worker-1", "--init");
  });

  it("create --json persists the admin token, so the creator can reconnect", () => {
    const again = JSON.parse(cli("join", room, "--name", "lead", "--password", "pw", "--detach"));
    expect(again.agentToken).toBe(leadToken);
  });

  it("times out (exit 2) on a mention of a different agent", async () => {
    await sendMsg(leadToken, "@worker-12 not you");
    const r = await wait("worker-1", "--timeout", "2");
    expect(r.code).toBe(2);
    expect(r.messages).toEqual([]);
  });

  it("returns a mention that arrived before it started (history replay)", async () => {
    await sendMsg(leadToken, "@worker-1 replay me");
    const r = await wait("worker-1", "--timeout", "5");
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.body)).toEqual(["@worker-1 replay me"]);
  });

  it("does not repeat a message on the next run", async () => {
    const r = await wait("worker-1", "--timeout", "2");
    expect(r.code).toBe(2);
  });

  it("wakes on a DM sent while it is blocked (SSE path)", async () => {
    const pending = wait("worker-1", "--timeout", "15", "--rescan", "600");
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    await sendMsg(leadToken, "direct", "worker-1");
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.body)).toEqual(["direct"]);
    // with rescan at 600s, only SSE can have delivered it this fast
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("batches a burst inside the debounce window into one result", async () => {
    const pending = new Promise<any>((resolve) => {
      execFile("node", ["dist/cli.js", "wait", room, "--name", "worker-1", "--url", SERVER, "--debounce", "2", "--timeout", "15"],
        { encoding: "utf-8", env }, (err: any, stdout) => resolve(stdout.trim().split("\n").map((l: string) => JSON.parse(l))));
    });
    await new Promise((r) => setTimeout(r, 1000));
    await sendMsg(leadToken, "@worker-1 one");
    await sendMsg(leadToken, "@all two");
    const msgs = await pending;
    expect(msgs.map((m: any) => m.body)).toEqual(["@worker-1 one", "@all two"]);
  });

  it("does not consume the agent's own unread cursor", async () => {
    // Everything wait returned above must still be unread for worker-1's own
    // session: wait reads history, it never calls message.unread or room.join.
    const res = await a2a("message.unread", undefined, "", { agentToken: workerToken });
    const bodies = (res.result.parts.find((p: any) => p.data)?.data?.messages ?? []).map((m: any) => m.body);
    expect(bodies).toContain("@worker-1 replay me");
    expect(bodies).toContain("direct");
  });

  it("--peek reports without advancing", async () => {
    await sendMsg(leadToken, "@worker-1 peek");
    const a = await wait("worker-1", "--timeout", "5", "--peek");
    const b = await wait("worker-1", "--timeout", "5");
    expect(a.messages.map((m) => m.body)).toEqual(["@worker-1 peek"]);
    expect(b.messages.map((m) => m.body)).toEqual(["@worker-1 peek"]);
  });

  it("wait --help exits 0 and documents wait", () => {
    expect(cli("wait", "--help")).toContain("joincloud wait");
  });

  it("fails loudly (exit 1) without a token", async () => {
    const r = await wait("nobody", "--timeout", "2");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No saved token");
  });

  it("--init on an EMPTY room still delivers the first message (no start-from-now skip)", async () => {
    const empty = JSON.parse(cli("create", uniqueName("wait-empty"), "--name", "lead2", "--password", "pw", "--json"));
    cli("wait", empty.roomId, "--name", "lead2", "--init");
    expect(existsSync(join(home, ".joincloud", `wait-${empty.roomId}-lead2.json`))).toBe(true);
    // a message lands BEFORE the first real wait starts
    const peer = JSON.parse(cli("join", empty.roomId, "--name", "w", "--password", "pw", "--detach"));
    await sendMsg(peer.agentToken, "for you", "lead2");
    const r = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile("node", ["dist/cli.js", "wait", empty.roomId, "--name", "lead2", "--url", SERVER, "--debounce", "0", "--timeout", "5"],
        { encoding: "utf-8", env }, (err: any, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout.trim() })));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).body).toBe("for you");
  });

  it("keeps its cursor in the state dir", () => {
    expect(existsSync(join(home, ".joincloud", `wait-${room}-worker-1.json`))).toBe(true);
  });
});
