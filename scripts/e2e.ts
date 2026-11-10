#!/usr/bin/env bun
/**
 * End-to-end check against a live Mattermost server.
 *
 *   docker run -d --platform linux/amd64 --name mm-test -p 127.0.0.1:8065:8065 \
 *     -e MM_SERVICESETTINGS_ENABLEBOTACCOUNTCREATION=true \
 *     -e MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true mattermost/mattermost-preview
 *   bun scripts/e2e.ts
 *
 * Creates (or logs into) an admin user, a team, a stranger and a bot; writes an
 * isolated state dir; drives the real channel server(s) over MCP stdio; and
 * checks pairing, mention gating, routing/isolation, tools and permission relay.
 *
 * MM_E2E_SPAWN=1 also starts a real Claude Code session from a post (needs the
 * plugin installed as mattermost@claude-mattermost and uses a little quota).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'

const URL = (process.env.MM_E2E_URL ?? 'http://127.0.0.1:8065').replace(/\/$/, '')
const ADMIN = process.env.MM_E2E_ADMIN ?? 'e2eadmin'
const PASSWORD = process.env.MM_E2E_PASSWORD ?? 'E2e-password-123!'
const SPAWN = process.env.MM_E2E_SPAWN === '1'
const ROOT = join(import.meta.dir, '..')
const RUN = Date.now().toString(36)
const STATE = mkdtempSync(join(tmpdir(), 'mm-e2e-'))

let failures = 0
function check(cond: unknown, label: string): void {
  if (cond) console.log(`  ✔ ${label}`)
  else {
    failures++
    console.log(`  ✘ ${label}`)
  }
}

async function api<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL}/api/v4${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

async function login(username: string, password: string): Promise<{ token: string; id: string }> {
  const res = await fetch(`${URL}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: username, password }),
  })
  if (!res.ok) throw new Error(`login ${username} → ${res.status}`)
  const user = (await res.json()) as { id: string }
  return { token: res.headers.get('Token')!, id: user.id }
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await Bun.sleep(300)
  }
  console.log(`  … timed out waiting for ${label}`)
  return undefined
}

type Inbound = { content: string; meta: Record<string, string> }

async function connectSession(name: string) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_PLUGIN_')) continue
    env[k] = v
  }
  Object.assign(env, { MATTERMOST_STATE_DIR: STATE, MATTERMOST_AUTOTHREAD: 'always', CLAUDE_PROJECT_DIR: `/tmp/${name}` })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src/server.ts')], env, cwd: ROOT, stderr: 'pipe' })
  const client = new Client({ name: `e2e-${name}`, version: '0' })
  const inbox: Inbound[] = []
  const verdicts: { request_id: string; behavior: string }[] = []
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    n => { inbox.push(n.params) },
  )
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }),
    n => { verdicts.push(n.params) },
  )
  await client.connect(transport)
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { text: r.content[0]?.text ?? '', isError: !!r.isError }
  }
  return { client, transport, inbox, verdicts, call }
}

console.log(`Mattermost: ${URL}\nState dir: ${STATE}\n`)

// ---------------------------------------------------------------- server setup
console.log('setup')
await api(null, 'GET', '/system/ping')
let admin: { token: string; id: string }
try {
  admin = await login(ADMIN, PASSWORD)
} catch {
  await api(null, 'POST', '/users', { email: `${ADMIN}@example.com`, username: ADMIN, password: PASSWORD })
  admin = await login(ADMIN, PASSWORD)
}
const adminUser = await api(admin.token, 'GET', '/users/me')
const team = await api(admin.token, 'POST', '/teams', { name: `e2e${RUN}`, display_name: `E2E ${RUN}`, type: 'O' })
const strangerName = `stranger${RUN}`
await api(admin.token, 'POST', '/users', { email: `${strangerName}@example.com`, username: strangerName, password: PASSWORD })
const stranger = await login(strangerName, PASSWORD)
const bot = await api(admin.token, 'POST', '/bots', { username: `claude${RUN}`, display_name: 'Claude' })
for (const uid of [stranger.id, bot.user_id]) await api(admin.token, 'POST', `/teams/${team.id}/members`, { team_id: team.id, user_id: uid })
const botToken = (await api(admin.token, 'POST', `/users/${bot.user_id}/tokens`, { description: 'e2e' })).token as string
const BOTNAME = `claude${RUN}`
const dm = await api(admin.token, 'POST', '/channels/direct', [admin.id, bot.user_id])
const strangerDm = await api(stranger.token, 'POST', '/channels/direct', [stranger.id, bot.user_id])
console.log(`  bot @${BOTNAME}, owner @${adminUser.username}`)

writeFileSync(join(STATE, '.env'), `MATTERMOST_URL=${URL}\nMATTERMOST_BOT_TOKEN=${botToken}\n`, { mode: 0o600 })
mkdirSync(join(STATE, 'ws', 'existing'), { recursive: true })
writeFileSync(join(STATE, 'access.json'), JSON.stringify({
  dmPolicy: 'pairing',
  allowFrom: [admin.id],
  channels: {},
  pending: {},
  spawn: {
    baseDir: join(STATE, 'ws'),
    disablePlugins: (process.env.MM_E2E_DISABLE_PLUGINS ?? 'telegram@anthropic-plugin-directory').split(',').filter(Boolean),
    // Belt and braces: an empty telegram state dir makes telegram's server exit before touching its pid file.
    env: { TELEGRAM_STATE_DIR: join(STATE, 'telegram-isolated') },
  },
}, null, 2))

const ownerPost = (message: string, root_id = '', file_ids?: string[]) =>
  api(admin.token, 'POST', '/posts', { channel_id: dm.id, message, root_id, ...(file_ids ? { file_ids } : {}) })
const threadPosts = async (root: string) => {
  const th = await api(admin.token, 'GET', `/posts/${root}/thread`)
  return (Object.values(th.posts) as any[]).sort((a, b) => a.create_at - b.create_at)
}
const botPostsIn = async (channelId: string) => {
  const r = await api(admin.token, 'GET', `/channels/${channelId}/posts?per_page=100`)
  return (Object.values(r.posts) as any[]).filter(p => p.user_id === bot.user_id).sort((a, b) => a.create_at - b.create_at)
}

// ---------------------------------------------------------------- sessions & routing
console.log('\nterminal sessions open their own threads')
const A = await connectSession('sess-a')
const rootA = await waitFor('session A root post', async () =>
  (await botPostsIn(dm.id)).find(p => !p.root_id && p.message.includes('/tmp/sess-a')), 25_000)
check(rootA, 'session A opened a 🟢 thread in the owner DM')
const B = await connectSession('sess-b')
const rootB = await waitFor('session B root post', async () =>
  (await botPostsIn(dm.id)).find(p => !p.root_id && p.message.includes('/tmp/sess-b')))
check(rootB && rootB.id !== rootA?.id, 'session B opened a different thread')
const threadA = rootA!.id as string
const threadB = rootB!.id as string

console.log('\nmention gating')
await ownerPost('no mention here', threadA)
await Bun.sleep(1500)
check(A.inbox.length === 0, 'reply without mention is ignored')
await ownerPost(`@${BOTNAME} hello A`, threadA)
const inA = await waitFor('inbound on A', () => A.inbox[0])
check(inA?.content === 'hello A', 'mention is delivered with the @bot prefix stripped')
check(inA?.meta.thread_id === threadA && inA?.meta.chat_id === dm.id && inA?.meta.user === adminUser.username, 'meta has thread_id, chat_id, user')

console.log('\nthread isolation')
await ownerPost(`@${BOTNAME} hello B`, threadB)
const inB = await waitFor('inbound on B', () => B.inbox[0])
check(inB?.content === 'hello B', 'B receives its thread message')
await Bun.sleep(800)
check(A.inbox.length === 1, 'A did not receive B\'s message')

console.log('\ntools')
const r1 = await A.call('reply', { chat_id: dm.id, text: 'pong from A' })
check(!r1.isError && /sent \(id: /.test(r1.text), `reply → ${r1.text}`)
const replyId = /id: (\w+)/.exec(r1.text)?.[1]
check((await threadPosts(threadA)).some(p => p.id === replyId && p.root_id === threadA), 'reply landed in thread A')
const r2 = await A.call('reply', { chat_id: 'someotherchannelid00000000', text: 'x' })
check(r2.isError, 'reply to a foreign chat_id is refused')
const r3 = await A.call('edit_message', { message_id: replyId, text: 'pong from A (edited)' })
check(!r3.isError && (await api(admin.token, 'GET', `/posts/${replyId}`)).message === 'pong from A (edited)', 'edit_message')
const r4 = await A.call('react', { message_id: inA!.meta.message_id, emoji: '👀' })
const reacts = await api(admin.token, 'GET', `/posts/${inA!.meta.message_id}/reactions`)
check(!r4.isError && Array.isArray(reacts) && reacts.some((x: any) => x.emoji_name === 'eyes'), 'react (unicode mapped to eyes)')
const r5 = await A.call('react', { message_id: inB!.meta.message_id, emoji: 'eyes' })
check(r5.isError, 'react on another session\'s thread is refused')
const r6 = await A.call('fetch_thread', {})
check(r6.text.includes('hello A') && r6.text.includes('pong from A (edited)') && !r6.text.includes('hello B'), 'fetch_thread returns only thread A')

const fileA = join(mkdtempSync(join(tmpdir(), 'mm-e2e-files-')), 'note.txt')
writeFileSync(fileA, 'attached by session A\n')
const r7 = await A.call('reply', { chat_id: dm.id, text: 'with file', files: [fileA] })
const filePostId = /id: (\w+)/.exec(r7.text)?.[1]
check(!r7.isError && ((await api(admin.token, 'GET', `/posts/${filePostId}`)).file_ids?.length === 1), `reply with a file attachment → ${r7.text}`)
const r8 = await A.call('reply', { chat_id: dm.id, text: 'leak', files: [join(STATE, '.env')] })
check(r8.isError && r8.text.includes('refusing'), 'refuses to upload channel state (.env)')

// owner sends an image → eager download into inbox
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const form = new FormData()
form.append('channel_id', dm.id)
form.append('files', new Blob([png], { type: 'image/png' }), 'dot.png')
const up = await api(admin.token, 'POST', '/files', form)
await ownerPost(`@${BOTNAME} see image`, threadA, [up.file_infos[0].id])
const imgIn = await waitFor('image inbound', () => A.inbox.find(m => m.content === 'see image'))
check(imgIn?.meta.attachment_count === '1' && imgIn?.meta.image_path && existsSync(imgIn.meta.image_path), 'image is downloaded eagerly (image_path)')
const r9 = await A.call('download_attachment', { message_id: imgIn!.meta.message_id })
const dlPath = r9.text.split('  ')[0]!
check(!r9.isError && existsSync(dlPath) && readFileSync(dlPath).equals(png), 'download_attachment')

console.log('\npermission relay')
await A.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' } })
const permPost = await waitFor('🔐 post', async () => (await threadPosts(threadA)).find(p => p.message.includes('Permission request') && p.message.includes('abcde')))
check(permPost, '🔐 prompt posted in the session thread')
await api(stranger.token, 'POST', '/reactions', { user_id: stranger.id, post_id: permPost!.id, emoji_name: 'white_check_mark' }).catch(() => {})
await Bun.sleep(1000)
check(A.verdicts.length === 0, 'reaction from a non-owner is ignored')
await api(admin.token, 'POST', '/reactions', { user_id: admin.id, post_id: permPost!.id, emoji_name: 'white_check_mark' })
const v1 = await waitFor('allow verdict', () => A.verdicts.find(v => v.request_id === 'abcde'))
check(v1?.behavior === 'allow', 'owner ✅ reaction → allow')
check((await waitFor('edited prompt', async () => (await api(admin.token, 'GET', `/posts/${permPost!.id}`)).message.includes('Allowed') || undefined)), 'prompt edited to show the verdict')
await A.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'fghij', tool_name: 'Write', description: 'Write a file', input_preview: '{}' } })
await waitFor('second 🔐 post', async () => (await threadPosts(threadA)).find(p => p.message.includes('fghij')))
await ownerPost('no fghij', threadA)
const v2 = await waitFor('deny verdict', () => A.verdicts.find(v => v.request_id === 'fghij'))
check(v2?.behavior === 'deny', 'text reply "no fghij" (no mention) → deny')
check(B.verdicts.length === 0, 'B got no verdicts')

console.log('\npairing')
await api(stranger.token, 'POST', '/posts', { channel_id: strangerDm.id, message: 'hello?' })
await Bun.sleep(1500)
check((await botPostsIn(strangerDm.id)).length === 0, 'stranger DM without mention → silence')
await api(stranger.token, 'POST', '/posts', { channel_id: strangerDm.id, message: `@${BOTNAME} hi` })
const pairPost = await waitFor('pairing reply', async () => (await botPostsIn(strangerDm.id)).find(p => p.message.includes('/mattermost:access pair')))
check(pairPost, 'stranger DM with mention → pairing code')
const access = JSON.parse(readFileSync(join(STATE, 'access.json'), 'utf8'))
check(Object.values(access.pending).some((p: any) => p.senderId === stranger.id), 'pending entry written to access.json')

console.log('\ncommands, workspace question, session end')
await ownerPost(`@${BOTNAME} !sessions`, threadA)
const list = await waitFor('!sessions reply', async () => (await threadPosts(threadA)).find(p => p.user_id === bot.user_id && p.message.includes('Live sessions')))
check(list && list.message.includes('sess-a') && list.message.includes('sess-b'), '!sessions lists both sessions')

const top = await ownerPost(`@${BOTNAME} Reply in this thread with exactly the word: pong`)
const ask = await waitFor('workspace question', async () => (await threadPosts(top.id)).find(p => p.user_id === bot.user_id && p.message.includes('Which workspace')))
check(ask && ask.message.includes('existing'), 'top-level post in a new channel → asks for a workspace (lists existing folders)')
await ownerPost('../etc', top.id)
check(await waitFor('invalid-name reply', async () => (await threadPosts(top.id)).find(p => p.user_id === bot.user_id && p.message.includes('Workspace names may only'))), 'invalid workspace name is rejected')
await ownerPost('missing-folder', top.id)
check(await waitFor('missing-folder reply', async () => (await threadPosts(top.id)).find(p => p.user_id === bot.user_id && p.message.includes('create missing-folder'))), 'unknown folder → asks to confirm with `create <name>`')

console.log('\nhub restart → sessions rebind to their threads')
const hubPid1 = JSON.parse(readFileSync(join(STATE, 'hub.json'), 'utf8')).pid
process.kill(hubPid1, 'SIGTERM')
const hubPid2 = await waitFor('new hub', () => {
  try {
    const pid = JSON.parse(readFileSync(join(STATE, 'hub.json'), 'utf8')).pid
    return pid !== hubPid1 ? pid : undefined
  } catch { return undefined }
}, 30_000)
check(hubPid2, `a session restarted the hub (pid ${hubPid1} → ${hubPid2})`)
const before = A.inbox.length
await waitFor('A rebound', async () => {
  await ownerPost(`@${BOTNAME} after restart`, threadA)
  return (await waitFor('inbound after restart', () => A.inbox.slice(before).find(m => m.content === 'after restart'), 3000)) ?? undefined
}, 30_000)
check(A.inbox.slice(before).some(m => m.content === 'after restart'), 'A still receives its thread after the hub restart')
check(!(await threadPosts(threadA)).some(p => p.message.includes('attached to this thread')), 'no duplicate 🟢 notice on silent rebind')

console.log('\nplain sessions (no channel flag) stay idle')
const idleEnv: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE')) idleEnv[k] = v
Object.assign(idleEnv, { MATTERMOST_STATE_DIR: STATE, CLAUDE_PROJECT_DIR: '/tmp/sess-idle' })
const idle = new Client({ name: 'e2e-idle', version: '0' })
await idle.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src/server.ts')], env: idleEnv, cwd: ROOT, stderr: 'pipe' }))
await Bun.sleep(2500)
check((await idle.listTools()).tools.length === 0, 'no tools exposed')
check(!(await botPostsIn(dm.id)).some(p => p.message.includes('/tmp/sess-idle')), 'no thread opened')
await idle.close()

await B.client.close()
const ended = await waitFor('🔴 post', async () => (await threadPosts(threadB)).find(p => p.message.includes('Session ended')), 10_000)
check(ended, 'closing session B posts 🔴 in its thread')

if (SPAWN) {
  console.log('\nspawn a real Claude Code session')
  await ownerPost('create demo', top.id)
  const started = await waitFor('🟢 started', async () => (await threadPosts(top.id)).find(p => p.user_id === bot.user_id && p.message.includes('session started in')), 120_000)
  check(started, 'spawned session connected (tmux)')
  const pong = await waitFor('pong reply', async () => (await threadPosts(top.id)).find(p => p.user_id === bot.user_id && /^\s*pong\W*$/i.test(p.message)), 180_000)
  check(pong, 'spawned session answered in the thread')
  const ws = JSON.parse(readFileSync(join(STATE, 'workspaces.json'), 'utf8'))
  check(ws[dm.id] === 'demo', 'workspace remembered for the channel')
  await ownerPost(`@${BOTNAME} !stop`, top.id)
  check(await waitFor('🔴 after !stop', async () => (await threadPosts(top.id)).find(p => p.message.includes('Session ended')), 20_000), '!stop ends the spawned session')

  console.log('\nmention in an ended thread resumes the conversation')
  const nBefore = (await threadPosts(top.id)).length
  await ownerPost(`@${BOTNAME} What single word did you reply with earlier in this conversation? Answer with just that word, in capitals.`, top.id)
  const resumedStatus = await waitFor('resume status', async () => (await threadPosts(top.id)).slice(nBefore).find(p => p.user_id === bot.user_id && p.message.includes('resuming the previous conversation')), 20_000)
  check(resumedStatus, 'respawned with --resume')
  const recalled = await waitFor('recall reply', async () => (await threadPosts(top.id)).slice(nBefore).find(p => p.user_id === bot.user_id && /^\s*PONG\W*$/.test(p.message)), 180_000)
  check(recalled, 'resumed session remembers the earlier conversation')
  await ownerPost(`@${BOTNAME} !stop`, top.id)
  await waitFor('🔴 after second !stop', async () => (await threadPosts(top.id)).slice(nBefore).find(p => p.message.includes('Session ended')), 20_000)

  console.log('\nterminal session detected through the process tree')
  const { shepherd, tmuxKill } = await import('../src/spawn')
  const termCwd = join(STATE, 'ws', 'existing')
  const claudeBin = Bun.which('claude')!
  const termTmux = `mm-e2e-term-${RUN}`
  const { spawnSync } = await import('child_process')
  spawnSync('tmux', ['new-session', '-d', '-s', termTmux, '-x', '200', '-y', '50', '-c', termCwd,
    '-e', `MATTERMOST_STATE_DIR=${STATE}`, '-e', `TELEGRAM_STATE_DIR=${join(STATE, 'telegram-isolated')}`, '-e', `PATH=${process.env.PATH}`,
    claudeBin, '--settings', JSON.stringify({ enabledPlugins: { 'telegram@anthropic-plugin-directory': false } }),
    '--dangerously-load-development-channels', 'plugin:mattermost@claude-mattermost'])
  let termRoot: any
  const sh = shepherd(termTmux, () => !!termRoot, { timeoutMs: 60_000 })
  termRoot = await waitFor('terminal 🟢 root', async () => (await botPostsIn(dm.id)).find(p => !p.root_id && p.message.includes(termCwd)), 60_000)
  await sh
  check(termRoot, 'claude launched with the channel flag (no MATTERMOST_THREAD_ID) opened its own thread')
  const thr = JSON.parse(readFileSync(join(STATE, 'threads.json'), 'utf8'))[termRoot?.id ?? '']
  check(thr?.claudePid && thr?.claudeSessionId, 'thread record has the claude pid and session id')
  await tmuxKill(termTmux)
} else {
  console.log('\n(spawn test skipped — set MM_E2E_SPAWN=1)')
}

await A.client.close()
const hub = JSON.parse(readFileSync(join(STATE, 'hub.json'), 'utf8'))
try { process.kill(hub.pid, 'SIGTERM') } catch {}
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} — hub log: ${join(STATE, 'hub.log')}`)
process.exit(failures === 0 ? 0 : 1)
