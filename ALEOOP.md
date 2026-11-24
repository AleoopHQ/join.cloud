# Aleoop fork of join.cloud

Upstream: https://github.com/kushneryk/join.cloud. This fork is what the
Aleoop devbox image builds (`devbox/flake.nix` in AleoopHQ/aleoop, pinned by
tag `vX.Y.Z-aleoop.N`). Working on it: the `joincloud-fork` skill in that repo.

## Carried on top of upstream

Keep this list current. It is what to re-check after an upstream merge.

| Change | Files | Why |
|---|---|---|
| `joincloud wait` | `src/client/wait.ts`, `src/cli.ts`, `test/cli/wait.test.ts` | Block until a message addressed to one agent (DM, `@name`, `@all`) arrives, print it, exit. Own cursor; never touches the server's per-agent last-seen. Lets a supervisor wake a stopped agent. |
| `join --detach`, `create --json` (and `create` saves the admin token) | `src/cli.ts` | Non-interactive identity setup for supervisors; the creator's token was otherwise lost. |
| `history`/`unread` reconnect with the saved token and close their SSE stream | `src/cli.ts` | They rejoined without the token ("name already taken") and hung on the open stream. |
| Presence watchdog | `src/server/presence.ts`, `src/server/bot.ts`, `src/server/routes/sse.ts`, `src/server/actions/room.ts`, `test/server/presence*.test.ts` | Counts SSE subscribers per (room, agent). When a non-admin agent that has had one drops to zero and nobody resubscribes within `JOINCLOUD_PRESENCE_GRACE_SEC` (default 120; 0 disables), `room-bot` DMs every admin `[presence] <agent> has had no listener for <N>s: ...`, once per outage, and `[presence] <agent> is listening again.` when it comes back. Timers are cleared on leave/kick/room cleanup. Lets a lead learn a worker's wake daemon or tunnel died without polling. |
| One-shot CLI commands open no SSE stream | `src/client/index.ts`, `src/client/types.ts`, `src/cli.ts` | `joinRoom` takes `subscribe: false`; `send`, `history`, `unread` and `join --detach` use it (`create`, `info`, `rooms` never subscribed). Otherwise each brief stream counts as a listener to the presence watchdog, and e.g. the wake daemon's `wake-<worker>` turn-end `send` would draw a false alert 120s later. Only `wait` and interactive `join` subscribe. |
| `wait` wakes on a `room-bot` DM | `src/client/wait.ts` | `isAddressedTo` used to drop everything from `room-bot`; it now drops only its broadcasts, so the presence DMs wake the lead. |
| Duplicate `info` declaration removed | `test/sdk/client.test.ts` | Bad upstream merge; the whole file failed to parse. |
| `repository` URL | `package.json` | Points at this fork. |

## Tests

`npx vitest run --project local`. **Never run the `prod` project** — it
creates rooms on the public join.cloud.
