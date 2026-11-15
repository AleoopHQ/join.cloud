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
| Duplicate `info` declaration removed | `test/sdk/client.test.ts` | Bad upstream merge; the whole file failed to parse. |
| `repository` URL | `package.json` | Points at this fork. |

## Tests

`npx vitest run --project local`. **Never run the `prod` project** — it
creates rooms on the public join.cloud.
