/**
 * Pure routing: given one inbound Mattermost post (or reaction) and a snapshot
 * of hub state, decide what to do. No I/O here — the hub executes the action.
 */

import { classifySender, requiresMention, type Access, type ChannelType } from './access'
import { PERMISSION_REPLY_RE } from './util'

export type InboundPost = {
  postId: string
  /** '' for top-level posts. */
  rootId: string
  channelId: string
  channelType: ChannelType
  userId: string
  message: string
}

export type ThreadInfo = {
  claudeSessionId?: string
  cwd?: string
  origin: 'spawned' | 'manual'
}

export type RouterState = {
  botUserId: string
  botUsername: string
  access: Access
  /** Threads with a connected session. */
  liveThreads: ReadonlySet<string>
  /** Threads whose session is being spawned (messages get queued). */
  startingThreads: ReadonlySet<string>
  /** Threads whose claude process is still alive but not connected (e.g. mid /reload-plugins). */
  detachedThreads: ReadonlySet<string>
  /** Threads where the bot asked "which workspace?" and waits for the answer. */
  awaitingWorkspace: ReadonlySet<string>
  /** Open permission prompts per thread (request ids). */
  pendingPermissions: ReadonlyMap<string, ReadonlySet<string>>
  /** Thread registry (threads.json). */
  threads: Readonly<Record<string, ThreadInfo>>
  /** channelId → workspace name (workspaces.json). */
  workspaces: Readonly<Record<string, string>>
}

export type SpawnPlan = {
  threadId: string
  channelId: string
  content: string
  /** Resume this Claude session id with --resume. */
  resumeSessionId?: string
  /** Run in this exact dir (an earlier session's cwd). */
  cwd?: string
  /** Otherwise run in <baseDir>/<workspace>. */
  workspace?: string
  /** A fresh session taking over an existing thread → tell Claude to fetch_thread. */
  resumed: boolean
}

export type Action =
  | { kind: 'drop'; reason: string }
  | { kind: 'pair'; senderId: string; channelId: string }
  | { kind: 'permission'; threadId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { kind: 'workspaceAnswer'; threadId: string; channelId: string; text: string }
  | { kind: 'command'; threadId: string; channelId: string; command: 'stop' | 'sessions' }
  | { kind: 'deliver'; threadId: string; content: string }
  | { kind: 'spawn'; plan: SpawnPlan }
  | { kind: 'askWorkspace'; plan: SpawnPlan }
  | { kind: 'notice'; threadId: string; channelId: string; text: string }

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@botname` as a standalone mention token (Mattermost usernames: [a-z0-9._-]). */
export function mentionRe(botUsername: string, flags = 'i'): RegExp {
  return new RegExp(`(?<![\\w@.-])@${escapeRe(botUsername)}(?![\\w-]|\\.[\\w])`, flags)
}

export function isMentioned(message: string, botUsername: string, patterns?: string[]): boolean {
  if (botUsername && mentionRe(botUsername).test(message)) return true
  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(message)) return true
    } catch {
      // invalid user-supplied regex — skip
    }
  }
  return false
}

/** Remove a leading `@bot` (plus trailing `,`/`:` and whitespace). Mid-sentence mentions stay. */
export function stripLeadingMention(message: string, botUsername: string): string {
  if (!botUsername) return message.trim()
  const re = new RegExp(`^\\s*@${escapeRe(botUsername)}(?![\\w-]|\\.[\\w])[\\s,:]*`, 'i')
  return message.replace(re, '').trim()
}

export function parseCommand(content: string): 'stop' | 'sessions' | null {
  const c = content.trim().toLowerCase()
  if (c === '!stop') return 'stop'
  if (c === '!sessions') return 'sessions'
  return null
}

export function decidePost(post: InboundPost, s: RouterState): Action {
  if (post.userId === s.botUserId) return { kind: 'drop', reason: 'own post' }

  const role = classifySender(s.access, post.userId, post.channelId, post.channelType)
  const mentioned = isMentioned(post.message, s.botUsername, s.access.mentionPatterns)
  const needMention = requiresMention(s.access, post.channelId)

  if (role === 'blocked') return { kind: 'drop', reason: 'sender not allowed here' }
  if (role === 'unknown') {
    if (needMention && !mentioned) return { kind: 'drop', reason: 'unknown sender, no mention' }
    return { kind: 'pair', senderId: post.userId, channelId: post.channelId }
  }

  const threadId = post.rootId || post.postId

  // Answers to the bot's own prompts never need a mention.
  if (role === 'owner' && post.rootId) {
    const m = PERMISSION_REPLY_RE.exec(post.message)
    if (m) {
      const requestId = m[2]!.toLowerCase()
      if (s.pendingPermissions.get(post.rootId)?.has(requestId)) {
        return {
          kind: 'permission',
          threadId: post.rootId,
          requestId,
          behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
        }
      }
    }
    if (s.awaitingWorkspace.has(post.rootId)) {
      return {
        kind: 'workspaceAnswer',
        threadId: post.rootId,
        channelId: post.channelId,
        text: stripLeadingMention(post.message, s.botUsername),
      }
    }
  }

  if (needMention && !mentioned) return { kind: 'drop', reason: 'no mention' }

  const content = stripLeadingMention(post.message, s.botUsername)

  const command = parseCommand(content)
  if (command) {
    if (role !== 'owner') return { kind: 'drop', reason: 'commands are owner-only' }
    return { kind: 'command', threadId, channelId: post.channelId, command }
  }

  if (post.rootId && (s.liveThreads.has(post.rootId) || s.startingThreads.has(post.rootId))) {
    return { kind: 'deliver', threadId: post.rootId, content }
  }

  // Top-level post, or a thread with no live session → start a session for it.
  if (role !== 'owner') return { kind: 'drop', reason: 'only paired users can start sessions' }

  if (post.rootId && s.detachedThreads.has(post.rootId)) {
    return {
      kind: 'notice',
      threadId,
      channelId: post.channelId,
      text: 'This thread\'s session is still running but reconnecting to the hub — try again in a few seconds.',
    }
  }

  const spawn = s.access.spawn ?? {}
  if (spawn.enabled === false) {
    return { kind: 'notice', threadId, channelId: post.channelId, text: 'Starting sessions from Mattermost is disabled (`spawn.enabled: false`).' }
  }

  const known = post.rootId ? s.threads[post.rootId] : undefined
  const resumedThread = post.rootId !== ''
  const base = { threadId, channelId: post.channelId, content }

  if (known?.claudeSessionId && known.cwd) {
    return { kind: 'spawn', plan: { ...base, resumeSessionId: known.claudeSessionId, cwd: known.cwd, resumed: false } }
  }
  if (known?.cwd) {
    return { kind: 'spawn', plan: { ...base, cwd: known.cwd, resumed: true } }
  }
  if (!spawn.baseDir) {
    return {
      kind: 'notice',
      threadId,
      channelId: post.channelId,
      text: 'No workspace base directory is configured yet. Run `/mattermost:configure basedir <path>` in Claude Code first.',
    }
  }
  const workspace = s.workspaces[post.channelId]
  if (workspace) return { kind: 'spawn', plan: { ...base, workspace, resumed: resumedThread } }
  return { kind: 'askWorkspace', plan: { ...base, resumed: resumedThread } }
}

export type ReactionAction =
  | { kind: 'drop' }
  | { kind: 'permission'; threadId: string; requestId: string; behavior: 'allow' | 'deny' }

const ALLOW_EMOJI = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1', 'thumbsup'])
const DENY_EMOJI = new Set(['x', 'negative_squared_cross_mark', 'no_entry', '-1', 'thumbsdown'])

export function decideReaction(
  r: { postId: string; userId: string; emojiName: string },
  s: { botUserId: string; access: Access; permissionPosts: ReadonlyMap<string, { threadId: string; requestId: string }> },
): ReactionAction {
  if (r.userId === s.botUserId) return { kind: 'drop' }
  const target = s.permissionPosts.get(r.postId)
  if (!target) return { kind: 'drop' }
  // Permission verdicts are owner-only (single-user model, same as telegram).
  if (!s.access.allowFrom.includes(r.userId) || s.access.dmPolicy === 'disabled') return { kind: 'drop' }
  if (ALLOW_EMOJI.has(r.emojiName)) return { kind: 'permission', ...target, behavior: 'allow' }
  if (DENY_EMOJI.has(r.emojiName)) return { kind: 'permission', ...target, behavior: 'deny' }
  return { kind: 'drop' }
}

const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export type WorkspaceAnswer =
  | { ok: true; name: string; create: boolean }
  | { ok: false; error: string }

/** Parse the reply to "which workspace?". Accepts `name` or `create name`. */
export function parseWorkspaceAnswer(text: string): WorkspaceAnswer {
  const t = text.trim().replace(/^`+|`+$/g, '').trim()
  const m = /^create\s+(\S+)$/i.exec(t)
  const name = m ? m[1]! : t
  if (!WORKSPACE_NAME_RE.test(name) || name.includes('..')) {
    return { ok: false, error: 'Workspace names may only contain letters, digits, `.`, `_` and `-` (one folder name, no paths).' }
  }
  return { ok: true, name, create: !!m }
}
