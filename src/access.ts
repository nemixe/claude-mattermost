/**
 * access.json — who may reach Claude through Mattermost. Same model as the
 * telegram plugin (pairing → allowlist), with `groups` renamed `channels`
 * and a global `requireMention` (default true) plus spawn settings.
 *
 * Only the /mattermost:access and /mattermost:configure skills edit this file.
 * The hub writes it for exactly one reason: adding/pruning `pending` pairing codes.
 */

import { randomBytes } from 'crypto'
import { PATHS, log, readJson, writeJsonAtomic } from './util'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type ChannelPolicy = {
  /** Overrides the global requireMention for this channel. */
  requireMention?: boolean
  /** Extra users (beyond global allowFrom) who may talk to sessions here. Empty = any member. */
  allowFrom: string[]
}

export type SpawnConfig = {
  /** Default true. false = never start sessions from chat. */
  enabled?: boolean
  /** Workspaces live at <baseDir>/<workspace>. Required for spawning. */
  baseDir?: string
  /** Default 'acceptEdits'. */
  permissionMode?: string
  /** Default 5 live + starting sessions. */
  maxSessions?: number
  /** 'dev' → --dangerously-load-development-channels (default); 'channels' → --channels. */
  channelFlag?: 'dev' | 'channels'
  /** Default 'plugin:mattermost@claude-mattermost'. */
  pluginRef?: string
  /** Absolute path to the claude binary. Default: resolved from PATH. */
  claudeBin?: string
  /** Extra CLI args appended to every spawned `claude`. */
  extraArgs?: string[]
  /**
   * Plugins to switch off inside spawned sessions (passed as --settings enabledPlugins).
   * e.g. ["telegram@anthropic-plugin-directory"] — telegram's server would otherwise
   * kill the poller of your existing telegram session.
   */
  disablePlugins?: string[]
  /** Extra environment for spawned sessions. */
  env?: Record<string, string>
  /**
   * Default true: pre-approve this plugin's own tools (reply, react, …) in spawned
   * sessions, so answering in the thread doesn't need a permission prompt each time.
   * They are scoped to the session's own thread by the hub.
   */
  allowPluginTools?: boolean
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  channels: Record<string, ChannelPolicy>
  pending: Record<string, PendingEntry>
  /** Default true — only posts that @mention the bot are processed. */
  requireMention?: boolean
  mentionPatterns?: string[]
  /** Channel where terminal-started sessions open their thread. Default: DM with allowFrom[0]. */
  homeChannel?: string
  /** Emoji name to react with on receipt (e.g. "eyes"). Empty/unset disables. */
  ackReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  spawn?: SpawnConfig
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], channels: {}, pending: {} }
}

export function normalizeAccess(parsed: Partial<Access>): Access {
  return {
    ...parsed,
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    channels: parsed.channels ?? {},
    pending: parsed.pending ?? {},
  }
}

const STATIC = process.env.MATTERMOST_ACCESS_MODE === 'static'
let bootAccess: Access | null = null

export function loadAccess(): Access {
  if (STATIC) {
    if (!bootAccess) {
      const a = normalizeAccess(readJson<Partial<Access>>(PATHS.access, defaultAccess))
      if (a.dmPolicy === 'pairing') {
        log('access', 'static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      bootAccess = a
    }
    return bootAccess
  }
  return normalizeAccess(readJson<Partial<Access>>(PATHS.access, defaultAccess))
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  writeJsonAtomic(PATHS.access, a)
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/** Mattermost channel types: D = direct, G = group DM, O = public, P = private. */
export type ChannelType = 'D' | 'G' | 'O' | 'P' | string

/**
 * owner   — in global allowFrom and posting somewhere the bot listens. May start sessions,
 *           answer permission prompts, run thread commands.
 * member  — allowed in this channel only. May talk to existing sessions.
 * unknown — DM from someone not yet paired while dmPolicy is 'pairing'.
 * blocked — drop silently.
 */
export type SenderRole = 'owner' | 'member' | 'unknown' | 'blocked'

export function channelPolicy(access: Access, channelId: string): ChannelPolicy | undefined {
  const p = access.channels[channelId]
  if (p) return p
  if (access.homeChannel && access.homeChannel === channelId) return { allowFrom: [] }
  return undefined
}

export function classifySender(
  access: Access,
  senderId: string,
  channelId: string,
  channelType: ChannelType,
): SenderRole {
  if (access.dmPolicy === 'disabled') return 'blocked'
  const isOwner = access.allowFrom.includes(senderId)

  if (channelType === 'D') {
    if (isOwner) return 'owner'
    return access.dmPolicy === 'pairing' ? 'unknown' : 'blocked'
  }

  const policy = channelPolicy(access, channelId)
  if (!policy) return 'blocked'
  if (isOwner) return 'owner'
  const list = policy.allowFrom ?? []
  if (list.length === 0 || list.includes(senderId)) return 'member'
  return 'blocked'
}

export function requiresMention(access: Access, channelId: string): boolean {
  return access.channels[channelId]?.requireMention ?? access.requireMention ?? true
}

export type PairResult = { code: string; isResend: boolean } | null

/**
 * Issue (or re-send) a pairing code for an unknown DM sender. Mutates `access`.
 * Same limits as telegram: 2 replies per code, max 3 pending, 1h expiry.
 */
export function issuePairingCode(
  access: Access,
  senderId: string,
  chatId: string,
  now = Date.now(),
): PairResult {
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= 2) return null
      p.replies = (p.replies ?? 1) + 1
      return { code, isResend: true }
    }
  }
  if (Object.keys(access.pending).length >= 3) return null
  const code = randomBytes(3).toString('hex')
  access.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
  return { code, isResend: false }
}

/** The user who gets the DM thread when no homeChannel is set. */
export function ownerId(access: Access): string | undefined {
  return access.allowFrom[0]
}
