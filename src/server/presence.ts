// Presence watchdog (Aleoop fork).
//
// A worker's wake daemon holds an SSE subscription for its agent name almost
// continuously. When an agent's last subscriber goes away and nobody
// resubscribes within a grace period, the room's admins get a DM from
// `room-bot` saying so; when the agent comes back after such an alert, they
// get one more DM saying that.
//
// - Only agents that have had an SSE subscriber are tracked (there is no
//   entry until the first subscribe), and never an admin: the lead is the
//   admin and drops its subscription between one-shot waits.
// - One alert per outage: once alerted, nothing re-arms until the agent has
//   subscribed again.
// - The grace period covers the gap between one `joincloud wait` exiting and
//   the wake daemon starting the next.
// - Grace 0 disables the whole thing.

export interface PresenceDeps {
  /** Grace period in milliseconds. 0 disables the watchdog. */
  graceMs: number;
  /** The agent's role, or undefined if it is no longer in the room. */
  getRole(roomId: string, agentName: string): Promise<string | undefined>;
  /** Names of the room's admins (empty if the room is gone). */
  getAdmins(roomId: string): Promise<string[]>;
  /** Send a DM from the server's identity. */
  sendDm(roomId: string, to: string, body: string): Promise<void>;
}

interface Entry {
  count: number;
  timer?: ReturnType<typeof setTimeout>;
  alerted: boolean;
  /** Bumped on every subscribe/forget, so a stale async check can tell. */
  gen: number;
}

export function presenceDownText(agent: string, graceSec: number): string {
  return `[presence] ${agent} has had no listener for ${graceSec}s: its wake daemon or tunnel may be down. Check with worker-status.sh.`;
}

export function presenceUpText(agent: string): string {
  return `[presence] ${agent} is listening again.`;
}

export function parseGraceSec(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 120;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 120;
  return n;
}

export class PresenceTracker {
  private entries = new Map<string, Entry>();

  constructor(private deps: PresenceDeps) {}

  get enabled(): boolean {
    return this.deps.graceMs > 0;
  }

  private key(roomId: string, agentName: string): string {
    return `${roomId}\u0000${agentName}`;
  }

  /** Number of live SSE subscribers for an agent (for tests and debugging). */
  subscribers(roomId: string, agentName: string): number {
    return this.entries.get(this.key(roomId, agentName))?.count ?? 0;
  }

  /** Has this agent ever had an SSE subscriber (since it last left)? */
  tracked(roomId: string, agentName: string): boolean {
    return this.entries.has(this.key(roomId, agentName));
  }

  /** Is a grace timer pending for this agent? */
  pending(roomId: string, agentName: string): boolean {
    return this.entries.get(this.key(roomId, agentName))?.timer !== undefined;
  }

  /** Register one SSE subscriber. Returns the matching unsubscribe (idempotent). */
  subscribe(roomId: string, agentName: string): () => void {
    if (!this.enabled) return () => {};
    const k = this.key(roomId, agentName);
    let e = this.entries.get(k);
    if (!e) {
      e = { count: 0, alerted: false, gen: 0 };
      this.entries.set(k, e);
    }
    e.count++;
    e.gen++;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
    }
    if (e.alerted) {
      e.alerted = false;
      void this.notifyAdmins(roomId, presenceUpText(agentName));
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.unsubscribe(roomId, agentName);
    };
  }

  private unsubscribe(roomId: string, agentName: string): void {
    const k = this.key(roomId, agentName);
    const e = this.entries.get(k);
    if (!e || e.count === 0) return;
    e.count--;
    if (e.count > 0 || e.alerted || e.timer) return;
    void this.arm(roomId, agentName, e);
  }

  private async arm(roomId: string, agentName: string, e: Entry): Promise<void> {
    const gen = e.gen;
    let role: string | undefined;
    try {
      role = await this.deps.getRole(roomId, agentName);
    } catch {
      return;
    }
    // Things may have moved while we looked the role up.
    if (this.entries.get(this.key(roomId, agentName)) !== e) return;
    if (e.gen !== gen || e.count > 0 || e.timer || e.alerted) return;
    if (role === undefined) {
      this.forgetAgent(roomId, agentName);
      return;
    }
    if (role === "admin") return;
    const t = setTimeout(() => void this.fire(roomId, agentName, e), this.deps.graceMs);
    t.unref?.();
    e.timer = t;
  }

  private async fire(roomId: string, agentName: string, e: Entry): Promise<void> {
    e.timer = undefined;
    if (this.entries.get(this.key(roomId, agentName)) !== e) return;
    if (e.count > 0 || e.alerted) return;
    let role: string | undefined;
    try {
      role = await this.deps.getRole(roomId, agentName);
    } catch {
      return;
    }
    if (role === undefined) {
      this.forgetAgent(roomId, agentName);
      return;
    }
    // Promoted during the grace period, or resubscribed while we looked.
    if (role === "admin" || e.count > 0 || this.entries.get(this.key(roomId, agentName)) !== e) return;
    e.alerted = true;
    await this.notifyAdmins(roomId, presenceDownText(agentName, Math.round(this.deps.graceMs / 1000)), agentName);
  }

  private async notifyAdmins(roomId: string, body: string, exclude?: string): Promise<void> {
    let admins: string[];
    try {
      admins = await this.deps.getAdmins(roomId);
    } catch {
      return;
    }
    for (const admin of admins) {
      if (admin === exclude) continue;
      try {
        await this.deps.sendDm(roomId, admin, body);
      } catch {
        // Best effort: a failed DM must not take the SSE route down.
      }
    }
  }

  /** The agent left or was kicked: drop its state and any pending timer. */
  forgetAgent(roomId: string, agentName: string): void {
    const k = this.key(roomId, agentName);
    const e = this.entries.get(k);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    e.gen++;
    this.entries.delete(k);
  }

  /** The room is gone: drop every agent's state in it. */
  forgetRoom(roomId: string): void {
    const prefix = `${roomId}\u0000`;
    for (const [k, e] of this.entries) {
      if (!k.startsWith(prefix)) continue;
      if (e.timer) clearTimeout(e.timer);
      e.gen++;
      this.entries.delete(k);
    }
  }

  /** Clear everything (tests, shutdown). */
  reset(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }
}
