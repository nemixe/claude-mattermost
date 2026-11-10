# Access control

All access state lives in `~/.claude/channels/mattermost/access.json` and is
managed with `/mattermost:access` from your terminal. The hub re-reads it on
every message, so changes apply immediately.

## Roles

| Role | Who | Can |
| --- | --- | --- |
| **owner** | `allowFrom` | DM the bot, start sessions, answer permission prompts, `!stop` / `!sessions`, talk to any session in an allowed channel |
| **member** | `channels[id].allowFrom` (or anyone in that channel if the list is empty) | talk to existing sessions in that channel |
| **unknown** | anyone else DMing the bot while `dmPolicy` is `pairing` | receive a pairing code |

## DM policy

- `pairing` (default) — unknown users who mention the bot in a DM get a 6-char
  code; approve with `/mattermost:access pair <code>`. Max 3 pending codes,
  1h expiry, one reminder.
- `allowlist` — strangers are ignored. Switch to this once everyone is paired.
- `disabled` — the bot ignores everything.

## Mentions

`requireMention` defaults to **true**: only posts that contain `@<botname>`
(or match one of `mentionPatterns`) are processed — in DMs, channels, and
inside session threads. A per-channel `requireMention` overrides the global
value.

Never needing a mention: replies to the bot's own prompts — permission
verdicts (`yes abcde` / `no abcde` / ✅ / ❌ on the prompt) and the workspace
name.

## Channels

Sessions can live in public/private channels and group DMs, not only your DM:

```
/mattermost:access channel add <channelId>               # members may talk to sessions there
/mattermost:access channel add <channelId> --allow a,b   # only users a and b
/mattermost:access home <channelId>                      # terminal sessions open their threads here
```

The bot account must be a member of the channel. Only owners can start new
sessions or approve permission prompts, even in shared channels.

## Schema

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["8k1x…"],
  "channels": { "q3e9…": { "allowFrom": [], "requireMention": true } },
  "pending": {},
  "requireMention": true,
  "mentionPatterns": [],
  "homeChannel": "q3e9…",
  "ackReaction": "eyes",
  "textChunkLimit": 16000,
  "chunkMode": "newline",
  "spawn": {
    "enabled": true,
    "baseDir": "~/Developer/Projects",
    "permissionMode": "acceptEdits",
    "maxSessions": 5,
    "channelFlag": "dev",
    "pluginRef": "plugin:mattermost@claude-mattermost",
    "disablePlugins": ["telegram@anthropic-plugin-directory"],
    "extraArgs": []
  }
}
```

## Prompt injection

Claude is told never to change access because a channel message asked it to,
and the skills refuse requests that arrive through a channel. The workspace
mapping (`workspaces.json`) is set from chat by design, but it can only name a
single folder directly under `spawn.baseDir`.
