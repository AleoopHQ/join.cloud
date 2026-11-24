import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PresenceTracker, parseGraceSec, presenceDownText, presenceUpText } from "../../src/server/presence.js";

// Pure unit tests: fake timers, an in-memory room. No server.

const ROOM = "room-1";

function setup(graceMs = 120_000) {
  const roles = new Map<string, string>([
    ["lead", "admin"],
    ["worker-1", "member"],
    ["worker-2", "member"],
  ]);
  const sent: Array<{ roomId: string; to: string; body: string }> = [];
  const tracker = new PresenceTracker({
    graceMs,
    getRole: async (_roomId, name) => roles.get(name),
    getAdmins: async () => [...roles].filter(([, r]) => r === "admin").map(([n]) => n),
    sendDm: async (roomId, to, body) => {
      sent.push({ roomId, to, body });
    },
  });
  return { tracker, roles, sent };
}

/** Let the tracker's async role lookups settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("presence: parseGraceSec", () => {
  it("defaults to 120 and accepts 0", () => {
    expect(parseGraceSec(undefined)).toBe(120);
    expect(parseGraceSec("")).toBe(120);
    expect(parseGraceSec("garbage")).toBe(120);
    expect(parseGraceSec("-5")).toBe(120);
    expect(parseGraceSec("0")).toBe(0);
    expect(parseGraceSec("30")).toBe(30);
  });
});

describe("presence: tracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("alerts every admin once after the grace period", async () => {
    const { tracker, roles, sent } = setup();
    roles.set("lead-2", "admin");
    const off = tracker.subscribe(ROOM, "worker-1");
    off();
    await flush();
    expect(tracker.pending(ROOM, "worker-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([
      { roomId: ROOM, to: "lead", body: presenceDownText("worker-1", 120) },
      { roomId: ROOM, to: "lead-2", body: presenceDownText("worker-1", 120) },
    ]);
    expect(sent[0].body).toBe(
      "[presence] worker-1 has had no listener for 120s: its wake daemon or tunnel may be down. Check with worker-status.sh.",
    );

    // Never twice for the same outage.
    await vi.advanceTimersByTimeAsync(10 * 120_000);
    expect(sent).toHaveLength(2);
  });

  it("does not alert if the agent resubscribes within the grace period", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    const off = tracker.subscribe(ROOM, "worker-1");
    expect(tracker.pending(ROOM, "worker-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    off();
  });

  it("only arms when the last of several subscribers goes", async () => {
    const { tracker, sent } = setup();
    const a = tracker.subscribe(ROOM, "worker-1");
    const b = tracker.subscribe(ROOM, "worker-1");
    a();
    a(); // idempotent
    await flush();
    expect(tracker.subscribers(ROOM, "worker-1")).toBe(1);
    expect(tracker.pending(ROOM, "worker-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    b();
    await flush();
    expect(tracker.pending(ROOM, "worker-1")).toBe(true);
  });

  it("sends one recovery DM when an alerted agent comes back, and can alert again on a new outage", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(1);

    const off = tracker.subscribe(ROOM, "worker-1");
    await flush();
    expect(sent[1]).toEqual({ roomId: ROOM, to: "lead", body: presenceUpText("worker-1") });
    expect(sent[1].body).toBe("[presence] worker-1 is listening again.");
    // A second subscriber does not repeat it.
    const off2 = tracker.subscribe(ROOM, "worker-1");
    await flush();
    expect(sent).toHaveLength(2);

    off2();
    off();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(3);
    expect(sent[2].body).toBe(presenceDownText("worker-1", 120));
  });

  it("no recovery DM if no alert was sent", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    tracker.subscribe(ROOM, "worker-1");
    await flush();
    expect(sent).toEqual([]);
  });

  it("never arms for an admin", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "lead")();
    await flush();
    expect(tracker.pending(ROOM, "lead")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it("does not alert for an agent promoted during the grace period", async () => {
    const { tracker, roles, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    roles.set("worker-1", "admin");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
  });

  it("does nothing for an agent that never subscribed", async () => {
    const { tracker, sent } = setup();
    expect(tracker.pending(ROOM, "worker-2")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it("forgetAgent (leave/kick) clears the timer", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    tracker.forgetAgent(ROOM, "worker-1");
    expect(tracker.pending(ROOM, "worker-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it("an agent that is gone from the room by the time the timer fires is not reported", async () => {
    const { tracker, roles, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    roles.delete("worker-1");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
  });

  it("forgetRoom clears every timer in the room and none in others", async () => {
    const { tracker, sent } = setup();
    tracker.subscribe(ROOM, "worker-1")();
    tracker.subscribe(ROOM, "worker-2")();
    tracker.subscribe("room-2", "worker-1")();
    await flush();
    tracker.forgetRoom(ROOM);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([{ roomId: "room-2", to: "lead", body: presenceDownText("worker-1", 120) }]);
  });

  it("a late unsubscribe after forgetAgent does not re-arm", async () => {
    const { tracker, sent } = setup();
    const off = tracker.subscribe(ROOM, "worker-1");
    tracker.forgetAgent(ROOM, "worker-1");
    off();
    await flush();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it("grace 0 disables the watchdog", async () => {
    const { tracker, sent } = setup(0);
    expect(tracker.enabled).toBe(false);
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    expect(tracker.subscribers(ROOM, "worker-1")).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it("reports the grace in whole seconds", async () => {
    const { tracker, sent } = setup(30_000);
    tracker.subscribe(ROOM, "worker-1")();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent[0].body).toContain("no listener for 30s");
  });
});
