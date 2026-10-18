/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context } from '@deepseek-ai/cordis'
import { ClientTerminals } from '@deepseek-ai/dsh-api-terminal-controller/client'

export const inject = ['remote', 'remote.terminal', 'connection']
const ROUTE = '/api/dsh-remote-terminal'

interface Handle extends AsyncIterable<unknown> {
  send(item: unknown): void
  end(): void
  dispose(): void
}

export function apply(ctx: Context): void {
  const original = (ctx.remote as any).terminal
  const routed = route(original)
  new ClientTerminals(ctx as any, routed)
}

function route(original: any): any {
  const mirrored = new Map<string, Promise<boolean>>()
  const isMirror = (sessionId: string): Promise<boolean> => {
    let pending = mirrored.get(sessionId)
    if (pending === undefined) {
      pending = post({ action: 'context', sessionId })
        .then(value => (value as { mirrored?: boolean } | undefined)?.mirrored === true)
        .catch(() => false)
      mirrored.set(sessionId, pending)
    }
    return pending
  }
  const unary = (name: string) => async (...args: any[]) => {
    const sessionId = String(args[0])
    if (!await isMirror(sessionId)) return original[name](...args)
    const value = await post({ action: name, sessionId, ...payload(name, args) })
    if (value === undefined) throw new Error('remote terminal is unavailable; refusing to fall back to the local terminal')
    return { ok: true, value }
  }
  return {
    ...original,
    environment: unary('environment'),
    shells: unary('shells'),
    list: unary('list'),
    create: unary('create'),
    rename: unary('rename'),
    close: unary('close'),
    retain: (sessionId: string, id: string, signal: AbortSignal) => {
      const local = original.retain(sessionId, id, signal)
      return (async function* () {
        if (await isMirror(sessionId)) {
          yield { type: 'retained' }
          return
        }
        yield* local
      })()
    },
    attach: (sessionId: string, id: string, signal: AbortSignal) => new RoutedHandle(original, sessionId, id, signal, isMirror),
  }
}

function payload(name: string, args: any[]): Record<string, unknown> {
  if (name === 'create') {
    const request = args[1] ?? {}
    return { id: request.id, cols: request.cols, rows: request.rows, shellPath: request.shellPath }
  }
  if (name === 'rename') return { id: args[1], title: args[2] }
  if (name === 'close') return { id: args[1] }
  return {}
}

async function post(payload: Record<string, unknown>): Promise<any> {
  const response = await fetch(ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) return undefined
  const body = await response.json() as { ok?: boolean; value?: unknown; mirrored?: boolean }
  if (body.mirrored !== undefined) return body
  return body.ok === true ? body.value : undefined
}

class RoutedHandle implements Handle {
  #original: any
  #sessionId: string
  #id: string
  #signal: AbortSignal
  #isMirror: (sessionId: string) => Promise<boolean>
  #handle: Handle | undefined
  #pending: unknown[] = []
  #controller = new AbortController()
  #opening: Promise<Handle> | undefined

  constructor(original: any, sessionId: string, id: string, signal: AbortSignal, isMirror: (sessionId: string) => Promise<boolean>) {
    this.#original = original
    this.#sessionId = sessionId
    this.#id = id
    this.#signal = signal
    this.#isMirror = isMirror
    signal.addEventListener('abort', () => this.#controller.abort(), { once: true })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    const handle = await this.#open()
    yield* handle
  }

  send(item: unknown): void {
    if (this.#handle !== undefined) this.#handle.send(item)
    else this.#pending.push(item)
  }

  end(): void { this.#handle?.end() }

  dispose(): void {
    this.#controller.abort()
    this.#handle?.dispose()
  }

  async #open(): Promise<Handle> {
    if (this.#handle !== undefined) return this.#handle
    this.#opening ??= (async () => {
      const remote = await this.#isMirror(this.#sessionId)
      const handle: Handle = remote
        ? remoteHandle(this.#sessionId, this.#id, this.#controller.signal)
        : this.#original.attach(this.#sessionId, this.#id, this.#signal)
      this.#handle = handle
      for (const item of this.#pending.splice(0)) handle.send(item)
      return handle
    })()
    return this.#opening
  }
}

function remoteHandle(sessionId: string, id: string, signal: AbortSignal): Handle {
  let controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  return {
    async *[Symbol.asyncIterator]() {
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ action: 'attach', sessionId, id }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('remote terminal attach failed')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/u, '')
            buffer = buffer.slice(newline + 1)
            if (line.startsWith('data: ')) {
              const parsed = JSON.parse(line.slice(6).trim())
              if (parsed.message !== undefined && parsed.type === undefined) throw new Error(parsed.message)
              yield parsed
            }
            newline = buffer.indexOf('\n')
          }
          if (done) return
        }
      } finally {
        reader.releaseLock()
      }
    },
    send(item: unknown) {
      const input = item as { type?: string; data?: string; cols?: number; rows?: number; sequence?: number }
      void post(input.type === 'write'
        ? { action: 'input', sessionId, id, data: input.data ?? '', sequence: input.sequence ?? 0 }
        : { action: 'resize', sessionId, id, cols: input.cols ?? 80, rows: input.rows ?? 24, sequence: input.sequence ?? 0 })
    },
    end() {},
    dispose() { controller.abort() },
  }
}
