import { describe, expect, test } from 'bun:test'
import { defaultAccess, type Access } from '../src/access'
import {
  decidePost, decideReaction, isMentioned, parseCommand, parseWorkspaceAnswer, stripLeadingMention,
  type InboundPost, type RouterState,
} from '../src/router'

const BOT = 'botid0000000000000000000000'
const OWNER = 'owner000000000000000000000'
const MEMBER = 'member00000000000000000000'
const STRANGER = 'stranger000000000000000000'
const DM = 'dmchannel00000000000000000'
const CHAN = 'teamchannel000000000000000'

function access(over: Partial<Access> = {}): Access {
  return { ...defaultAccess(), allowFrom: [OWNER], spawn: { baseDir: '~/Projects' }, ...over }
}

function state(over: Partial<RouterState> = {}): RouterState {
  return {
    botUserId: BOT,
    botUsername: 'claude',
    access: access(),
    liveThreads: new Set(),
    startingThreads: new Set(),
    detachedThreads: new Set(),
    awaitingWorkspace: new Set(),
    pendingPermissions: new Map(),
    threads: {},
    workspaces: {},
    ...over,
  }
}

function post(over: Partial<InboundPost> = {}): InboundPost {
  return { postId: 'p1', rootId: '', channelId: DM, channelType: 'D', userId: OWNER, message: '@claude hello', ...over }
}

describe('mentions', () => {
  test('detects @bot as a token', () => {
    expect(isMentioned('@claude hi', 'claude')).toBe(true)
    expect(isMentioned('hey @Claude, look', 'claude')).toBe(true)
    expect(isMentioned('ping @claude.', 'claude')).toBe(true)
    expect(isMentioned('(@claude)', 'claude')).toBe(true)
  })
  test('ignores look-alikes', () => {
    expect(isMentioned('@claudebot hi', 'claude')).toBe(false)
    expect(isMentioned('@claude-dev hi', 'claude')).toBe(false)
    expect(isMentioned('@claude.dev hi', 'claude')).toBe(false)
    expect(isMentioned('mail me@claude', 'claude')).toBe(false)
    expect(isMentioned('claude hi', 'claude')).toBe(false)
  })
  test('mentionPatterns count as mentions, bad regex is skipped', () => {
    expect(isMentioned('hey assistant', 'claude', ['\\bassistant\\b'])).toBe(true)
    expect(isMentioned('hey', 'claude', ['('])).toBe(false)
  })
  test('strips only a leading mention', () => {
    expect(stripLeadingMention('@claude fix it', 'claude')).toBe('fix it')
    expect(stripLeadingMention('  @claude: fix it', 'claude')).toBe('fix it')
    expect(stripLeadingMention('@claude, fix it', 'claude')).toBe('fix it')
    expect(stripLeadingMention('please @claude fix it', 'claude')).toBe('please @claude fix it')
  })
})

describe('decidePost — gating', () => {
  test('own posts are dropped', () => {
    expect(decidePost(post({ userId: BOT }), state()).kind).toBe('drop')
  })
  test('unknown DM sender with mention gets a pairing code', () => {
    expect(decidePost(post({ userId: STRANGER }), state())).toEqual({ kind: 'pair', senderId: STRANGER, channelId: DM })
  })
  test('unknown DM sender without mention is dropped (mention-only by default)', () => {
    expect(decidePost(post({ userId: STRANGER, message: 'hi' }), state()).kind).toBe('drop')
  })
  test('allowlist policy drops strangers', () => {
    const s = state({ access: access({ dmPolicy: 'allowlist' }) })
    expect(decidePost(post({ userId: STRANGER }), s).kind).toBe('drop')
  })
  test('disabled policy drops everyone', () => {
    const s = state({ access: access({ dmPolicy: 'disabled' }) })
    expect(decidePost(post(), s).kind).toBe('drop')
  })
  test('posts in channels that are not allowlisted are dropped', () => {
    expect(decidePost(post({ channelId: CHAN, channelType: 'O' }), state()).kind).toBe('drop')
  })
})

describe('decidePost — mention requirement', () => {
  test('owner top-level DM without mention is dropped', () => {
    expect(decidePost(post({ message: 'hello' }), state()).kind).toBe('drop')
  })
  test('reply in a live thread without mention is dropped', () => {
    const s = state({ liveThreads: new Set(['root1']) })
    expect(decidePost(post({ rootId: 'root1', message: 'continue' }), s).kind).toBe('drop')
  })
  test('reply in a live thread with mention is delivered, mention stripped', () => {
    const s = state({ liveThreads: new Set(['root1']) })
    expect(decidePost(post({ rootId: 'root1', message: '@claude continue please' }), s))
      .toEqual({ kind: 'deliver', threadId: 'root1', content: 'continue please' })
  })
  test('global requireMention:false delivers without mention', () => {
    const s = state({ liveThreads: new Set(['root1']), access: access({ requireMention: false }) })
    expect(decidePost(post({ rootId: 'root1', message: 'continue' }), s).kind).toBe('deliver')
  })
  test('per-channel requireMention:false overrides the global default', () => {
    const s = state({
      liveThreads: new Set(['root1']),
      access: access({ channels: { [CHAN]: { requireMention: false, allowFrom: [] } } }),
    })
    expect(decidePost(post({ rootId: 'root1', channelId: CHAN, channelType: 'O', message: 'go' }), s).kind).toBe('deliver')
    // ...but DMs still need the mention
    expect(decidePost(post({ rootId: 'root1', message: 'go' }), s).kind).toBe('drop')
  })
  test('per-channel requireMention:true overrides a global false', () => {
    const s = state({
      liveThreads: new Set(['root1']),
      access: access({ requireMention: false, channels: { [CHAN]: { requireMention: true, allowFrom: [] } } }),
    })
    expect(decidePost(post({ rootId: 'root1', channelId: CHAN, channelType: 'O', message: 'go' }), s).kind).toBe('drop')
  })
})

describe('decidePost — answers to the bot need no mention', () => {
  test('permission verdict without mention', () => {
    const s = state({ liveThreads: new Set(['root1']), pendingPermissions: new Map([['root1', new Set(['abcde'])]]) })
    expect(decidePost(post({ rootId: 'root1', message: 'yes abcde' }), s))
      .toEqual({ kind: 'permission', threadId: 'root1', requestId: 'abcde', behavior: 'allow' })
    expect(decidePost(post({ rootId: 'root1', message: 'N ABCDE' }), s))
      .toEqual({ kind: 'permission', threadId: 'root1', requestId: 'abcde', behavior: 'deny' })
  })
  test('permission verdict for an unknown request id falls through (and is dropped without mention)', () => {
    const s = state({ liveThreads: new Set(['root1']), pendingPermissions: new Map([['root1', new Set(['abcde'])]]) })
    expect(decidePost(post({ rootId: 'root1', message: 'yes zzzzz' }), s).kind).toBe('drop')
  })
  test('permission verdict from a channel member is not accepted', () => {
    const s = state({
      liveThreads: new Set(['root1']),
      pendingPermissions: new Map([['root1', new Set(['abcde'])]]),
      access: access({ channels: { [CHAN]: { allowFrom: [] } } }),
    })
    expect(decidePost(post({ rootId: 'root1', channelId: CHAN, channelType: 'O', userId: MEMBER, message: 'yes abcde' }), s).kind).toBe('drop')
  })
  test('workspace answer without mention', () => {
    const s = state({ awaitingWorkspace: new Set(['root1']) })
    expect(decidePost(post({ rootId: 'root1', message: 'my-app' }), s))
      .toEqual({ kind: 'workspaceAnswer', threadId: 'root1', channelId: DM, text: 'my-app' })
  })
})

describe('decidePost — sessions', () => {
  test('commands are recognized after the mention', () => {
    expect(decidePost(post({ rootId: 'root1', message: '@claude !stop' }), state()))
      .toEqual({ kind: 'command', threadId: 'root1', channelId: DM, command: 'stop' })
    expect(decidePost(post({ message: '@claude !sessions' }), state()))
      .toEqual({ kind: 'command', threadId: 'p1', channelId: DM, command: 'sessions' })
  })
  test('starting threads queue messages', () => {
    const s = state({ startingThreads: new Set(['root1']) })
    expect(decidePost(post({ rootId: 'root1', message: '@claude also this' }), s).kind).toBe('deliver')
  })
  test('top-level post in a channel without workspace asks for one', () => {
    const a = decidePost(post({ message: '@claude build it' }), state())
    expect(a).toEqual({ kind: 'askWorkspace', plan: { threadId: 'p1', channelId: DM, content: 'build it', resumed: false } })
  })
  test('top-level post in a channel with a workspace spawns there', () => {
    const a = decidePost(post({ message: '@claude build it' }), state({ workspaces: { [DM]: 'api' } }))
    expect(a).toEqual({ kind: 'spawn', plan: { threadId: 'p1', channelId: DM, content: 'build it', workspace: 'api', resumed: false } })
  })
  test('unknown thread spawns a session for that thread, marked resumed', () => {
    const a = decidePost(post({ rootId: 'oldroot', message: '@claude pick this up' }), state({ workspaces: { [DM]: 'api' } }))
    expect(a).toEqual({ kind: 'spawn', plan: { threadId: 'oldroot', channelId: DM, content: 'pick this up', workspace: 'api', resumed: true } })
  })
  test('ended thread with a known Claude session resumes it in the same folder', () => {
    const s = state({ threads: { oldroot: { origin: 'spawned', cwd: '/w/api', claudeSessionId: 'uuid-1' } } })
    expect(decidePost(post({ rootId: 'oldroot', message: '@claude again' }), s)).toEqual({
      kind: 'spawn',
      plan: { threadId: 'oldroot', channelId: DM, content: 'again', resumeSessionId: 'uuid-1', cwd: '/w/api', resumed: false },
    })
  })
  test('ended terminal thread without session id respawns fresh in its folder', () => {
    const s = state({ threads: { oldroot: { origin: 'manual', cwd: '/w/web' } } })
    expect(decidePost(post({ rootId: 'oldroot', message: '@claude again' }), s)).toEqual({
      kind: 'spawn',
      plan: { threadId: 'oldroot', channelId: DM, content: 'again', cwd: '/w/web', resumed: true },
    })
  })
  test('detached thread (session reconnecting) gets a notice instead of a spawn', () => {
    const s = state({ detachedThreads: new Set(['root1']), workspaces: { [DM]: 'api' } })
    expect(decidePost(post({ rootId: 'root1', message: '@claude hi' }), s).kind).toBe('notice')
  })
  test('channel members can talk to live sessions but not start them', () => {
    const s = state({
      liveThreads: new Set(['root1']),
      workspaces: { [CHAN]: 'api' },
      access: access({ channels: { [CHAN]: { allowFrom: [MEMBER] } } }),
    })
    const base = { channelId: CHAN, channelType: 'O', userId: MEMBER }
    expect(decidePost(post({ ...base, rootId: 'root1', message: '@claude hi' }), s).kind).toBe('deliver')
    expect(decidePost(post({ ...base, message: '@claude new task' }), s).kind).toBe('drop')
    expect(decidePost(post({ ...base, rootId: 'root1', message: '@claude !stop' }), s).kind).toBe('drop')
  })
  test('channel allowFrom restricts members', () => {
    const s = state({ liveThreads: new Set(['root1']), access: access({ channels: { [CHAN]: { allowFrom: [MEMBER] } } }) })
    expect(decidePost(post({ channelId: CHAN, channelType: 'O', userId: STRANGER, rootId: 'root1' }), s).kind).toBe('drop')
  })
  test('homeChannel is implicitly allowed', () => {
    const s = state({ access: access({ homeChannel: CHAN }), workspaces: { [CHAN]: 'api' } })
    expect(decidePost(post({ channelId: CHAN, channelType: 'P' }), s).kind).toBe('spawn')
  })
  test('spawn disabled → notice', () => {
    const s = state({ access: access({ spawn: { enabled: false, baseDir: '~/x' } }) })
    expect(decidePost(post(), s).kind).toBe('notice')
  })
  test('no baseDir → notice', () => {
    const s = state({ access: access({ spawn: {} }) })
    expect(decidePost(post(), s).kind).toBe('notice')
  })
})

describe('commands & workspace answers', () => {
  test('parseCommand', () => {
    expect(parseCommand('!stop')).toBe('stop')
    expect(parseCommand(' !SESSIONS ')).toBe('sessions')
    expect(parseCommand('!stop now')).toBe(null)
  })
  test('parseWorkspaceAnswer', () => {
    expect(parseWorkspaceAnswer('api')).toEqual({ ok: true, name: 'api', create: false })
    expect(parseWorkspaceAnswer('`my_app-2`')).toEqual({ ok: true, name: 'my_app-2', create: false })
    expect(parseWorkspaceAnswer('create new.thing')).toEqual({ ok: true, name: 'new.thing', create: true })
    expect(parseWorkspaceAnswer('../etc').ok).toBe(false)
    expect(parseWorkspaceAnswer('a/b').ok).toBe(false)
    expect(parseWorkspaceAnswer('a..b').ok).toBe(false)
    expect(parseWorkspaceAnswer('.hidden').ok).toBe(false)
    expect(parseWorkspaceAnswer('two words').ok).toBe(false)
    expect(parseWorkspaceAnswer('').ok).toBe(false)
  })
})

describe('decideReaction', () => {
  const permissionPosts = new Map([['perm1', { threadId: 'root1', requestId: 'abcde' }]])
  const s = { botUserId: BOT, access: access(), permissionPosts }
  test('owner ✅ allows, ❌ denies', () => {
    expect(decideReaction({ postId: 'perm1', userId: OWNER, emojiName: 'white_check_mark' }, s))
      .toEqual({ kind: 'permission', threadId: 'root1', requestId: 'abcde', behavior: 'allow' })
    expect(decideReaction({ postId: 'perm1', userId: OWNER, emojiName: 'x' }, s))
      .toEqual({ kind: 'permission', threadId: 'root1', requestId: 'abcde', behavior: 'deny' })
  })
  test('non-owner, bot, other posts and other emoji are ignored', () => {
    expect(decideReaction({ postId: 'perm1', userId: MEMBER, emojiName: 'white_check_mark' }, s).kind).toBe('drop')
    expect(decideReaction({ postId: 'perm1', userId: BOT, emojiName: 'white_check_mark' }, s).kind).toBe('drop')
    expect(decideReaction({ postId: 'other', userId: OWNER, emojiName: 'white_check_mark' }, s).kind).toBe('drop')
    expect(decideReaction({ postId: 'perm1', userId: OWNER, emojiName: 'eyes' }, s).kind).toBe('drop')
  })
})
