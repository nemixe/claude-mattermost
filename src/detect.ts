/**
 * Is this MCP server running inside a Claude Code session that loaded the
 * mattermost channel? Plugin MCP servers start in every session, so without
 * this check every plain `claude` would open a thread.
 */

import { execFileSync } from 'child_process'
import { basename } from 'path'

const CHANNEL_FLAGS = new Set(['--channels', '--dangerously-load-development-channels'])

export function isClaudeArgs(args: string): boolean {
  const argv0 = args.trim().split(/\s+/)[0] ?? ''
  return basename(argv0) === 'claude' || args.includes('@anthropic-ai/claude-code') || /\/claude-code\/cli/.test(args)
}

/** Does the argv list `name` as a channel (either flag, space- or =-separated, variadic)? */
export function channelsInclude(args: string, name: string): boolean {
  const toks = args.trim().split(/\s+/)
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!
    const eq = tok.indexOf('=')
    if (eq > 0 && CHANNEL_FLAGS.has(tok.slice(0, eq))) {
      if (tok.slice(eq + 1).split(',').some(v => v.includes(name))) return true
      continue
    }
    if (!CHANNEL_FLAGS.has(tok)) continue
    for (let j = i + 1; j < toks.length && !toks[j]!.startsWith('-'); j++) {
      if (toks[j]!.split(',').some(v => v.includes(name))) return true
    }
  }
  return false
}

export function parsePsLine(line: string): { ppid: number; args: string } | null {
  const m = /^\s*(\d+)\s+(.*)$/.exec(line)
  if (!m) return null
  return { ppid: parseInt(m[1]!, 10), args: m[2]!.trim() }
}

/** Walk up the process tree to the owning `claude` process. */
export function findClaudeAncestor(startPid = process.ppid, maxDepth = 10): { pid: number; args: string } | null {
  let pid = startPid
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    let out: string
    try {
      out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
    const row = parsePsLine(out.split('\n')[0] ?? '')
    if (!row) return null
    if (isClaudeArgs(row.args)) return { pid, args: row.args }
    pid = row.ppid
  }
  return null
}
