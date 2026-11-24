import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProd } from "../helpers.js";

// The presence watchdog end to end: a real server of our own (the shared test
// server runs with the default 120s grace, which is too long to wait for), a
// worker subscribed over SSE, a disconnect, and the admin DM arriving both in
// history and as a `joincloud wait` wake for the lead.

const PORT = 3121;
const MCP_PORT = 3122;
const URL = `http://localhost:${PORT}`;
const GRACE_SEC = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(isProd)("presence watchdog (own server, grace 1s)", () => {
  const home = mkdtempSync(join(tmpdir(), "jc-presence-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "jc-presence-data-"));
  const env = { ...process.env, HOME: home, JOINCLOUD_URL: URL };
  // Async, never execFileSync: the server runs in this process, so a blocking
  // child would deadlock against it.
  const cli = (...args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile("node", ["dist/cli.js", ...args, "--url", URL], { encoding: "utf-8", env, timeout: 20000 }, (err, stdout, stderr) =>
        err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout.trim())));

  let servers: { httpServer: any; mcpServer: any };
  let presence: () => import("../../src/server/presence.js").PresenceTracker;
  let roomId: string;
  let leadToken: string;
  let workerToken: string;
  /** worker-1's long-lived subscription, standing in for its wake daemon. */
  let daemon: () => void = () => {};

  const a2a = async (action: string, metadata: Record<string, unknown>, contextId?: string) => {
    const res = await fetch(`${URL}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "SendMessage",
        params: { message: { role: "user", parts: [{ text: "" }], ...(contextId && { contextId }), metadata: { action, ...metadata } } },
      }),
    });
    const json = (await res.json()) as any;
    return json.result?.parts?.find((p: any) => p.data)?.data;
  };

  const history = async () => {
    const data = await a2a("message.history", { agentToken: leadToken, roomId, limit: 100 }, roomId);
    return (data?.messages ?? []) as Array<{ from: string; to?: string; body: string }>;
  };
  const presenceDms = async () => (await history()).filter((m) => m.body.startsWith("[presence]"));

  /** Open an SSE subscription as `token`; resolves once the stream is open. */
  const subscribe = async (token: string) => {
    const ac = new AbortController();
    const res = await fetch(`${URL}/api/messages/${roomId}/sse?agentToken=${token}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    // Drain in the background so the stream stays open.
    (async () => {
      try {
        for await (const _ of res.body as any) { /* discard */ }
      } catch { /* aborted */ }
    })();
    await sleep(200);
    return () => ac.abort();
  };

  const waitCli = (name: string, timeoutSec: number) =>
    new Promise<{ code: number; messages: any[] }>((resolve) => {
      execFile("node", ["dist/cli.js", "wait", roomId, "--name", name, "--url", URL, "--debounce", "0", "--timeout", String(timeoutSec), "--rescan", "600"],
        { encoding: "utf-8", env, timeout: 30000 },
        (err: any, stdout) => {
          const messages = stdout.trim() ? stdout.trim().split("\n").map((l) => JSON.parse(l)) : [];
          resolve({ code: err ? (err.code ?? 1) : 0, messages });
        });
    });

  beforeAll(async () => {
    const saved = { PORT: process.env.PORT, MCP_PORT: process.env.MCP_PORT, DATA: process.env.JOINCLOUD_DATA_DIR, GRACE: process.env.JOINCLOUD_PRESENCE_GRACE_SEC };
    process.env.PORT = String(PORT);
    process.env.MCP_PORT = String(MCP_PORT);
    process.env.JOINCLOUD_DATA_DIR = dataDir;
    process.env.JOINCLOUD_PRESENCE_GRACE_SEC = String(GRACE_SEC);
    const { createDefaultServer, startServer } = await import("../../src/server/index.js");
    const bot = await import("../../src/server/bot.js");
    presence = () => bot.getPresence()!;
    const server = createDefaultServer();
    await server.store.init();
    servers = startServer(server);
    await new Promise<void>((resolve) => {
      if (servers.httpServer.listening) return resolve();
      servers.httpServer.on("listening", () => resolve());
    });
    for (const [k, v] of Object.entries({ PORT: saved.PORT, MCP_PORT: saved.MCP_PORT, JOINCLOUD_DATA_DIR: saved.DATA, JOINCLOUD_PRESENCE_GRACE_SEC: saved.GRACE })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const created = JSON.parse(await cli("create", `presence-${process.pid}`, "--name", "lead", "--password", "pw", "--json"));
    roomId = created.roomId;
    leadToken = created.agentToken;
    workerToken = JSON.parse(await cli("join", roomId, "--name", "worker-1", "--password", "pw", "--detach")).agentToken;
    // `join --detach` opens no SSE stream, so nothing is tracked until the
    // "daemon" subscribes.
    expect(presence().tracked(roomId, "worker-1")).toBe(false);
    daemon = await subscribe(workerToken);
    await cli("wait", roomId, "--name", "lead", "--init");
  });

  afterAll(() => {
    servers?.httpServer.close();
    servers?.mcpServer.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("one-shot CLI commands from a fresh identity open no SSE stream and never alert", async () => {
    // The wake daemon posts turn-end notices as `wake-<worker>` with `send`.
    const who = "wake-worker-1";
    await cli("join", roomId, "--name", who, "--password", "pw", "--detach");
    await cli("send", roomId, "turn ended", "--name", who, "--password", "pw");
    await cli("history", roomId, "--password", "pw");
    await cli("unread", roomId, "--password", "pw");
    await cli("send", roomId, "turn ended again", "--name", who, "--password", "pw", "--to", "lead");
    expect(presence().tracked(roomId, who)).toBe(false);
    expect(presence().pending(roomId, who)).toBe(false);
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toEqual([]);
    // The CLI really did reach the room.
    expect((await history()).map((m) => m.body)).toEqual(expect.arrayContaining(["turn ended", "turn ended again"]));
    // That DM to the lead is real mail; move the lead's cursor past it so the
    // later wait tests see only presence DMs.
    await cli("wait", roomId, "--name", "lead", "--init");
  });

  it("the lead's own subscribe/disconnect never alerts (admin)", async () => {
    const off = await subscribe(leadToken);
    off();
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toEqual([]);
  });

  it("a worker reconnecting within the grace period does not alert", async () => {
    daemon();
    await sleep(300);
    daemon = await subscribe(workerToken);
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toEqual([]);
  });

  it("a worker's dropped SSE wakes the lead's `joincloud wait` with a room-bot DM, stored in history", async () => {
    const pending = waitCli("lead", 15);
    await sleep(1500); // let wait open its SSE and finish its history scan
    const t0 = Date.now();
    daemon();
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      from: "room-bot",
      to: "lead",
      body: `[presence] worker-1 has had no listener for ${GRACE_SEC}s: its wake daemon or tunnel may be down. Check with worker-status.sh.`,
    });
    expect(Date.now() - t0).toBeLessThan(GRACE_SEC * 1000 + 5000);

    const dms = await presenceDms();
    expect(dms).toEqual([expect.objectContaining({ from: "room-bot", to: "lead", body: r.messages[0].body })]);

    // No second alert for the same outage.
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toHaveLength(1);
  });

  it("the worker resubscribing sends one 'listening again' DM", async () => {
    const pending = waitCli("lead", 10);
    await sleep(1500);
    daemon = await subscribe(workerToken);
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.messages.map((m) => m.body)).toEqual(["[presence] worker-1 is listening again."]);
    expect(r.messages[0]).toMatchObject({ from: "room-bot", to: "lead" });
    const off2 = await subscribe(workerToken);
    await sleep(300);
    expect((await presenceDms()).map((m) => m.body)).toEqual([
      `[presence] worker-1 has had no listener for ${GRACE_SEC}s: its wake daemon or tunnel may be down. Check with worker-status.sh.`,
      "[presence] worker-1 is listening again.",
    ]);
    off2();
    daemon();
  });

  it("a worker that leaves does not alert", async () => {
    // worker-1's last subscriber went at the end of the previous test; leaving
    // inside the grace period must cancel the timer.
    await a2a("room.leave", { agentToken: workerToken });
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toHaveLength(2);
  });

  it("a kicked worker does not alert", async () => {
    const w2 = JSON.parse(await cli("join", roomId, "--name", "worker-2", "--password", "pw", "--detach")).agentToken;
    const off = await subscribe(w2);
    off();
    await sleep(100);
    await a2a("room.kick", { agentToken: leadToken, targetAgent: "worker-2" });
    await sleep((GRACE_SEC + 1) * 1000);
    expect(await presenceDms()).toHaveLength(2);
  });
});
