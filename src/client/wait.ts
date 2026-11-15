// `joincloud wait`: block until a message addressed to one agent arrives, print
// it, and exit. Built for agents that are NOT running when the message is sent
// (a Claude Code session between turns, say): a supervisor runs `wait` in a
// loop and resumes the agent with whatever it prints.
//
// Design constraints, each of which is load-bearing:
//
// - It never calls `room.join` or `message.unread`. Both advance the server's
//   per-agent "last seen" cursor, which is the same cursor the agent's own MCP
//   session reads its `missedMessages`/`unreadMessages` from -- so a waiter
//   that rejoined would silently mark the agent's broadcast traffic as read.
//   It only reads `room.info`, `message.history` and the SSE stream, none of
//   which change server state.
// - It keeps its OWN cursor, in a local state file. That is what makes it safe
//   to re-arm: a message that arrives between one `wait` exiting and the next
//   one starting is found in history by the next one. SSE is only a trigger;
//   history is the source of truth.
// - SSE is opened BEFORE the first history scan, so a message cannot fall into
//   the gap between "scanned" and "listening".

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { connectSSE } from "./sse.js";
import type { Message } from "./types.js";

export interface WaitCursor {
  /** Timestamp of the newest message already handled. */
  ts: string;
  /** Ids handled AT `ts` exactly -- timestamps are ms-resolution and can tie. */
  ids: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is `msg` addressed to `me`?
 *
 * - a DM to me (`to === me`), or
 * - a broadcast whose text mentions `@me` or `@all` as a whole name:
 *   `@worker-1` does not match `@worker-12`, and `foo@worker-1` (an email-ish
 *   token) does not count as a mention.
 *
 * Never my own messages, never the server's `room-bot` join/leave notices, and
 * never a DM to someone else even if it mentions me -- that conversation is
 * not mine to be woken by.
 */
export function isAddressedTo(msg: Pick<Message, "from" | "to" | "body">, me: string): boolean {
  if (msg.from === me || msg.from === "room-bot") return false;
  if (msg.to) return msg.to === me;
  const names = [me, "all"].map(escapeRegExp).join("|");
  const re = new RegExp(`(^|[^\\w@.-])@(${names})(?![\\w-])`, "i");
  return re.test(msg.body);
}

export function isAfterCursor(msg: Pick<Message, "id" | "timestamp">, cursor: WaitCursor | undefined): boolean {
  if (!cursor) return true;
  if (msg.timestamp > cursor.ts) return true;
  return msg.timestamp === cursor.ts && !cursor.ids.includes(msg.id);
}

/** Advance `cursor` past every message in `msgs` (which need not be sorted). */
export function advanceCursor(cursor: WaitCursor | undefined, msgs: Pick<Message, "id" | "timestamp">[]): WaitCursor | undefined {
  let next = cursor ? { ts: cursor.ts, ids: [...cursor.ids] } : undefined;
  for (const m of msgs) {
    if (!next || m.timestamp > next.ts) next = { ts: m.timestamp, ids: [m.id] };
    else if (m.timestamp === next.ts && !next.ids.includes(m.id)) next.ids.push(m.id);
  }
  return next;
}

export function defaultStatePath(roomId: string, me: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
  return join(homedir(), ".joincloud", `wait-${safe(roomId)}-${safe(me)}.json`);
}

export function loadCursor(path: string): WaitCursor | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof c?.ts === "string" && Array.isArray(c?.ids)) return c;
  } catch {}
  return undefined;
}

export function saveCursor(path: string, cursor: WaitCursor | undefined): void {
  if (!cursor) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor) + "\n");
}

type Rpc = (action: string, contextId?: string, text?: string, metadata?: Record<string, unknown>) => Promise<{ text: string; data?: Record<string, unknown> }>;

export interface WaitOptions {
  serverUrl: string;
  rpc: Rpc;
  room: string; // id or name
  me: string;
  agentToken: string;
  statePath?: string;
  /** Seconds to keep collecting after the first hit, so a burst is one wake. */
  debounceSec?: number;
  /** Give up after this many seconds with nothing; resolves `timedOut`. 0 = never. */
  timeoutSec?: number;
  /** Seconds between safety rescans of history even without an SSE event. */
  rescanSec?: number;
  /** Report without advancing the cursor. */
  peek?: boolean;
  /** Set the cursor to the newest message and return immediately. */
  init?: boolean;
  log?: (line: string) => void;
}

export interface WaitResult {
  roomId: string;
  messages: Message[];
  timedOut: boolean;
}

async function resolveRoomId(rpc: Rpc, room: string): Promise<string> {
  const { data } = await rpc("room.info", room);
  const id = data?.roomId as string | undefined;
  if (!id) throw new Error(`Room not found: ${room}`);
  return id;
}

/** Every message after `cursor`, oldest first. Pages back through history. */
async function messagesAfter(rpc: Rpc, roomId: string, agentToken: string, cursor: WaitCursor | undefined): Promise<Message[]> {
  const out: Message[] = [];
  const PAGE = 100;
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const { data } = await rpc("message.history", roomId, "", { agentToken, limit: PAGE, offset });
    const page = (data?.messages as Message[]) ?? [];
    // page is oldest-first; walk it newest-first so we can stop at the cursor
    let reachedCursor = false;
    for (let i = page.length - 1; i >= 0; i--) {
      if (isAfterCursor(page[i], cursor)) out.push(page[i]);
      else reachedCursor = true;
    }
    // No cursor means "first ever run": only the newest page matters, and the
    // caller decides what to do with it (init sets the cursor past it).
    if (reachedCursor || !cursor || page.length < PAGE) break;
  }
  return out.reverse();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForMessages(opts: WaitOptions): Promise<WaitResult> {
  const log = opts.log ?? (() => {});
  const debounceMs = (opts.debounceSec ?? 3) * 1000;
  const rescanMs = (opts.rescanSec ?? 60) * 1000;
  const roomId = await resolveRoomId(opts.rpc, opts.room);
  const statePath = opts.statePath ?? defaultStatePath(roomId, opts.me);
  let cursor = loadCursor(statePath);

  // Validates the token up front: message.history rejects a bad one, so a
  // misconfigured waiter fails loudly instead of blocking forever.
  const first = await messagesAfter(opts.rpc, roomId, opts.agentToken, cursor);

  if (opts.init) {
    // An empty room has no message to point at. Save an EMPTY cursor ("from
    // the start") rather than nothing: with no state file, the next wait
    // starts from *now* and silently skips whatever arrived in between -- which
    // lost a worker's first exit notice to a lead whose room-up ran --init on a
    // brand-new room (2026-11-15).
    if (!opts.peek) saveCursor(statePath, advanceCursor(cursor, first) ?? { ts: "", ids: [] });
    return { roomId, messages: [], timedOut: false };
  }
  // First run with no state file: do not replay the room's whole history at
  // whoever just started waiting. Start from now.
  if (!cursor) {
    cursor = advanceCursor(undefined, first);
    if (!opts.peek) saveCursor(statePath, cursor);
  }

  let poke: () => void = () => {};
  let poked = new Promise<void>((r) => (poke = r));
  const rearm = () => (poked = new Promise<void>((r) => (poke = r)));

  // SSE: a trigger only. Reconnects with backoff; a gap is covered by the
  // history rescan, never by trusting the stream.
  let stop = false;
  let unsubscribe: (() => void) | undefined;
  let backoff = 1000;
  const connect = () => {
    if (stop) return;
    unsubscribe = connectSSE(
      `${opts.serverUrl}/api/messages/${roomId}/sse?agentToken=${encodeURIComponent(opts.agentToken)}`,
      (msg) => {
        backoff = 1000;
        if (isAddressedTo(msg, opts.me)) poke();
      },
      (err) => {
        log(`sse: ${err.message}; reconnecting in ${backoff / 1000}s`);
        unsubscribe?.();
        if (stop) return;
        setTimeout(() => { poke(); connect(); }, backoff);
        backoff = Math.min(backoff * 2, 30000);
      },
    );
  };
  connect();

  const deadline = opts.timeoutSec ? Date.now() + opts.timeoutSec * 1000 : Infinity;
  try {
    while (true) {
      const scanned = await messagesAfter(opts.rpc, roomId, opts.agentToken, cursor);
      const pending = scanned.filter((m) => isAddressedTo(m, opts.me));
      if (pending.length === 0 && scanned.length > 0 && !opts.peek) {
        // Nothing for me in there: step over it so the next rescan is cheap.
        cursor = advanceCursor(cursor, scanned);
        saveCursor(statePath, cursor);
      }
      if (pending.length > 0) {
        if (debounceMs > 0) await sleep(debounceMs);
        const all = await messagesAfter(opts.rpc, roomId, opts.agentToken, cursor);
        const mine = all.filter((m) => isAddressedTo(m, opts.me));
        // Advance past EVERYTHING scanned, not just what was mine: otherwise
        // every rescan re-pages through the same unaddressed traffic.
        if (!opts.peek) saveCursor(statePath, advanceCursor(cursor, all));
        return { roomId, messages: mine, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { roomId, messages: [], timedOut: true };
      await Promise.race([poked, sleep(Math.min(rescanMs, remaining))]);
      rearm();
    }
  } finally {
    stop = true;
    unsubscribe?.();
  }
}
