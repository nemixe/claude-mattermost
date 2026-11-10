/**
 * Minimal Mattermost API v4 client: REST over fetch, events over Bun's native
 * WebSocket. Only what the hub needs.
 */

import { basename } from 'path'
import { errMsg, log } from './util'

export type MMFileInfo = {
  id: string
  name: string
  extension?: string
  size: number
  mime_type?: string
}

export type MMPost = {
  id: string
  create_at: number
  update_at?: number
  user_id: string
  channel_id: string
  root_id: string
  message: string
  type?: string
  file_ids?: string[]
  metadata?: { files?: MMFileInfo[] }
}

export type MMUser = { id: string; username: string; first_name?: string; last_name?: string; is_bot?: boolean }
export type MMChannel = { id: string; type: string; name: string; display_name: string; team_id: string }
export type MMReaction = { user_id: string; post_id: string; emoji_name: string; create_at: number }

export type MMEvent =
  | { kind: 'posted'; post: MMPost; channelType: string }
  | { kind: 'reaction_added'; reaction: MMReaction }

export class MattermostError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export class Mattermost {
  readonly baseUrl: string
  private users = new Map<string, MMUser>()
  private ws: WebSocket | null = null
  private wsSeq = 1
  private stopped = false

  constructor(baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, init)
    if (!res.ok) {
      let detail = res.statusText
      try {
        const j = (await res.json()) as { message?: string }
        if (j.message) detail = j.message
      } catch {}
      throw new MattermostError(res.status, `${method} ${path} → HTTP ${res.status}: ${detail}`)
    }
    return res
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body)
    return (await res.json()) as T
  }

  me(): Promise<MMUser> {
    return this.json('GET', '/users/me')
  }

  async user(id: string): Promise<MMUser> {
    const cached = this.users.get(id)
    if (cached) return cached
    const u = await this.json<MMUser>('GET', `/users/${encodeURIComponent(id)}`)
    this.users.set(id, u)
    return u
  }

  async username(id: string): Promise<string> {
    try {
      return (await this.user(id)).username
    } catch {
      return id
    }
  }

  channel(id: string): Promise<MMChannel> {
    return this.json('GET', `/channels/${encodeURIComponent(id)}`)
  }

  directChannel(a: string, b: string): Promise<MMChannel> {
    return this.json('POST', '/channels/direct', [a, b])
  }

  createPost(p: { channel_id: string; message: string; root_id?: string; file_ids?: string[] }): Promise<MMPost> {
    return this.json('POST', '/posts', p)
  }

  getPost(id: string): Promise<MMPost> {
    return this.json('GET', `/posts/${encodeURIComponent(id)}`)
  }

  patchPost(id: string, message: string): Promise<MMPost> {
    return this.json('PUT', `/posts/${encodeURIComponent(id)}/patch`, { message })
  }

  getThread(rootId: string): Promise<{ order: string[]; posts: Record<string, MMPost> }> {
    return this.json('GET', `/posts/${encodeURIComponent(rootId)}/thread`)
  }

  addReaction(userId: string, postId: string, emojiName: string): Promise<unknown> {
    return this.json('POST', '/reactions', { user_id: userId, post_id: postId, emoji_name: emojiName })
  }

  async uploadFiles(channelId: string, paths: string[]): Promise<MMFileInfo[]> {
    const form = new FormData()
    form.append('channel_id', channelId)
    for (const p of paths) form.append('files', Bun.file(p), basename(p))
    const res = await this.json<{ file_infos: MMFileInfo[] }>('POST', '/files', form)
    return res.file_infos
  }

  fileInfo(id: string): Promise<MMFileInfo> {
    return this.json('GET', `/files/${encodeURIComponent(id)}/info`)
  }

  async downloadFile(id: string): Promise<ArrayBuffer> {
    const res = await this.request('GET', `/files/${encodeURIComponent(id)}`)
    return res.arrayBuffer()
  }

  permalink(postId: string): string {
    return `${this.baseUrl}/_redirect/pl/${postId}`
  }

  /** Typing indicator inside a thread (lasts a few seconds). Fire-and-forget. */
  typing(channelId: string, parentId: string): void {
    this.wsSend('user_typing', { channel_id: channelId, parent_id: parentId })
  }

  private wsSend(action: string, data: Record<string, unknown>): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ seq: this.wsSeq++, action, data }))
      }
    } catch {}
  }

  /**
   * Connect the event WebSocket and keep it connected (backoff up to 15s).
   * `onReconnect` fires after every successful re-authentication except the first.
   */
  listen(handlers: { onEvent: (ev: MMEvent) => void; onReconnect?: () => void }): void {
    const wsUrl = this.baseUrl.replace(/^http/i, 'ws') + '/api/v4/websocket'
    let attempt = 0
    let everConnected = false

    const connect = () => {
      if (this.stopped) return
      let lastFrame = Date.now()
      let authed = false
      const ws = new WebSocket(wsUrl)
      this.ws = ws

      const ping = setInterval(() => {
        if (Date.now() - lastFrame > 90_000) {
          log('ws', 'no frames for 90s — reconnecting')
          try { ws.close() } catch {}
          return
        }
        this.wsSend('ping', {})
      }, 30_000)

      ws.onopen = () => {
        this.wsSeq = 1
        ws.send(JSON.stringify({ seq: this.wsSeq++, action: 'authentication_challenge', data: { token: this.token } }))
      }

      ws.onmessage = ev => {
        lastFrame = Date.now()
        let msg: { event?: string; data?: Record<string, unknown>; status?: string; seq_reply?: number }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.event === 'hello') {
          authed = true
          attempt = 0
          log('ws', 'connected')
          if (everConnected) handlers.onReconnect?.()
          everConnected = true
          return
        }
        if (!msg.event || !msg.data) return
        try {
          if (msg.event === 'posted') {
            const post = JSON.parse(String(msg.data.post)) as MMPost
            handlers.onEvent({ kind: 'posted', post, channelType: String(msg.data.channel_type ?? '') })
          } else if (msg.event === 'reaction_added') {
            const reaction = JSON.parse(String(msg.data.reaction)) as MMReaction
            handlers.onEvent({ kind: 'reaction_added', reaction })
          }
        } catch (err) {
          log('ws', `bad ${msg.event} payload: ${errMsg(err)}`)
        }
      }

      ws.onerror = () => {
        // onclose follows; reconnect happens there.
      }

      ws.onclose = ev => {
        clearInterval(ping)
        if (this.stopped) return
        attempt++
        const delay = Math.min(1000 * attempt, 15_000)
        log('ws', `closed (${ev.code}${authed ? '' : ', before auth'}) — retrying in ${delay / 1000}s`)
        setTimeout(connect, delay)
      }
    }

    connect()
  }

  stop(): void {
    this.stopped = true
    try { this.ws?.close() } catch {}
  }
}
