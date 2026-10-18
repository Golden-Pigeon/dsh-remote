/**
 * Session-routing terminal provider used inside the forked ClientTerminals
 * construction. Local Sessions call the stock remote face; mirrored Sessions
 * call the local plugin's SSH terminal route.
 */
const TERMINAL_ROUTE = '/api/dsh-remote-terminal'

function applyRouted(ctx) {
  const original = ctx.remote.terminal
  const routed = routeTerminal(original)
  new ClientTerminals(ctx, routed)
}

function routeTerminal(original) {
  const mirrored = new Map()
  const isMirror = sessionId => {
    let pending = mirrored.get(sessionId)
    if (pending === undefined) {
      pending = terminalPost({ action: 'context', sessionId })
        .then(value => value?.mirrored === true)
        .catch(() => false)
      mirrored.set(sessionId, pending)
    }
    return pending
  }
  const unary = name => async (...args) => {
    const sessionId = String(args[0])
    if (!await isMirror(sessionId)) return original[name](...args)
    const value = await terminalPost({ action: name, sessionId, ...terminalPayload(name, args) })
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
    retain: (sessionId, id, signal) => (async function* () {
      if (await isMirror(sessionId)) {
        yield { type: 'retained' }
        return
      }
      yield* original.retain(sessionId, id, signal)
    })(),
    attach: (sessionId, id, signal) => new RoutedTerminalHandle(original, sessionId, id, signal, isMirror),
  }
}

function terminalPayload(name, args) {
  if (name === 'create') {
    const request = args[1] ?? {}
    return { id: request.id, cols: request.cols, rows: request.rows, shellPath: request.shellPath }
  }
  if (name === 'rename') return { id: args[1], title: args[2] }
  if (name === 'close') return { id: args[1] }
  return {}
}

async function terminalPost(payload) {
  const response = await fetch(TERMINAL_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) return undefined
  const body = await response.json()
  if (body.mirrored !== undefined) return body
  return body.ok === true ? body.value : undefined
}

class RoutedTerminalHandle {
  #original
  #sessionId
  #id
  #signal
  #isMirror
  #handle
  #pending = []
  #controller = new AbortController()
  #opening

  constructor(original, sessionId, id, signal, isMirror) {
    this.#original = original
    this.#sessionId = sessionId
    this.#id = id
    this.#signal = signal
    this.#isMirror = isMirror
    signal.addEventListener('abort', () => this.#controller.abort(), { once: true })
  }

  async *[Symbol.asyncIterator]() {
    const handle = await this.#open()
    yield* handle
  }

  send(item) {
    if (this.#handle !== undefined) this.#handle.send(item)
    else this.#pending.push(item)
  }

  end() { this.#handle?.end() }

  dispose() {
    this.#controller.abort()
    this.#handle?.dispose()
  }

  async #open() {
    if (this.#handle !== undefined) return this.#handle
    this.#opening ??= (async () => {
      const remote = await this.#isMirror(this.#sessionId)
      const handle = remote
        ? remoteTerminalHandle(this.#sessionId, this.#id, this.#controller.signal)
        : this.#original.attach(this.#sessionId, this.#id, this.#signal)
      this.#handle = handle
      for (const item of this.#pending.splice(0)) handle.send(item)
      return handle
    })()
    return this.#opening
  }
}

function remoteTerminalHandle(sessionId, id, signal) {
  let controller = new AbortController()
  signal.addEventListener('abort', () => controller.abort(), { once: true })
  return {
    async *[Symbol.asyncIterator]() {
      const response = await fetch(TERMINAL_ROUTE, {
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
    send(item) {
      if (item.type === 'write') void terminalPost({ action: 'input', sessionId, id, data: item.data ?? '', sequence: item.sequence ?? 0 })
      else void terminalPost({ action: 'resize', sessionId, id, cols: item.cols ?? 80, rows: item.rows ?? 24, sequence: item.sequence ?? 0 })
    },
    end() {},
    dispose() { controller.abort() },
  }
}
