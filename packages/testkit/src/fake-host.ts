/**
 * In-memory remote agent used by contract tests and plugin development.
 *
 * It implements the same wire contract as `dsh-remote-agent` without DSH,
 * SSH, or a real session store. Every response is a protocol envelope; the
 * session route can stream SSE and accept appended events.
 *
 * @module @dsh-remote/testkit/fake-host
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AGENT_ROUTES,
  HEADER_AGENT_VERSION,
  HEADER_HOST_ID,
  HEADER_PROTOCOL_VERSION,
  HEADER_REQUEST_ID,
  HEADER_SERVER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RemoteProtocolError,
  httpStatusForCode,
  matchAgentRoute,
  parseCursorQuery,
  parseProtocolHeader,
  type ApiFailure,
  type ApiSuccess,
  type HostInfo,
  type RemoteSessionEvent,
  type SessionSnapshot,
  type SessionStreamFrame,
} from '@dsh-remote/protocol'
import { createFixtures, summarize, type FakeSession, type Fixtures } from './fixtures.ts'

/** Options accepted by the fake host. */
export interface FakeHostOptions {
  readonly token?: string
  readonly hostId?: string
  /** Advertise a different protocol revision (for mismatch tests). */
  readonly protocolVersion?: number
  readonly fixtures?: Fixtures
  /** Keep SSE open and emit heartbeats; zero ends after replay. */
  readonly holdStreamMs?: number
  readonly heartbeatMs?: number
}

/** One observed request, for assertions. */
export interface FakeRequest {
  readonly method: string
  readonly path: string
}

/** Started fake host. */
export interface FakeHostAddress {
  readonly baseUrl: string
  readonly port: number
}

/** In-memory agent. */
export class FakeRemoteHost {
  readonly token: string
  readonly hostId: string
  readonly requests: FakeRequest[] = []

  readonly #protocolVersion: number
  readonly #fixtures: Fixtures
  readonly #holdStreamMs: number
  readonly #heartbeatMs: number
  readonly #sessions = new Map<string, FakeSession>()
  readonly #streams = new Map<string, ServerResponse[]>()
  #server: Server | undefined

  constructor(options: FakeHostOptions = {}) {
    this.token = options.token ?? 'test-token-0123456789'
    this.hostId = options.hostId ?? 'fake-host'
    this.#protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
    this.#fixtures = options.fixtures ?? createFixtures(this.hostId)
    this.#holdStreamMs = options.holdStreamMs ?? 0
    this.#heartbeatMs = options.heartbeatMs ?? 1_000
    for (const session of this.#fixtures.sessions) this.#sessions.set(session.sessionId, session)
  }

  /** Start on an ephemeral loopback port. */
  async start(): Promise<FakeHostAddress> {
    if (this.#server !== undefined) throw new Error('fake host already started')
    const server = createServer((req, res) => {
      void this.#handle(req, res)
    })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port }
  }

  /** Stop the listener and close active streams. */
  async stop(): Promise<void> {
    for (const streams of this.#streams.values()) {
      for (const response of streams) response.end()
    }
    this.#streams.clear()
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }

  /** Append one event and push it to matching live streams. */
  appendEvent(sessionId: string, event: RemoteSessionEvent): void {
    const session = this.#sessions.get(sessionId)
    if (session === undefined) throw new Error(`unknown fake session ${sessionId}`)
    session.events.push(event)
    for (const response of this.#streams.get(sessionId) ?? []) {
      writeFrame(response, {
        type: 'event',
        cursor: event.seq + 1,
        event,
      })
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname })
    res.setHeader(HEADER_SERVER_PROTOCOL_VERSION, String(this.#protocolVersion))
    res.setHeader(HEADER_AGENT_VERSION, '0.1.0')
    res.setHeader(HEADER_REQUEST_ID, 'fake-request')
    res.setHeader('cache-control', 'no-store')

    try {
      const presented = parseBearer(req.headers.authorization)
      if (presented === undefined) throw new RemoteProtocolError({ code: 'auth/missing', message: 'missing bearer token' })
      if (presented !== this.token) throw new RemoteProtocolError({ code: 'auth/invalid', message: 'invalid bearer token' })
      const version = parseProtocolHeader(firstHeader(req.headers[HEADER_PROTOCOL_VERSION]))
      if (version !== PROTOCOL_VERSION) {
        throw new RemoteProtocolError({
          code: 'protocol/version-mismatch',
          message: `client protocol ${String(version)} is unsupported`,
          details: { clientVersion: version ?? null, serverVersion: PROTOCOL_VERSION, supported: [PROTOCOL_VERSION] },
          httpStatus: 409,
        })
      }
      if (this.#protocolVersion !== PROTOCOL_VERSION) {
        throw new RemoteProtocolError({
          code: 'protocol/version-mismatch',
          message: 'fake host advertises an incompatible revision',
          httpStatus: 409,
        })
      }
      if (req.method !== 'GET') {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'only GET', httpStatus: 405 })
      }

      const route = matchAgentRoute(url.pathname)
      if (route === undefined) throw new RemoteProtocolError({ code: 'route/not-found', message: 'unknown route' })
      const hostId = firstHeader(req.headers[HEADER_HOST_ID]) ?? this.hostId

      switch (route.kind) {
        case 'health':
        case 'host':
          sendJson(res, { ...this.#fixtures.hostInfo, hostId })
          return
        case 'workspaces':
          sendJson(res, { workspaces: this.#fixtures.workspaces })
          return
        case 'sessions': {
          const sessions = [...this.#sessions.values()].map(summarize)
          sendJson(res, { sessions })
          return
        }
        case 'workspace-sessions': {
          if (!this.#fixtures.workspaces.some(workspace => workspace.workspaceId === route.workspaceId)) {
            throw new RemoteProtocolError({ code: 'workspace/not-found', message: 'unknown workspace' })
          }
          const sessions = [...this.#sessions.values()]
            .filter(session => session.workspaceId === route.workspaceId)
            .map(summarize)
          sendJson(res, { sessions })
          return
        }
        case 'session': {
          const session = this.#getSession(route.sessionId)
          const limit = parseLimit(url.searchParams.get('limit'), 500)
          const start = Math.max(0, session.events.length - limit)
          const events = session.events.slice(start)
          const snapshot: SessionSnapshot = {
            hostId,
            sessionId: session.sessionId,
            cursor: session.events.length,
            live: session.live,
            workspaceId: session.workspaceId,
            cwd: session.cwd,
            events,
            truncated: start > 0,
          }
          sendJson(res, snapshot)
          return
        }
        case 'session-events':
          this.#stream(req, res, route.sessionId, url.searchParams.get('cursor'))
          return
        case 'web-url':
          sendJson(res, { path: '/?token=fake-browser-token' })
          return
      }
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof RemoteProtocolError) {
        const body: ApiFailure = {
          ok: false,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          error: error.toFailure(),
        }
        res.statusCode = httpStatusForCode(error.code)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
        return
      }
      const body: ApiFailure = {
        ok: false,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        error: { code: 'internal', message: String(error), retryable: false },
      }
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
  }

  #stream(req: IncomingMessage, res: ServerResponse, sessionId: string, rawCursor: string | null): void {
    const session = this.#getSession(sessionId)
    let cursor: number
    try {
      cursor = parseCursorQuery(rawCursor, 0)
    } catch (error) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: error instanceof Error ? error.message : 'invalid cursor',
      })
    }
    if (cursor > session.events.length) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'cursor is past the event log' })
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`retry: 5000\n\n`)
    writeFrame(res, {
      type: 'ready',
      hostId: this.hostId,
      sessionId,
      cursor,
      live: session.live,
    } satisfies SessionStreamFrame)
    for (const event of session.events.slice(cursor)) {
      writeFrame(res, { type: 'event', cursor: event.seq + 1, event })
    }

    const streams = this.#streams.get(sessionId) ?? []
    streams.push(res)
    this.#streams.set(sessionId, streams)
    const cleanup = (): void => {
      const current = this.#streams.get(sessionId)
      if (current === undefined) return
      const index = current.indexOf(res)
      if (index >= 0) current.splice(index, 1)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)

    if (this.#holdStreamMs <= 0) {
      res.end()
      cleanup()
      return
    }
    const heartbeat = setInterval(() => {
      writeFrame(res, {
        type: 'heartbeat',
        cursor: session.events.length,
        time: Date.now(),
      })
    }, this.#heartbeatMs)
    heartbeat.unref?.()
    const timer = setTimeout(() => {
      clearInterval(heartbeat)
      res.end()
      cleanup()
    }, this.#holdStreamMs)
    timer.unref?.()
    res.on('close', () => {
      clearInterval(heartbeat)
      clearTimeout(timer)
    })
  }

  #getSession(sessionId: string): FakeSession {
    const session = this.#sessions.get(sessionId)
    if (session === undefined) throw new RemoteProtocolError({ code: 'session/not-found', message: 'unknown session' })
    return session
  }
}

function parseBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (value === undefined) return undefined
  return /^Bearer[ \t]+(.+)$/iu.exec(value.trim())?.[1]?.trim()
}

function sendJson(res: ServerResponse, data: unknown): void {
  const body: ApiSuccess<unknown> = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    data,
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function writeFrame(res: ServerResponse, frame: SessionStreamFrame): void {
  if (res.writableEnded) return
  res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
}

function parseLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/u.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 2_000) : fallback
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Convenience: start a fake host and return both handle and address. */
export async function startFakeHost(options: FakeHostOptions = {}): Promise<{
  host: FakeRemoteHost
  baseUrl: string
  port: number
}> {
  const host = new FakeRemoteHost(options)
  const address = await host.start()
  return { host, ...address }
}

export type { HostInfo }
