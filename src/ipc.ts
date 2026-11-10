/**
 * Hub ⇄ channel-server protocol: newline-delimited JSON over a unix socket
 * at <state>/hub.sock (the state dir is 0700, so only this user can connect).
 */

export type HelloMsg = {
  t: 'hello'
  /** Thread to (re)bind; null = open a new thread in the home channel. */
  threadId: string | null
  cwd: string
  label: string
  pid: number
  /** pid of the owning claude process, if found — used to rebind after /reload-plugins. */
  claudePid?: number
  /** CLAUDE_CODE_SESSION_ID of the owning session — lets an ended thread be resumed. */
  sessionId?: string
  version: string
  /** Absolute path of this client's hub.ts — used when a newer client replaces the hub. */
  hubEntry: string
}

export type ClientMsg =
  | HelloMsg
  | { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }

export type HubMsg =
  | { t: 'bound'; threadId: string; channelId: string; note?: string }
  | { t: 'waiting'; reason: string }
  | { t: 'inbound'; content: string; meta: Record<string, string> }
  | { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'result'; id: number; ok: boolean; text?: string; error?: string }
  | { t: 'restart'; reason: string }

export function encode(msg: ClientMsg | HubMsg): string {
  return JSON.stringify(msg) + '\n'
}

/** Accumulates socket data and yields complete JSON lines. */
export class LineDecoder<T> {
  private buf = ''

  push(chunk: string | Buffer | Uint8Array): T[] {
    this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const out: T[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // malformed line — ignore
      }
    }
    return out
  }
}
