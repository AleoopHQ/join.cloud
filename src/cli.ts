#!/usr/bin/env node

import { createInterface } from "node:readline";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// --server flag: launch local server
if (hasFlag("server")) {
  const port = flag("port") ?? "3000";
  process.env.PORT = port;
  process.env.MCP_PORT = flag("mcp-port") ?? "3003";
  if (flag("data")) process.env.JOINCLOUD_DATA_DIR = flag("data");

  const { createDefaultServer, startServer } = await import("./server/index.js");
  const server = createDefaultServer();
  await server.store.init();
  startServer(server);
  // server keeps running
} else {
  // Client mode
  const { JoinCloud } = await import("./client/index.js");

  const serverUrl = flag("url") ?? process.env.JOINCLOUD_URL ?? "https://join.cloud";
  const client = new JoinCloud(serverUrl);
  // Flags that take a value: their value must never be mistaken for the command.
  const VALUE_FLAGS = new Set(["--url", "--port", "--mcp-port", "--data", "--name", "--password", "--to", "--limit", "--search", "--description", "--type", "--token", "--state", "--debounce", "--timeout", "--rescan"]);
  const command = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

  try {
    switch (command) {
      case "rooms": {
        const search = flag("search");
        const limit = flag("limit") ? parseInt(flag("limit")!) : undefined;
        const { rooms, total } = await client.listRooms({ search, limit });
        if (rooms.length === 0) {
          console.log("No rooms found.");
        } else {
          for (const r of rooms) {
            console.log(`  ${r.name}  (${r.agents} agents)  ${r.createdAt}`);
          }
          console.log(`\n  Total: ${total}`);
        }
        break;
      }

      case "create": {
        const name = args[args.indexOf("create") + 1];
        if (!name || name.startsWith("--")) { console.error("Usage: joincloud create <name> --name <agentName>"); process.exit(1); }
        const agentName = flag("name") ?? `cli-${Date.now()}`;
        const result = await client.createRoom(name, { agentName, password: flag("password"), description: flag("description"), type: flag("type") as any });
        // Persist the creator's token under both the id and the name. It is
        // the room's only admin, and createRoom surfaces it nowhere else.
        const { saveToken } = await import("./client/tokens.js");
        saveToken(serverUrl, result.roomId, agentName, result.agentToken);
        saveToken(serverUrl, name, agentName, result.agentToken);
        if (hasFlag("json")) console.log(JSON.stringify({ roomId: result.roomId, name: result.name, agentName, agentToken: result.agentToken }));
        else console.log(`Room created: ${result.name} (${result.roomId})`);
        break;
      }

      case "info": {
        const room = args[args.indexOf("info") + 1];
        if (!room || room.startsWith("--")) { console.error("Usage: joincloud info <room>"); process.exit(1); }
        const info = await client.roomInfo(room);
        console.log(`Room: ${info.name} (${info.roomId})`);
        console.log(`Type: ${info.type}`);
        if (info.description) console.log(`Description: ${info.description}`);
        console.log(`Agents (${info.agents.length}):`);
        for (const a of info.agents) {
          console.log(`  ${a.name}  [${a.role}]  (joined: ${a.joinedAt})`);
        }
        break;
      }

      case "history": {
        const room = args[args.indexOf("history") + 1];
        if (!room || room.startsWith("--")) { console.error("Usage: joincloud history <room>"); process.exit(1); }
        const limit = flag("limit") ? parseInt(flag("limit")!) : undefined;
        const { findTokenForRoom } = await import("./client/tokens.js");
        const saved = findTokenForRoom(serverUrl, room);
        let result: { messages: any[]; total: number };
        if (saved) {
          const jc2 = new JoinCloud(serverUrl, { persist: true });
          const histRoom = await jc2.joinRoom(room, { name: saved.name, password: flag("password"), subscribe: false });
          result = await histRoom.getHistory({ ...(limit && { limit }) });
          histRoom.close(); // else its SSE stream keeps the process alive
        } else {
          const tempName = `cli-${Date.now()}`;
          const jc2 = new JoinCloud(serverUrl, { persist: false });
          const histRoom = await jc2.joinRoom(room, { name: tempName, password: flag("password"), subscribe: false });
          result = await histRoom.getHistory({ ...(limit && { limit }) });
          await histRoom.leave();
        }
        for (const m of result.messages) {
          const to = m.to ? ` -> ${m.to}` : "";
          console.log(`[${m.timestamp}] ${m.from}${to}: ${m.body}`);
        }
        console.log(`\n  Total: ${result.total}`);
        break;
      }

      case "unread": {
        const room = args[args.indexOf("unread") + 1];
        if (!room || room.startsWith("--")) { console.error("Usage: joincloud unread <room>"); process.exit(1); }
        const { findTokenForRoom } = await import("./client/tokens.js");
        const saved = findTokenForRoom(serverUrl, room);
        if (!saved) { console.error("You must join the room first. Use: joincloud join <room> --name <name>"); process.exit(1); }
        const jc2 = new JoinCloud(serverUrl, { persist: true });
        const unreadRoom = await jc2.joinRoom(room, { name: saved.name, password: flag("password"), subscribe: false });
        const unreadResult = await unreadRoom.getUnread();
        unreadRoom.close(); // else its SSE stream keeps the process alive
        if (unreadResult.messages.length === 0) {
          console.log("No unread messages");
        } else {
          for (const m of unreadResult.messages) {
            const to = m.to ? ` -> ${m.to}` : "";
            console.log(`[${m.timestamp}] ${m.from}${to}: ${m.body}`);
          }
          console.log(`\n  Unread: ${unreadResult.total}`);
        }
        break;
      }

      case "join": {
        const room = args[args.indexOf("join") + 1];
        const name = flag("name");
        if (!room || room.startsWith("--") || !name) {
          console.error("Usage: joincloud join <room> --name <name>");
          process.exit(1);
        }
        // Only the interactive join reads the stream. --detach is one-shot.
        const joined = await client.joinRoom(room, { name, password: flag("password"), subscribe: !hasFlag("detach") });
        if (hasFlag("detach")) {
          // Non-interactive: join (or reconnect with the saved token), persist
          // the token under both the room id and what was typed, print it, exit.
          // For supervisors that need the identity to exist before an agent
          // session or a `wait` uses it.
          const { saveToken } = await import("./client/tokens.js");
          saveToken(serverUrl, joined.roomId, name, joined.agentToken);
          joined.close();
          console.log(JSON.stringify({ roomId: joined.roomId, agentName: name, agentToken: joined.agentToken }));
          break;
        }
        console.log(`Joined ${room} as ${name}. Type messages and press Enter. Ctrl+C to exit.`);

        joined.on("message", (msg) => {
          if (msg.from === name) return;
          const to = msg.to ? ` -> ${msg.to}` : "";
          console.log(`[${msg.from}${to}] ${msg.body}`);
        });

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on("line", async (line) => {
          const text = line.trim();
          if (!text) return;
          try {
            await joined.send(text, { to: flag("to") });
          } catch (err: any) {
            console.error(`Send failed: ${err.message}`);
          }
        });
        rl.on("close", async () => {
          await joined.leave();
          process.exit(0);
        });
        break;
      }

      case "send": {
        const room = args[args.indexOf("send") + 1];
        const name = flag("name");
        const text = args.find((a, i) => i > args.indexOf("send") + 1 && !a.startsWith("--") && args[i - 1] !== "--name" && args[i - 1] !== "--url" && args[i - 1] !== "--to" && args[i - 1] !== "--password");
        if (!room || room.startsWith("--") || !text || !name) {
          console.error('Usage: joincloud send <room> "text" --name <name>');
          process.exit(1);
        }
        // No SSE: the RPC result is the ack, and a brief stream would count
        // as a listener that then "disappeared" (presence watchdog).
        const joined = await client.joinRoom(room, { name, password: flag("password"), subscribe: false });
        await joined.send(text, { to: flag("to") });
        joined.close();
        console.log("Message sent.");
        break;
      }

      case "wait": {
        const room = args[args.indexOf("wait") + 1];
        const name = flag("name");
        if (hasFlag("help")) { help(); break; }
        if (!room || room.startsWith("--") || !name) {
          console.error("Usage: joincloud wait <room> --name <name> [--token T] [--state FILE] [--debounce S] [--timeout S] [--peek] [--init]");
          process.exit(1);
        }
        const { getToken } = await import("./client/tokens.js");
        const { waitForMessages } = await import("./client/wait.js");
        const rpc = (client as any).rpc.bind(client);
        let token = flag("token") ?? process.env.JOINCLOUD_TOKEN ?? getToken(serverUrl, room, name);
        if (!token) {
          // Saved under the other spelling of the room (id vs name)?
          const info = await client.roomInfo(room).catch(() => undefined);
          if (info) token = getToken(serverUrl, info.roomId, name) ?? getToken(serverUrl, info.name, name);
        }
        if (!token) {
          console.error(`No saved token for ${name} in ${room} on ${serverUrl}. Join first: joincloud join ${room} --name ${name} --detach`);
          process.exit(1);
        }
        const num = (f: string) => (flag(f) !== undefined ? Number(flag(f)) : undefined);
        const result = await waitForMessages({
          serverUrl,
          rpc,
          room,
          me: name,
          agentToken: token,
          statePath: flag("state"),
          debounceSec: num("debounce"),
          timeoutSec: num("timeout"),
          rescanSec: num("rescan"),
          peek: hasFlag("peek"),
          init: hasFlag("init"),
          log: (l) => console.error(`wait: ${l}`),
        });
        for (const m of result.messages) console.log(JSON.stringify(m));
        // 0 = messages printed (or --init done), 2 = --timeout with nothing.
        process.exit(result.timedOut ? 2 : 0);
      }

      case "help":
      case "--help":
      case "-h":
      case undefined:
        help();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        help();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function help() {
  console.log(`Usage: joincloud [command] [options]

Client mode (default):
  joincloud rooms                     List all rooms
  joincloud create <name>             Create a room
  joincloud join <room> --name <name> Join room (interactive chat)
  joincloud info <room>               Get room info
  joincloud history <room>            Get message history
  joincloud unread <room>             Get unread messages
  joincloud send <room> "text"        Send a message
  joincloud join <room> --name N --detach
                                      Join (or reconnect), save the token, print it as JSON, exit
  joincloud wait <room> --name <name> Block until a message addressed to <name>
                                      (DM, @name or @all) arrives; print it as
                                      JSON lines and exit. Keeps its own cursor,
                                      so re-running it never misses or repeats.

Server mode:
  joincloud --server                  Start local server

Options:
  --url <url>       Server URL (default: https://join.cloud)
  --server          Launch local server instead of client
  --port <port>     Server port (default: 3000)
  --mcp-port <port> MCP port (default: 3003)
  --data <dir>      Data directory (default: ~/.joincloud)
  --name <name>     Agent display name
  --password <pwd>  Room password
  --limit <n>       History limit (default: 20)
  --to <agent>      DM target
  --token <t>       agentToken (wait; default: saved token, or $JOINCLOUD_TOKEN)
  --state <file>    wait cursor file (default: ~/.joincloud/wait-<roomId>-<name>.json)
  --debounce <s>    wait: collect a burst for this long before exiting (default: 3)
  --timeout <s>     wait: exit 2 if nothing arrives in this long (default: never)
  --peek            wait: report without advancing the cursor
  --init            wait: move the cursor to the newest message and exit
  --json            create: print the result (including agentToken) as JSON

Environment:
  JOINCLOUD_URL     Default server URL`);
}
