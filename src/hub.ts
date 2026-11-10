#!/usr/bin/env bun
/**
 * Mattermost hub — one per machine. Owns the only Mattermost connection,
 * routes posts to sessions by thread id, spawns sessions in tmux, relays
 * permission prompts. Channel servers (one per Claude Code session) connect
 * over <state>/hub.sock. Started on demand by the first channel server and
 * left running so it can spawn sessions when none are alive.
 */

import { randomUUID } from 'crypto'
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  rmSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync,
} from 'fs'
import net from 'net'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { execFileSync } from 'child_process'
import {
  issuePairingCode, loadAccess, ownerId, pruneExpired, requiresMention, saveAccess, type Access,
} from './access'
import { LineDecoder, encode, type ClientMsg, type HelloMsg, type HubMsg } from './ipc'
import { Mattermost, type MMEvent, type MMFileInfo, type MMPost } from './mattermost'
import { isClaudeArgs } from './detect'
import { Registry } from './registry'
import {
  decidePost, decideReaction, parseWorkspaceAnswer, type SpawnPlan,
} from './router'
import {
  capturePane, detectDialog, looksLikePrompt, pluginToolNames, shepherd, startTmux, tmuxHasSession, tmuxKill, tmuxNameFor,
} from './spawn'
import {
  MAX_ATTACHMENT_BYTES, MAX_FILES_PER_POST, MAX_POST_CHARS, PATHS, STATE_DIR, VERSION,
  assertSendable, chunk, compareVersions, ensureStateDir, errMsg, isPidAlive, loadEnvFile, log,
  readJson, safeName, writeJsonAtomic,
} from './util'

// ---------------------------------------------------------------- boot

loadEnvFile()
const MM_URL = process.env.MATTERMOST_URL
const MM_TOKEN = process.env.MATTERMOST_BOT_TOKEN
if (!MM_URL || !MM_TOKEN) {
  log('hub', `MATTERMOST_URL and MATTERMOST_BOT_TOKEN required — set them in ${PATHS.env} (run /mattermost:configure)`)
  process.exit(1)
}

ensureStateDir()
try {
  if (statSync(PATHS.hubLog).size > 5 * 1024 * 1024) truncateSync(PATHS.hubLog, 0)
} catch {}

process.on('unhandledRejection', err => log('hub', `unhandled rejection: ${errMsg(err)}`))
process.on('uncaughtException', err => log('hub', `uncaught exception: ${errMsg(err)}`))

function isHubProcess(pid: number): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return args.includes('hub.ts')
  } catch {
    return false
  }
}

/** Single-instance lock: <state>/hub.lock holds the owning pid. */
function acquireLock(): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(PATHS.lock, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const pid = parseInt(readFileSync(PATHS.lock, 'utf8'), 10)
      if (pid !== process.pid && isPidAlive(pid) && isHubProcess(pid)) return false
      try { unlinkSync(PATHS.lock) } catch {}
    }
  }
  return false
}

function ownsLock(): boolean {
  try {
    return parseInt(readFileSync(PATHS.lock, 'utf8'), 10) === process.pid
  } catch {
    return false
  }
}

if (!acquireLock()) {
  log('hub', 'another hub is running — exiting')
  process.exit(0)
}

const mm = new Mattermost(MM_URL, MM_TOKEN)
const registry = new Registry()
let bot: { id: string; username: string } | null = null
let shuttingDown = false

// ---------------------------------------------------------------- state

type Conn = {
  id: number
  sock: net.Socket
  hello?: HelloMsg
  threadId?: string
  channelId?: string
}

type Queued = { content: string; meta: Record<string, string> }

type Starting = {
  channelId: string
  tmux: string
  cwd: string
  queue: Queued[]
  statusPostId?: string
  plan: SpawnPlan
  retried: boolean
}

const conns = new Set<Conn>()
const owners = new Map<string, Conn>() // threadId → session
const unbound = new Set<Conn>() // said hello, waiting for Mattermost / pairing
const starting = new Map<string, Starting>()
/** Threads waiting for the "which workspace?" answer. Persisted so a hub restart doesn't drop them. */
type AwaitingWs = { plan: SpawnPlan; firstPostId: string; askedAt: number }
const awaitingWorkspace = new Map<string, AwaitingWs>(
  Object.entries(readJson<Record<string, AwaitingWs>>(PATHS.pendingWorkspaces, () => ({})))
    .filter(([, a]) => Date.now() - a.askedAt < 24 * 60 * 60 * 1000),
)
function saveAwaiting(): void {
  writeJsonAtomic(PATHS.pendingWorkspaces, Object.fromEntries(awaitingWorkspace))
}
const pendingPerms = new Map<string, Map<string, { postId: string; text: string }>>()
const permPosts = new Map<string, { threadId: string; requestId: string }>()
const channelTypes = new Map<string, string>()
const dmChannels = new Map<string, string>()

function send(conn: Conn, msg: HubMsg): void {
  if (!conn.sock.destroyed) conn.sock.write(encode(msg))
}

/** Serialize event handling so routing decisions see consistent state. */
let chain: Promise<unknown> = Promise.resolve()
function enqueue(fn: () => Promise<unknown>): void {
  chain = chain.then(fn).catch(err => log('hub', `event handler error: ${errMsg(err)}`))
}

async function say(channelId: string, rootId: string, message: string): Promise<MMPost | undefined> {
  try {
    return await mm.createPost({ channel_id: channelId, root_id: rootId || undefined, message })
  } catch (err) {
    log('hub', `post failed: ${errMsg(err)}`)
    return undefined
  }
}

async function edit(postId: string | undefined, message: string): Promise<void> {
  if (!postId) return
  try {
    await mm.patchPost(postId, message)
  } catch (err) {
    log('hub', `edit failed: ${errMsg(err)}`)
  }
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function mentionHint(channelId: string): string {
  return requiresMention(loadAccess(), channelId) ? `Mention @${bot?.username} in this thread to talk to it.` : 'Reply in this thread to talk to it.'
}

async function homeChannelId(access: Access): Promise<string | undefined> {
  if (access.homeChannel) return access.homeChannel
  const owner = ownerId(access)
  if (!owner || !bot) return undefined
  const cached = dmChannels.get(owner)
  if (cached) return cached
  const ch = await mm.directChannel(bot.id, owner)
  dmChannels.set(owner, ch.id)
  return ch.id
}

async function channelType(channelId: string, hint: string): Promise<string> {
  if (hint) return hint
  const cached = channelTypes.get(channelId)
  if (cached) return cached
  const t = (await mm.channel(channelId)).type
  channelTypes.set(channelId, t)
  return t
}

// ---------------------------------------------------------------- inbound meta

function fmtSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

async function postFiles(post: MMPost): Promise<MMFileInfo[]> {
  if (post.metadata?.files?.length) return post.metadata.files
  if (!post.file_ids?.length) return []
  return Promise.all(post.file_ids.map(id => mm.fileInfo(id)))
}

function inboxPath(f: MMFileInfo): string {
  const ext = (f.extension ?? f.name.split('.').pop() ?? 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const id = f.id.replace(/[^a-zA-Z0-9]/g, '')
  return join(PATHS.inbox, `${Date.now()}-${id}.${ext}`)
}

async function saveFile(f: MMFileInfo): Promise<string> {
  const buf = Buffer.from(await mm.downloadFile(f.id))
  mkdirSync(PATHS.inbox, { recursive: true, mode: 0o700 })
  const path = inboxPath(f)
  writeFileSync(path, buf)
  return path
}

async function buildMeta(post: MMPost, threadId: string): Promise<Record<string, string>> {
  const meta: Record<string, string> = {
    chat_id: post.channel_id,
    message_id: post.id,
    thread_id: threadId,
    user: safeName(await mm.username(post.user_id)) ?? post.user_id,
    user_id: post.user_id,
    ts: new Date(post.create_at).toISOString(),
  }
  let files: MMFileInfo[] = []
  try {
    files = await postFiles(post)
  } catch (err) {
    log('hub', `file info failed: ${errMsg(err)}`)
  }
  if (files.length) {
    meta.attachment_count = String(files.length)
    meta.attachments = files
      .map(f => `${safeName(f.name)} (${safeName(f.mime_type) ?? 'unknown'}, ${fmtSize(f.size)})`)
      .join('; ')
    // Images are downloaded eagerly so Claude can Read them right away.
    // image_path lives in meta only — an in-content path would be forgeable.
    const images: string[] = []
    for (const f of files) {
      if (!f.mime_type?.startsWith('image/') || f.size > 20 * 1024 * 1024) continue
      try {
        images.push(await saveFile(f))
      } catch (err) {
        log('hub', `image download failed: ${errMsg(err)}`)
      }
    }
    if (images.length) meta.image_path = images.join(',')
  }
  return meta
}

// ---------------------------------------------------------------- delivery

async function deliver(threadId: string, post: MMPost, content: string, extra: Record<string, string> = {}): Promise<void> {
  const meta = { ...(await buildMeta(post, threadId)), ...extra }
  const conn = owners.get(threadId)
  if (conn) {
    send(conn, { t: 'inbound', content, meta })
    mm.typing(post.channel_id, threadId)
    const ack = loadAccess().ackReaction
    if (ack && bot) void mm.addReaction(bot.id, post.id, ack.replace(/:/g, '')).catch(() => {})
    return
  }
  const st = starting.get(threadId)
  if (st) st.queue.push({ content, meta })
}

/** Wait until the pane shows no startup dialog, then hand queued messages to the session. */
async function flushStarting(threadId: string): Promise<void> {
  const st = starting.get(threadId)
  const conn = owners.get(threadId)
  if (!st || !conn) return
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const screen = await capturePane(st.tmux)
    if (!detectDialog(screen) && !looksLikePrompt(screen)) break
    await Bun.sleep(1000)
  }
  starting.delete(threadId)
  await edit(st.statusPostId, `🟢 Claude Code session started in \`${st.cwd}\` · attach with \`tmux attach -t ${st.tmux}\``)
  for (const q of st.queue) send(conn, { t: 'inbound', content: q.content, meta: q.meta })
  if (st.queue.length) mm.typing(st.channelId, threadId)
}

// ---------------------------------------------------------------- spawning

async function startSpawn(plan: SpawnPlan, firstPost: MMPost, carried?: Queued[]): Promise<void> {
  const access = loadAccess()
  const sp = access.spawn ?? {}
  const { threadId, channelId } = plan

  const max = sp.maxSessions ?? 5
  if (owners.size + starting.size >= max) {
    await say(channelId, threadId, `⚠️ ${owners.size + starting.size} sessions are already running (limit ${max}). Stop one with \`!stop\` in its thread.\n${sessionList()}`)
    return
  }

  const cwd = plan.cwd ?? (sp.baseDir && plan.workspace ? join(resolve(expandHome(sp.baseDir)), plan.workspace) : undefined)
  if (!cwd || !existsSync(cwd)) {
    await say(channelId, threadId, `❌ Can't start a session: folder \`${cwd ?? '(none)'}\` doesn't exist.`)
    return
  }
  const claudeBin = sp.claudeBin ?? Bun.which('claude')
  if (!claudeBin) {
    await say(channelId, threadId, '❌ Can\'t find the `claude` binary on PATH. Set `spawn.claudeBin` with /mattermost:configure.')
    return
  }
  if (!Bun.which('tmux')) {
    await say(channelId, threadId, '❌ tmux is not installed — it is needed to host spawned sessions.')
    return
  }
  const tmux = tmuxNameFor(threadId)
  if (await tmuxHasSession(tmux)) {
    await say(channelId, threadId, `⚠️ tmux session \`${tmux}\` already exists but hasn't connected. Inspect it with \`tmux attach -t ${tmux}\`, or send \`!stop\` here and try again.`)
    return
  }

  const sessionId = plan.resumeSessionId ?? randomUUID()
  const queue: Queued[] = carried ?? [{
    content: plan.content,
    meta: {
      ...(await buildMeta(firstPost, threadId)),
      spawned: 'true',
      ...(plan.resumed ? { resumed: 'true' } : {}),
    },
  }]
  const st: Starting = { channelId, tmux, cwd, queue, plan, retried: !!carried }
  starting.set(threadId, st)

  const prev = registry.get(threadId)
  registry.upsert(threadId, {
    channelId,
    origin: 'spawned',
    cwd,
    workspace: plan.workspace ?? prev?.workspace,
    claudeSessionId: sessionId,
    tmux,
    label: `${basename(cwd)} (spawned)`,
    endedAt: undefined,
  })

  const status = await say(channelId, threadId,
    `⏳ Starting Claude Code in \`${cwd}\`${plan.resumeSessionId ? ' (resuming the previous conversation)' : ''}…`)
  st.statusPostId = status?.id

  const env: Record<string, string> = {
    MATTERMOST_THREAD_ID: threadId,
    MATTERMOST_STATE_DIR: STATE_DIR,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
    ...(sp.env ?? {}),
  }
  const extraArgs = [...(sp.extraArgs ?? [])]
  if (sp.disablePlugins?.length) {
    extraArgs.push('--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(sp.disablePlugins.map(p => [p, false])) }))
  }

  const pluginRef = sp.pluginRef ?? 'plugin:mattermost@claude-mattermost'
  try {
    await startTmux({
      tmuxName: tmux,
      cwd,
      threadId,
      sessionId,
      resume: !!plan.resumeSessionId,
      displayName: `mm:${plan.workspace ?? basename(cwd)}`,
      permissionMode: sp.permissionMode ?? 'acceptEdits',
      channelFlag: sp.channelFlag ?? 'dev',
      pluginRef,
      claudeBin,
      extraArgs,
      allowedTools: sp.allowPluginTools === false ? [] : pluginToolNames(pluginRef),
      env,
    })
  } catch (err) {
    starting.delete(threadId)
    await edit(st.statusPostId, `❌ Failed to start session: ${errMsg(err)}`)
    return
  }
  log('hub', `spawned ${tmux} in ${cwd} for thread ${threadId}`)

  void shepherd(tmux, () => owners.has(threadId), {
    onDialog: d => log('hub', `${tmux}: answering ${d.name} dialog`),
  }).then(async outcome => {
    if (outcome === 'ready' || starting.get(threadId) !== st) return
    starting.delete(threadId)
    if (outcome === 'exited' && plan.resumeSessionId && !st.retried) {
      // --resume failed (e.g. transcript gone) → start fresh in the same folder, keep the messages.
      await edit(st.statusPostId, '⚠️ Could not resume the previous conversation — starting a fresh session.')
      for (const q of st.queue) q.meta.resumed = 'true'
      await startSpawn({ ...plan, resumeSessionId: undefined, cwd, resumed: true }, firstPost, st.queue)
      return
    }
    const why = {
      exited: 'the session exited during startup',
      stuck: `the session is waiting at a prompt — attach with \`tmux attach -t ${tmux}\``,
      timeout: `the session didn't connect within 90s — inspect with \`tmux attach -t ${tmux}\` and \`${PATHS.hubLog}\``,
    }[outcome]
    await edit(st.statusPostId, `❌ Session failed to start: ${why}.`)
  })
}

async function askWorkspace(plan: SpawnPlan, firstPost: MMPost): Promise<void> {
  const base = resolve(expandHome(loadAccess().spawn?.baseDir ?? '~'))
  let dirs: string[] = []
  try {
    dirs = readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort()
  } catch {}
  const shown = dirs.slice(0, 30).map(d => `\`${d}\``).join(', ')
  awaitingWorkspace.set(plan.threadId, { plan, firstPostId: firstPost.id, askedAt: Date.now() })
  saveAwaiting()
  await say(plan.channelId, plan.threadId, [
    `📁 Which workspace should sessions in this channel use? Reply in this thread with a folder name under \`${base}\` (no mention needed).`,
    dirs.length ? `Existing: ${shown}${dirs.length > 30 ? ` and ${dirs.length - 30} more` : ''}` : '',
    'To create a new folder, reply `create <name>`.',
  ].filter(Boolean).join('\n'))
}

async function onWorkspaceAnswer(threadId: string, text: string): Promise<void> {
  const aw = awaitingWorkspace.get(threadId)
  if (!aw) return
  const { plan } = aw
  const parsed = parseWorkspaceAnswer(text)
  if (!parsed.ok) {
    await say(plan.channelId, threadId, `❌ ${parsed.error}`)
    return
  }
  const base = resolve(expandHome(loadAccess().spawn?.baseDir ?? '~'))
  const dir = join(base, parsed.name)
  if (!dir.startsWith(base + '/')) {
    await say(plan.channelId, threadId, '❌ That name resolves outside the base directory.')
    return
  }
  if (!existsSync(dir)) {
    if (!parsed.create) {
      await say(plan.channelId, threadId, `\`${dir}\` doesn't exist. Reply \`create ${parsed.name}\` to make it, or name an existing folder.`)
      return
    }
    mkdirSync(dir, { recursive: true })
  } else if (!statSync(dir).isDirectory()) {
    await say(plan.channelId, threadId, `❌ \`${dir}\` is not a folder.`)
    return
  }
  let firstPost: MMPost
  try {
    firstPost = await mm.getPost(aw.firstPostId)
  } catch (err) {
    awaitingWorkspace.delete(threadId)
    saveAwaiting()
    await say(plan.channelId, threadId, `❌ The original message is gone (${errMsg(err)}) — mention me again to start a session.`)
    return
  }
  Registry.setWorkspace(plan.channelId, parsed.name)
  awaitingWorkspace.delete(threadId)
  saveAwaiting()
  await say(plan.channelId, threadId, `📁 Saved — sessions started in this channel will use \`${parsed.name}\`. Change it with \`/mattermost:sessions workspace\`.`)
  await startSpawn({ ...plan, workspace: parsed.name }, firstPost)
}

function sessionList(): string {
  const lines: string[] = []
  for (const [threadId, conn] of owners) {
    const rec = registry.get(threadId)
    const label = rec?.label ?? conn.hello?.label ?? threadId
    lines.push(`- [${label}](${mm.permalink(threadId)}) — \`${rec?.cwd ?? conn.hello?.cwd}\`${rec?.tmux && rec.origin === 'spawned' ? ` · tmux \`${rec.tmux}\`` : ''}`)
  }
  for (const [threadId, st] of starting) lines.push(`- [starting…](${mm.permalink(threadId)}) — \`${st.cwd}\``)
  return lines.length ? lines.join('\n') : '_No live sessions._'
}

async function onCommand(threadId: string, channelId: string, command: 'stop' | 'sessions'): Promise<void> {
  if (command === 'sessions') {
    await say(channelId, threadId, `**Live sessions**\n${sessionList()}`)
    return
  }
  const rec = registry.get(threadId)
  const st = starting.get(threadId)
  const tmux = st?.tmux ?? (rec?.origin === 'spawned' ? rec.tmux : undefined)
  if (tmux && (await tmuxHasSession(tmux))) {
    starting.delete(threadId)
    await tmuxKill(tmux)
    if (!owners.has(threadId)) await say(channelId, threadId, `⏹ Stopped \`${tmux}\`.`)
    // a live session's socket closes → the 🔴 notice is posted by onClose
    return
  }
  if (owners.has(threadId)) {
    await say(channelId, threadId, 'This session was started from a terminal — stop it there.')
    return
  }
  await say(channelId, threadId, 'No session is running in this thread.')
}

// ---------------------------------------------------------------- permissions

function fence(s: string): string {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map(m => m[0].length))
  return '`'.repeat(longest + 1)
}

async function onPermissionRequest(conn: Conn, p: { request_id: string; tool_name: string; description: string; input_preview: string }): Promise<void> {
  const threadId = conn.threadId
  if (!threadId || !conn.channelId) return
  let pretty = p.input_preview
  try { pretty = JSON.stringify(JSON.parse(p.input_preview), null, 2) } catch {}
  if (pretty.length > 3000) pretty = pretty.slice(0, 3000) + '\n…'
  const f = fence(pretty)
  const text = [
    `🔐 **Permission request** · \`${p.tool_name}\``,
    p.description,
    `${f}\n${pretty}\n${f}`,
    `Reply \`yes ${p.request_id}\` or \`no ${p.request_id}\`, or react :white_check_mark: / :x:.`,
  ].join('\n')
  const posted = await say(conn.channelId, threadId, text)
  if (!posted) return
  let m = pendingPerms.get(threadId)
  if (!m) pendingPerms.set(threadId, (m = new Map()))
  m.set(p.request_id, { postId: posted.id, text })
  permPosts.set(posted.id, { threadId, requestId: p.request_id })
}

async function resolvePermission(threadId: string, requestId: string, behavior: 'allow' | 'deny', byUserId: string, replyPostId?: string): Promise<void> {
  const entry = pendingPerms.get(threadId)?.get(requestId)
  if (!entry) return
  pendingPerms.get(threadId)!.delete(requestId)
  permPosts.delete(entry.postId)
  const conn = owners.get(threadId)
  if (conn) send(conn, { t: 'permission', request_id: requestId, behavior })
  const who = await mm.username(byUserId)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await edit(entry.postId, `${entry.text}\n\n**${label}** by @${who}`)
  if (replyPostId && bot) void mm.addReaction(bot.id, replyPostId, behavior === 'allow' ? 'white_check_mark' : 'x').catch(() => {})
}

function dropPermissions(threadId: string): void {
  const m = pendingPerms.get(threadId)
  if (!m) return
  for (const { postId } of m.values()) permPosts.delete(postId)
  pendingPerms.delete(threadId)
}

// ---------------------------------------------------------------- Mattermost events

async function onEvent(ev: MMEvent): Promise<void> {
  if (!bot) return
  if (ev.kind === 'reaction_added') {
    const access = loadAccess()
    const a = decideReaction(
      { postId: ev.reaction.post_id, userId: ev.reaction.user_id, emojiName: ev.reaction.emoji_name },
      { botUserId: bot.id, access, permissionPosts: permPosts },
    )
    if (a.kind === 'permission') await resolvePermission(a.threadId, a.requestId, a.behavior, ev.reaction.user_id)
    return
  }

  const post = ev.post
  if (post.type && post.type !== '' && !post.type.startsWith('custom_')) return // system messages
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  const action = decidePost(
    {
      postId: post.id,
      rootId: post.root_id ?? '',
      channelId: post.channel_id,
      channelType: await channelType(post.channel_id, ev.channelType),
      userId: post.user_id,
      message: post.message ?? '',
    },
    {
      botUserId: bot.id,
      botUsername: bot.username,
      access,
      liveThreads: new Set(owners.keys()),
      startingThreads: new Set(starting.keys()),
      detachedThreads: new Set(post.root_id && isDetached(post.root_id) ? [post.root_id] : []),
      awaitingWorkspace: new Set(awaitingWorkspace.keys()),
      pendingPermissions: new Map([...pendingPerms].map(([t, m]) => [t, new Set(m.keys())])),
      threads: registry.threads,
      workspaces: Registry.workspaces(),
    },
  )

  switch (action.kind) {
    case 'drop':
      return
    case 'pair': {
      const result = issuePairingCode(access, action.senderId, action.channelId)
      if (!result) return
      saveAccess(access)
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await say(post.channel_id, post.root_id || post.id, `${lead} — run in Claude Code:\n\n\`/mattermost:access pair ${result.code}\``)
      return
    }
    case 'permission':
      await resolvePermission(action.threadId, action.requestId, action.behavior, post.user_id, post.id)
      return
    case 'workspaceAnswer':
      await onWorkspaceAnswer(action.threadId, action.text)
      return
    case 'command':
      await onCommand(action.threadId, action.channelId, action.command)
      return
    case 'deliver':
      await deliver(action.threadId, post, action.content)
      return
    case 'notice':
      await say(action.channelId, action.threadId, action.text)
      return
    case 'askWorkspace':
      await askWorkspace(action.plan, post)
      return
    case 'spawn':
      await startSpawn(action.plan, post)
      return
  }
}

// ---------------------------------------------------------------- pairing approvals

async function checkApprovals(): Promise<void> {
  if (!bot) return
  let files: string[]
  try {
    files = readdirSync(PATHS.approved)
  } catch {
    return
  }
  for (const senderId of files) {
    const file = join(PATHS.approved, senderId)
    try {
      const dm = await mm.directChannel(bot.id, senderId)
      await mm.createPost({
        channel_id: dm.id,
        message: `Paired! Mention @${bot.username} in a new message here to start a Claude Code session, or reply in a session's thread to talk to it.`,
      })
    } catch (err) {
      log('hub', `approval confirm to ${senderId} failed: ${errMsg(err)}`)
    }
    rmSync(file, { force: true })
  }
  if (files.length) await bindWaiting()
}

// ---------------------------------------------------------------- session connections

async function bindWaiting(): Promise<void> {
  for (const conn of [...unbound]) await bind(conn)
}

async function bind(conn: Conn): Promise<void> {
  const h = conn.hello
  if (!h || conn.sock.destroyed) return
  if (!bot) {
    unbound.add(conn)
    send(conn, { t: 'waiting', reason: 'hub is still connecting to Mattermost' })
    return
  }

  let threadId = h.threadId
  let channelId: string | undefined
  let note: string | undefined

  if (!threadId && h.claudePid) {
    const t = registry.findByClaudePid(h.claudePid)
    if (t && !owners.has(t) && registry.get(t)?.origin === 'manual') threadId = t
  }

  if (threadId) {
    const holder = owners.get(threadId)
    if (holder && holder !== conn) {
      note = `thread ${threadId} is already held by another live session — opened a new thread instead`
      threadId = null
    } else {
      try {
        const p = await mm.getPost(threadId)
        threadId = p.root_id || p.id
        channelId = p.channel_id
      } catch (err) {
        note = `thread ${threadId} not found (${errMsg(err)}) — opened a new thread instead`
        threadId = null
      }
    }
  }

  const now = Date.now()
  if (!threadId) {
    let home: string | undefined
    try {
      home = await homeChannelId(loadAccess())
    } catch (err) {
      log('hub', `home channel lookup failed: ${errMsg(err)}`)
    }
    if (!home) {
      unbound.add(conn)
      send(conn, { t: 'waiting', reason: `not paired yet — DM @${bot.username} on Mattermost (mention it) and approve the code with /mattermost:access pair <code>` })
      return
    }
    const root = await mm.createPost({
      channel_id: home,
      message: `🟢 **${h.label}** — Claude Code session started in \`${h.cwd}\`\n${mentionHint(home)}${note ? `\n_${note}_` : ''}`,
    })
    threadId = root.id
    channelId = home
    registry.upsert(threadId, {
      channelId, origin: 'manual', cwd: h.cwd, label: h.label,
      claudePid: h.claudePid, claudeSessionId: h.sessionId, lastBoundAt: now,
    })
  } else {
    const rec = registry.get(threadId)
    const wasEnded = !!rec?.endedAt
    registry.upsert(threadId, {
      channelId: channelId!,
      origin: rec?.origin ?? 'manual',
      cwd: rec?.cwd ?? h.cwd,
      label: rec?.label ?? h.label,
      claudePid: h.claudePid ?? rec?.claudePid,
      claudeSessionId: h.sessionId ?? rec?.claudeSessionId,
      lastBoundAt: now,
      endedAt: undefined,
    })
    if (!starting.has(threadId) && (wasEnded || !rec)) {
      await say(channelId!, threadId, `🟢 **${h.label}** attached to this thread (\`${h.cwd}\`).`)
    }
  }

  unbound.delete(conn)
  owners.set(threadId, conn)
  conn.threadId = threadId
  conn.channelId = channelId
  send(conn, { t: 'bound', threadId, channelId: channelId!, ...(note ? { note } : {}) })
  log('hub', `session pid=${h.pid} bound to thread ${threadId}`)
  if (starting.has(threadId)) void flushStarting(threadId)
}

async function onHello(conn: Conn, h: HelloMsg): Promise<void> {
  conn.hello = h
  if (compareVersions(h.version, VERSION) > 0) {
    log('hub', `client v${h.version} is newer than hub v${VERSION} — handing over`)
    for (const c of conns) send(c, { t: 'restart', reason: `hub upgrading to v${h.version}` })
    shutdown()
    return
  }
  await bind(conn)
}

function onClose(conn: Conn): void {
  conns.delete(conn)
  unbound.delete(conn)
  const threadId = conn.threadId
  if (!threadId || owners.get(threadId) !== conn) return
  owners.delete(threadId)
  dropPermissions(threadId)
  if (shuttingDown) return
  log('hub', `session for thread ${threadId} disconnected`)
  // Grace period: a /reload-plugins reconnects within a second or two — don't announce that.
  const endedAt = Date.now()
  setTimeout(() => {
    if (shuttingDown || owners.has(threadId) || starting.has(threadId)) return
    registry.patch(threadId, { endedAt })
    if (conn.channelId) void say(conn.channelId, threadId, `🔴 Session ended. Mention @${bot?.username} here to start it again.`)
  }, 3000)
}

function isClaudeProcess(pid: number): boolean {
  if (!isPidAlive(pid)) return false
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return isClaudeArgs(args.trim())
  } catch {
    return false
  }
}

/** Thread whose claude process is alive but not connected (mid-reload, or hub restarted). */
function isDetached(threadId: string): boolean {
  if (!threadId || owners.has(threadId) || starting.has(threadId)) return false
  const pid = registry.get(threadId)?.claudePid
  return !!pid && isClaudeProcess(pid)
}

function assertInThread(post: MMPost, conn: Conn): void {
  if ((post.root_id || post.id) !== conn.threadId) {
    throw new Error(`message ${post.id} is not in this session's thread`)
  }
}

const UNICODE_EMOJI: Record<string, string> = {
  '👍': '+1', '👎': '-1', '✅': 'white_check_mark', '❌': 'x', '👀': 'eyes', '🎉': 'tada',
  '❤️': 'heart', '❤': 'heart', '🔥': 'fire', '🙏': 'pray', '😂': 'joy', '🚀': 'rocket',
  '🤔': 'thinking_face', '👌': 'ok_hand', '💯': '100', '⏳': 'hourglass_flowing_sand', '✔️': 'heavy_check_mark',
}

async function callTool(conn: Conn, tool: string, args: Record<string, unknown>): Promise<string> {
  const threadId = conn.threadId
  const channelId = conn.channelId
  if (!threadId || !channelId || !bot) throw new Error('this session is not bound to a Mattermost thread yet')

  switch (tool) {
    case 'reply': {
      const text = typeof args.text === 'string' ? args.text : ''
      const files = Array.isArray(args.files) ? (args.files as unknown[]).map(String) : []
      if (args.chat_id != null && String(args.chat_id) !== channelId) {
        throw new Error(`this session can only post in its own thread (chat_id ${channelId})`)
      }
      if (!text && files.length === 0) throw new Error('text or files required')
      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (!st.isFile()) throw new Error(`not a file: ${f}`)
        if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f} (${fmtSize(st.size)}, max 50MB)`)
      }
      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_POST_CHARS, MAX_POST_CHARS))
      const chunks = text ? chunk(text, limit, access.chunkMode ?? 'length') : []
      const batches: string[][] = []
      for (let i = 0; i < files.length; i += MAX_FILES_PER_POST) batches.push(files.slice(i, i + MAX_FILES_PER_POST))
      const fileIdBatches: string[][] = []
      for (const b of batches) fileIdBatches.push((await mm.uploadFiles(channelId, b)).map(fi => fi.id))

      const sent: string[] = []
      try {
        for (let i = 0; i < chunks.length; i++) {
          const attach = i === chunks.length - 1 ? fileIdBatches.shift() : undefined
          const p = await mm.createPost({ channel_id: channelId, root_id: threadId, message: chunks[i]!, ...(attach ? { file_ids: attach } : {}) })
          sent.push(p.id)
        }
        for (const ids of fileIdBatches) {
          const p = await mm.createPost({ channel_id: channelId, root_id: threadId, message: '', file_ids: ids })
          sent.push(p.id)
        }
      } catch (err) {
        throw new Error(`reply failed after ${sent.length} post(s): ${errMsg(err)}`)
      }
      return sent.length === 1 ? `sent (id: ${sent[0]})` : `sent ${sent.length} posts (ids: ${sent.join(', ')})`
    }

    case 'react': {
      const messageId = String(args.message_id ?? '')
      const raw = String(args.emoji ?? '').trim()
      const emoji = UNICODE_EMOJI[raw] ?? raw.replace(/^:|:$/g, '')
      if (!emoji) throw new Error('emoji required')
      assertInThread(await mm.getPost(messageId), conn)
      await mm.addReaction(bot.id, messageId, emoji)
      return 'reacted'
    }

    case 'edit_message': {
      const messageId = String(args.message_id ?? '')
      const text = String(args.text ?? '')
      if (text.length > 16383) throw new Error('text exceeds Mattermost\'s 16383-character post limit')
      const post = await mm.getPost(messageId)
      assertInThread(post, conn)
      if (post.user_id !== bot.id) throw new Error('can only edit messages this bot sent')
      await mm.patchPost(messageId, text)
      return `edited (id: ${messageId})`
    }

    case 'download_attachment': {
      const post = await mm.getPost(String(args.message_id ?? ''))
      assertInThread(post, conn)
      const files = await postFiles(post)
      if (!files.length) return 'message has no attachments'
      const lines: string[] = []
      for (const f of files) {
        const path = await saveFile(f)
        lines.push(`${path}  (${safeName(f.name)}, ${f.mime_type ?? 'unknown'}, ${fmtSize(f.size)})`)
      }
      return lines.join('\n')
    }

    case 'fetch_thread': {
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200))
      const th = await mm.getThread(threadId)
      const posts = Object.values(th.posts)
        .filter(p => !p.type || p.type.startsWith('custom_'))
        .sort((a, b) => a.create_at - b.create_at)
      const shown = posts.slice(-limit)
      const lines: string[] = [`thread ${threadId} — ${posts.length} messages, showing the last ${shown.length} (oldest first)`]
      for (const p of shown) {
        const who = p.user_id === bot.id ? `${bot.username} (you)` : await mm.username(p.user_id)
        const n = p.file_ids?.length ?? p.metadata?.files?.length ?? 0
        lines.push(`[${new Date(p.create_at).toISOString()}] ${who}: ${p.message}${n ? ` (+${n} file${n > 1 ? 's' : ''})` : ''}  (id: ${p.id})`)
      }
      return lines.join('\n')
    }

    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

function onClientMsg(conn: Conn, msg: ClientMsg): void {
  switch (msg.t) {
    case 'hello':
      enqueue(() => onHello(conn, msg))
      return
    case 'permission_request':
      enqueue(() => onPermissionRequest(conn, msg))
      return
    case 'call':
      // Tool calls run concurrently with event handling (uploads can be slow).
      void callTool(conn, msg.tool, msg.args ?? {}).then(
        text => send(conn, { t: 'result', id: msg.id, ok: true, text }),
        err => send(conn, { t: 'result', id: msg.id, ok: false, error: errMsg(err) }),
      )
      return
  }
}

// ---------------------------------------------------------------- IPC server

let nextConnId = 1
const server = net.createServer(sock => {
  const conn: Conn = { id: nextConnId++, sock }
  conns.add(conn)
  const dec = new LineDecoder<ClientMsg>()
  sock.on('data', data => {
    for (const msg of dec.push(data)) onClientMsg(conn, msg)
  })
  sock.on('close', () => onClose(conn))
  sock.on('error', () => {})
})

try { unlinkSync(PATHS.sock) } catch {}
server.listen(PATHS.sock, () => {
  try { chmodSync(PATHS.sock, 0o600) } catch {}
  writeJsonAtomic(PATHS.hubInfo, { pid: process.pid, version: VERSION, entry: import.meta.path, startedAt: Date.now() })
  log('hub', `v${VERSION} listening on ${PATHS.sock} (pid ${process.pid})`)
})
server.on('error', err => {
  log('hub', `ipc server error: ${errMsg(err)}`)
  shutdown()
})

// ---------------------------------------------------------------- lifecycle

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('hub', 'shutting down')
  mm.stop()
  for (const c of conns) c.sock.end()
  server.close()
  if (ownsLock()) {
    try { unlinkSync(PATHS.sock) } catch {}
    try { unlinkSync(PATHS.lock) } catch {}
  }
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', () => {}) // detached daemon — ignore terminal hangups

// If another hub stole the lock (e.g. a stale-lock race), step down.
setInterval(() => {
  if (!shuttingDown && !ownsLock()) {
    log('hub', 'lost hub.lock — exiting')
    shutdown()
  }
}, 10_000)

setInterval(() => enqueue(checkApprovals), 5000)

async function connectMattermost(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      const me = await mm.me()
      bot = { id: me.id, username: me.username }
      log('hub', `authenticated as @${me.username}`)
      break
    } catch (err) {
      const delay = Math.min(1000 * attempt, 30_000)
      log('hub', `cannot reach Mattermost (${errMsg(err)}) — retrying in ${delay / 1000}s`)
      await Bun.sleep(delay)
    }
  }
  if (shuttingDown) return
  mm.listen({
    onEvent: ev => enqueue(() => onEvent(ev)),
    onReconnect: () => log('hub', 'websocket reconnected (posts sent while disconnected are not replayed)'),
  })
  enqueue(bindWaiting)
}

void connectMattermost()
