---
name: configure
description: Set up the Mattermost channel — save the server URL and bot token, set the workspace base directory for sessions started from chat, and review access policy. Use when the user pastes a Mattermost URL or bot token, asks to configure Mattermost, asks "how do I set this up" or "who can reach me", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
  - Bash(test *)
---

# /mattermost:configure — Mattermost Channel Setup

Writes the server URL and bot token to `<state-dir>/.env`, the spawn settings
to `<state-dir>/access.json`, and orients the user on access policy. The hub
reads `.env` at boot; `access.json` is re-read on every message.

**Resolve the state directory first:**

```bash
echo "${MATTERMOST_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/mattermost}"
```

Use the printed path everywhere below in place of `<state-dir>`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the state files and give the user a complete picture:

1. **Server** — `MATTERMOST_URL` from `<state-dir>/.env` (set / not set).
2. **Token** — `MATTERMOST_BOT_TOKEN`: set / not set. If set, show only the
   first 4 chars followed by `…`.
3. **Access** — `<state-dir>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist, mention required). Show the DM
   policy in one line, allowed users, pending pairings (codes), allowlisted
   channels, `homeChannel`, and whether `requireMention` is on (default: on).
4. **Spawning** — `spawn.baseDir` (required for sessions started from chat),
   `spawn.permissionMode` (default `acceptEdits`), `spawn.maxSessions`
   (default 5), `spawn.disablePlugins`. Read `<state-dir>/workspaces.json`
   and list channel → workspace mappings.
5. **Hub** — read `<state-dir>/hub.json` (pid, version). Say whether that pid
   is alive (`ps -p <pid>` is not in allowed tools, so just report the pid and
   point to `/mattermost:sessions hub`).
6. **What next** — one concrete step:
   - No URL/token → *"Create a bot account in Mattermost (System Console →
     Integrations → Bot Accounts → Add), copy its token, then run
     `/mattermost:configure <https://your-server> <token>`."*
   - No baseDir → *"Run `/mattermost:configure basedir ~/Developer/Projects`
     so posts can start sessions in `<baseDir>/<workspace>`."*
   - Nobody allowed → *"Start Claude Code with
     `claude --dangerously-load-development-channels plugin:mattermost@claude-mattermost`,
     DM the bot `@<botname> hi`, and approve the code with
     `/mattermost:access pair <code>`."*
   - Otherwise → *"Ready. Mention the bot in a DM to start a session, or
     launch Claude Code with the channel flag to open a session thread."*

**Push toward lockdown — always.** `pairing` is a temporary way to capture
Mattermost user IDs. Once everyone is in, offer
`/mattermost:access policy allowlist`. Never frame `pairing` as the long-term
choice.

**Telegram coexistence.** If `~/.claude/settings.json` has the telegram
plugin enabled (`enabledPlugins` contains a key starting with `telegram@`),
warn: every spawned session would start telegram's server, which replaces the
poller of the user's existing telegram session. Offer to add that exact key to
`spawn.disablePlugins`.

### `<url> <token>` — save both

1. URL: trim, strip trailing `/`. Must start with `http://` or `https://`.
2. Token: trim. Mattermost tokens are 26 lowercase alphanumerics.
3. `mkdir -p <state-dir>` and `chmod 700 <state-dir>`.
4. Read existing `.env` if present; update/add `MATTERMOST_URL=` and
   `MATTERMOST_BOT_TOKEN=`, preserve other keys. No quotes around values.
5. `chmod 600 <state-dir>/.env`.
6. Confirm, then show the no-args status.

### `url <url>` / `token <token>` — save one

Same as above for a single key.

### `basedir <path>`

1. Expand `~`. Check the folder exists (`test -d`). If not, ask before
   creating it.
2. Read `access.json` (create defaults if missing), set `spawn.baseDir` to the
   path **as the user wrote it** (keeping `~` is fine), write back.

### `spawn <key> <value>`

Keys: `permissionMode` (`default` | `acceptEdits` | `plan` | `bypassPermissions`
— warn loudly before `bypassPermissions`: anyone on the allowlist could then
run arbitrary commands from chat), `maxSessions` (number), `enabled`
(`true`/`false`), `channelFlag` (`dev` | `channels`), `pluginRef`, `claudeBin`
(absolute path), `disablePlugins` (JSON array), `extraArgs` (JSON array).
Read, set `spawn.<key>`, write, confirm.

### `clear`

Remove `MATTERMOST_URL` and `MATTERMOST_BOT_TOKEN` from `.env`.

---

## Implementation notes

- Always Read before Write — the hub may have added pending pairing codes.
- Pretty-print JSON with 2-space indent.
- The hub reads `.env` once at boot. After changing the URL or token, tell the
  user to restart the hub: `/mattermost:sessions hub restart`.
- Never print the full token back.
