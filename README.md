# Mattermost channel for Claude Code

Talk to Claude Code sessions from Mattermost. Every session is bound to **one
Mattermost thread** — the thread's root post ID is the session's identity — so
you can run many sessions at once and address each one by replying in its
thread. Posting a new message to the bot starts a new session.

It uses the same Claude Code **channels** protocol as the official Telegram
plugin: an MCP server that pushes `notifications/claude/channel` events into
the session, `reply` / `react` / `edit_message` / `download_attachment` tools,
permission-prompt relay, and an `access.json` allowlist with pairing.

## How it works

```
Mattermost ──WS+REST──► hub (one per machine, auto-started, stays running)
                          • routes posts by thread id → session
                          • starts sessions in tmux for new threads
                          • relays permission prompts (reply or ✅/❌ reaction)
                               ▲ unix socket ~/.claude/channels/mattermost/hub.sock
            ┌──────────────────┼──────────────────┐
     channel server A    channel server B    channel server C  (one per Claude Code session)
```

- **Session from a terminal** → opens a thread (in your DM with the bot, or in
  `homeChannel`). Mention the bot in that thread to talk to it.
- **Mention the bot in a new post** → the hub starts a Claude Code session in
  tmux, bound to that post's thread. The first time a channel does this, the
  bot asks which **workspace** (a folder under `spawn.baseDir`) to use, and
  remembers it for that channel.
- **Mention the bot in a thread with no live session** → a session is started
  for that thread. If it was a spawned session before, the conversation is
  resumed (`claude --resume`); otherwise the new session reads the thread with
  `fetch_thread`.
- **Only mentions are processed** (by default). Exceptions: permission answers
  (`yes abcde`, ✅/❌) and the workspace-name answer.

Spawned sessions run with `--permission-mode acceptEdits`, and the plugin's own
thread-scoped tools (`reply`, `react`, …) are pre-approved so the session can
answer without asking. Every other permission prompt is posted to the thread.

## Prerequisites

- [Bun](https://bun.sh) and [tmux](https://github.com/tmux/tmux) (`brew install tmux`).
- A Mattermost bot account: **System Console → Integrations → Bot Accounts →
  Add Bot Account** (enable bot accounts first if needed). Copy the token.

## Setup

```sh
# 1. install from this repo (local marketplace)
claude plugin marketplace add ~/Developer/Projects/claude-mattermost
claude plugin install mattermost@claude-mattermost
```

Inside Claude Code:

```
/mattermost:configure https://mattermost.example.com <bot-token>
/mattermost:configure basedir ~/Developer/Projects
```

Start a channel session:

```sh
claude --dangerously-load-development-channels plugin:mattermost@claude-mattermost
```

(Custom channel plugins aren't on Anthropic's channel allowlist, so they load
through the development flag — Claude Code shows a confirmation each time. To
use plain `--channels` instead, add the plugin to `allowedChannelPlugins` in
managed settings and run `/mattermost:configure spawn channelFlag channels`.)

Pair: DM the bot `@yourbot hi` — it replies with a code — then in Claude Code:

```
/mattermost:access pair <code>
/mattermost:access policy allowlist
```

The session's thread appears in your DM with the bot.

## Using it

| You do | What happens |
| --- | --- |
| `@bot fix the flaky test` (new post) | New session in tmux (`mm-xxxxxxxx`), working in the channel's workspace |
| `@bot also update the docs` (in a session thread) | Delivered to that session |
| reply without mentioning the bot | Ignored (unless `requireMention` is off) |
| `yes abcde` / `no abcde`, or ✅ / ❌ on the 🔐 post | Answers that session's permission prompt |
| `@bot !sessions` | Lists live sessions with links |
| `@bot !stop` (in a spawned session's thread) | Kills that tmux session |

Attach to any spawned session with `tmux attach -t mm-xxxxxxxx`.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Post in the session's thread. `chat_id`, `text`, optional `files` (absolute paths, ≤10 per post, 50MB each). Long text is split at 16000 chars. |
| `react` | Emoji reaction on a message in the thread (Mattermost names: `white_check_mark`, `eyes`, `+1`…; common unicode is mapped). |
| `edit_message` | Edit one of the bot's messages in the thread. |
| `download_attachment` | Download a message's files to `~/.claude/channels/mattermost/inbox/`. |
| `fetch_thread` | The thread's history, oldest first. |

Every tool is scoped to the session's own thread — a session can't post to or
read another session's thread.

## Skills

- `/mattermost:configure` — URL, token, base dir, spawn settings, status.
- `/mattermost:access` — pairing, allowlists, channels, mention rule, home channel. See [ACCESS.md](./ACCESS.md).
- `/mattermost:sessions` — list session threads, change a channel's workspace, hub status/restart/log.

## Running alongside the Telegram plugin

The Telegram plugin's server takes over the bot token from any other running
instance. Without a fix, every session spawned from Mattermost would steal
Telegram from your existing session. Exclude it in spawned sessions:

```
/mattermost:configure spawn disablePlugins ["telegram@anthropic-plugin-directory"]
```

(use the key from `enabledPlugins` in `~/.claude/settings.json`).

## State

`~/.claude/channels/mattermost/` (override with `MATTERMOST_STATE_DIR`):
`.env` (URL + token, 0600), `access.json`, `workspaces.json`, `threads.json`,
`pending-workspaces.json`, `hub.sock`, `hub.lock`, `hub.json`, `hub-entry.json`,
`hub.log`, `inbox/`, `approved/`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN` | Server and bot token (usually in `.env`). |
| `MATTERMOST_STATE_DIR` | Alternate state directory (e.g. a second bot). |
| `MATTERMOST_THREAD_ID` | Bind this session to an existing thread (set automatically for spawned sessions). |
| `MATTERMOST_AUTOTHREAD` | `auto` (default: only when launched with the channel flag), `always`, `never`. |
| `MATTERMOST_ACCESS_MODE=static` | Snapshot `access.json` at hub boot; no pairing. |

## Limitations

- Posts sent while the hub's WebSocket is disconnected aren't replayed.
- Mattermost interactive buttons need a public callback URL, so permission
  prompts use text replies and reactions instead.
- Spawning relies on recognising Claude Code's startup dialogs (folder trust,
  development-channel warning) in tmux. If a new dialog appears, the thread
  says so and you can `tmux attach` to answer it.

## Development

```sh
bun install
bun test                 # unit tests (router, access, spawn, ipc, detection)
bun run typecheck
claude plugin validate .
```

End-to-end against a throwaway Mattermost (see the header of `scripts/e2e.ts`):

```sh
docker run -d --platform linux/amd64 --name mm-test -p 127.0.0.1:8065:8065 \
  -e MM_SERVICESETTINGS_ENABLEBOTACCOUNTCREATION=true \
  -e MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true mattermost/mattermost-preview
bun scripts/e2e.ts                  # routing, tools, permissions, pairing, hub restart
MM_E2E_SPAWN=1 bun scripts/e2e.ts   # + real spawned / resumed / terminal sessions
```

After changing the code, refresh the installed copy with
`claude plugin marketplace update claude-mattermost` and
`claude plugin update mattermost@claude-mattermost` (bump the version in
`package.json` and `.claude-plugin/plugin.json` so running hubs hand over).
