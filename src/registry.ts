/**
 * threads.json  — every thread the hub has bound to a session (live or ended).
 * workspaces.json — channelId → workspace folder name under spawn.baseDir.
 *
 * The hub is the only writer of threads.json. workspaces.json is also edited
 * by the /mattermost:sessions skill, so it is re-read on every access.
 */

import { PATHS, readJson, writeJsonAtomic } from './util'

export type ThreadRecord = {
  channelId: string
  origin: 'spawned' | 'manual'
  cwd?: string
  label?: string
  workspace?: string
  /** Claude Code session id (known for spawned sessions → --resume). */
  claudeSessionId?: string
  /** tmux session name for spawned sessions. */
  tmux?: string
  /** pid of the claude process (terminal sessions) — lets /reload-plugins rebind. */
  claudePid?: number
  createdAt: number
  lastBoundAt?: number
  endedAt?: number
}

export class Registry {
  threads: Record<string, ThreadRecord>

  constructor() {
    this.threads = readJson<Record<string, ThreadRecord>>(PATHS.threads, () => ({}))
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.threads[threadId]
  }

  upsert(threadId: string, patch: Partial<ThreadRecord> & { channelId: string; origin: ThreadRecord['origin'] }): ThreadRecord {
    const prev = this.threads[threadId]
    const next: ThreadRecord = { ...prev, ...patch, createdAt: prev?.createdAt ?? patch.createdAt ?? Date.now() }
    this.threads[threadId] = next
    this.save()
    return next
  }

  patch(threadId: string, patch: Partial<ThreadRecord>): void {
    const prev = this.threads[threadId]
    if (!prev) return
    this.threads[threadId] = { ...prev, ...patch }
    this.save()
  }

  /** Most recent thread created by the given claude process that isn't ended. */
  findByClaudePid(pid: number): string | undefined {
    let best: [string, ThreadRecord] | undefined
    for (const entry of Object.entries(this.threads)) {
      const [, r] = entry
      if (r.claudePid !== pid) continue
      if (!best || (r.lastBoundAt ?? r.createdAt) > (best[1].lastBoundAt ?? best[1].createdAt)) best = entry
    }
    return best?.[0]
  }

  save(): void {
    writeJsonAtomic(PATHS.threads, this.threads)
  }

  static workspaces(): Record<string, string> {
    return readJson<Record<string, string>>(PATHS.workspaces, () => ({}))
  }

  static setWorkspace(channelId: string, name: string): void {
    const ws = Registry.workspaces()
    ws[channelId] = name
    writeJsonAtomic(PATHS.workspaces, ws)
  }
}
