/**
 * Start Claude Code sessions in detached tmux sessions, and get them past the
 * two known startup dialogs (folder trust, dev-channel warning) unattended.
 */

export type SpawnOptions = {
  tmuxName: string
  cwd: string
  threadId: string
  sessionId: string
  /** true → --resume <sessionId>; false → --session-id <sessionId>. */
  resume: boolean
  displayName: string
  permissionMode: string
  channelFlag: 'dev' | 'channels'
  pluginRef: string
  claudeBin: string
  extraArgs: string[]
  /** Pre-approved tools (--allowedTools), e.g. this plugin's own thread-scoped tools. */
  allowedTools?: string[]
  /** Exported into the session via tmux -e. */
  env: Record<string, string>
}

export function tmuxNameFor(threadId: string): string {
  return `mm-${threadId.slice(0, 8)}`
}

export function buildClaudeArgs(o: SpawnOptions): string[] {
  return [
    o.claudeBin,
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
    '-n', o.displayName,
    '--permission-mode', o.permissionMode,
    ...(o.allowedTools?.length ? ['--allowedTools', o.allowedTools.join(',')] : []),
    o.channelFlag === 'channels' ? '--channels' : '--dangerously-load-development-channels',
    o.pluginRef,
    ...o.extraArgs,
  ]
}

export const CHANNEL_TOOLS = ['reply', 'react', 'edit_message', 'download_attachment', 'fetch_thread']

/** Tool names Claude Code gives this plugin's MCP tools: mcp__plugin_<plugin>_<server>__<tool>. */
export function pluginToolNames(pluginRef: string, server = 'mattermost'): string[] {
  const m = /^plugin:([^@]+)@/.exec(pluginRef)
  const prefix = m ? `mcp__plugin_${m[1]}_${server}__` : `mcp__${pluginRef.replace(/^server:/, '')}__`
  return CHANNEL_TOOLS.map(t => prefix + t)
}

/** argv for `tmux new-session` — tmux ≥3.0 execs a multi-arg command directly (no shell). */
export function buildTmuxArgs(o: SpawnOptions): string[] {
  const envArgs = Object.entries(o.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return ['tmux', 'new-session', '-d', '-s', o.tmuxName, '-x', '200', '-y', '50', '-c', o.cwd, ...envArgs, ...buildClaudeArgs(o)]
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}

export async function startTmux(o: SpawnOptions): Promise<void> {
  const r = await run(buildTmuxArgs(o))
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || `exit ${r.code}`}`)
}

export async function tmuxHasSession(name: string): Promise<boolean> {
  return (await run(['tmux', 'has-session', '-t', `=${name}`])).code === 0
}

export async function tmuxKill(name: string): Promise<boolean> {
  return (await run(['tmux', 'kill-session', '-t', `=${name}`])).code === 0
}

export async function capturePane(name: string): Promise<string> {
  const r = await run(['tmux', 'capture-pane', '-p', '-t', `=${name}:`])
  return r.code === 0 ? r.stdout : ''
}

export async function sendKeys(name: string, keys: string[]): Promise<void> {
  for (const k of keys) await run(['tmux', 'send-keys', '-t', `=${name}:`, k])
}

/**
 * Keys that move a Claude Code select-menu cursor (❯) onto the line containing
 * `phrase` and confirm it. null if the phrase isn't on screen.
 */
export function menuKeys(screen: string, phrase: string): string[] | null {
  const lines = screen.split('\n')
  const target = lines.findIndex(l => l.includes(phrase))
  if (target < 0) return null
  let cursor = -1
  for (let d = 0; d <= 8 && cursor < 0; d++) {
    for (const i of [target - d, target + d]) {
      if (i >= 0 && i < lines.length && /^\s*❯\s/.test(lines[i]!)) {
        cursor = i
        break
      }
    }
  }
  if (cursor < 0) return null
  const diff = target - cursor
  const move = diff > 0 ? Array(diff).fill('Down') : Array(-diff).fill('Up')
  return [...move, 'Enter']
}

export type Dialog = { name: string; keys: string[] }

/** Recognize the known startup dialogs (text captured from Claude Code 2.1.x). */
export function detectDialog(screen: string): Dialog | null {
  if (screen.includes('Loading development channels')) {
    const keys = menuKeys(screen, 'I am using this for local development')
    if (keys) return { name: 'dev-channels', keys }
  }
  if (screen.includes('Yes, I trust this folder')) {
    const keys = menuKeys(screen, 'Yes, I trust this folder')
    if (keys) return { name: 'trust', keys }
  }
  return null
}

export function looksLikePrompt(screen: string): boolean {
  return /Enter to confirm|Esc to cancel|\(y\/n\)/i.test(screen)
}

/**
 * Watch a freshly started tmux session until `isReady()` turns true, answering
 * known dialogs along the way. Resolves with the outcome.
 */
export async function shepherd(
  name: string,
  isReady: () => boolean,
  opts: { timeoutMs?: number; onDialog?: (d: Dialog) => void } = {},
): Promise<'ready' | 'exited' | 'stuck' | 'timeout'> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  let answered = 0
  while (Date.now() < deadline) {
    if (isReady()) return 'ready'
    if (!(await tmuxHasSession(name))) return isReady() ? 'ready' : 'exited'
    const screen = await capturePane(name)
    const d = detectDialog(screen)
    if (d && answered < 6) {
      answered++
      opts.onDialog?.(d)
      await sendKeys(name, d.keys)
      await Bun.sleep(1500)
      continue
    }
    await Bun.sleep(1000)
  }
  if (isReady()) return 'ready'
  if (!(await tmuxHasSession(name))) return 'exited'
  return looksLikePrompt(await capturePane(name)) ? 'stuck' : 'timeout'
}
