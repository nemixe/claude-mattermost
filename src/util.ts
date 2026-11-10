/**
 * Shared helpers for the hub and the per-session channel server.
 * chunk / safeName / assertSendable / PERMISSION_REPLY_RE / the .env loader
 * are ported from the official telegram channel plugin.
 */

import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

export const STATE_DIR = process.env.MATTERMOST_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'mattermost')

export const PATHS = {
  env: join(STATE_DIR, '.env'),
  access: join(STATE_DIR, 'access.json'),
  approved: join(STATE_DIR, 'approved'),
  inbox: join(STATE_DIR, 'inbox'),
  threads: join(STATE_DIR, 'threads.json'),
  workspaces: join(STATE_DIR, 'workspaces.json'),
  pendingWorkspaces: join(STATE_DIR, 'pending-workspaces.json'),
  sock: join(STATE_DIR, 'hub.sock'),
  lock: join(STATE_DIR, 'hub.lock'),
  hubInfo: join(STATE_DIR, 'hub.json'),
  hubEntry: join(STATE_DIR, 'hub-entry.json'),
  hubLog: join(STATE_DIR, 'hub.log'),
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
}

/** Load <state>/.env into process.env. Real env wins. */
export function loadEnvFile(): void {
  try {
    chmodSync(PATHS.env, 0o600)
    for (const line of readFileSync(PATHS.env, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
    }
  } catch {}
}

// Permission-reply spec (same as telegram): 5 lowercase letters a-z minus 'l'.
// Case-insensitive for phone autocorrect. No bare yes/no, no extra chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** Mattermost's default MaxPostSize is 16383 runes. Leave headroom. */
export const MAX_POST_CHARS = 16000
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_FILES_PER_POST = 10

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Filenames and display names are user-controlled and land inside the
 * <channel> tag attributes — strip delimiter chars so they can't break out
 * of the tag or forge another meta entry.
 */
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_')
}

/** Refuse to upload the channel's own state (token, access.json), except inbox downloads. */
export function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function readJson<T>(path: string, fallback: () => T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback()
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch {}
    log('state', `${path} is corrupt, moved aside`)
    return fallback()
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  ensureStateDir()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function log(scope: string, msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] mattermost ${scope}: ${msg}\n`)
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Compare dotted numeric versions. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
