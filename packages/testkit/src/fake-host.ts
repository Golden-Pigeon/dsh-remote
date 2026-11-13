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
  type ApprovalOutcome,
  type HostInfo,
  type RemoteApprovalRequest,
  type RemoteSessionEvent,
  type RemoteTerminalFrame,
  type RemoteTerminalInfo,
  type RemoteTerminalInput,
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
  readonly createRequests: Array<{ workspaceId?: string; cwd?: string; agentPreset?: string }> = []
  readonly promptRequests: Array<{ sessionId: string; text: string; provider?: string; model?: string; reasoningEffort?: string; content?: unknown }> = []
  /** Approval answers accepted by this fake host, for end-to-end assertions. */
  readonly approvalAnswers: Array<{ id: string; outcome: ApprovalOutcome }> = []
  /** Fail the next session creation with an API error. */
  failNextCreate = false
  /** Fail the next accepted prompt with an API error. */
  failNextPrompt = false
  /** Fail one prompt whose text exactly matches this value. */
  failPromptText: string | undefined
  /** Terminals created through the agent API, for assertions. */
  readonly terminalCreates: Array<{ readonly id: string; readonly cwd: string; readonly title?: string; readonly shellPath?: string }> = []
  /** Input/resize commands accepted by the fake PTYs, for assertions. */
  readonly terminalInputs: Array<{ readonly id: string; readonly input: RemoteTerminalInput }> = []
  /** Terminals closed through the agent API, for assertions. */
  readonly terminalCloses: string[] = []

  readonly #protocolVersion: number
  readonly #fixtures: Fixtures
  readonly #holdStreamMs: number
  readonly #heartbeatMs: number
  readonly #sessions = new Map<string, FakeSession>()
  readonly #streams = new Map<string, ServerResponse[]>()
  readonly #approvals = new Map<string, RemoteApprovalRequest>()
  readonly #terminals = new Map<string, RemoteTerminalInfo>()
  readonly #terminalStreams = new Map<string, Set<ServerResponse>>()
  #terminalSequence = 0
  readonly #approvalStreams = new Set<ServerResponse>()
  readonly #approvalTimers = new Map<ServerResponse, NodeJS.Timeout>()
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

  /** Queue one approval request for the next/connected approval stream. */
  requestApproval(request: RemoteApprovalRequest): void {
    this.#approvals.set(request.id, request)
    for (const response of this.#approvalStreams) {
      writeApprovalFrame(response, { type: 'request', request })
    }
  }

  /** Stop the listener and close active streams. */
  async stop(): Promise<void> {
    for (const streams of this.#streams.values()) {
      for (const response of streams) response.end()
    }
    this.#streams.clear()
    for (const streams of this.#terminalStreams.values()) {
      for (const response of streams) response.end()
    }
    this.#terminalStreams.clear()
    for (const response of this.#approvalStreams) {
      const timer = this.#approvalTimers.get(response)
      if (timer !== undefined) clearInterval(timer)
      response.end()
    }
    this.#approvalStreams.clear()
    this.#approvalTimers.clear()
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

  /** Write one attachment frame to every live attachment of a fake terminal. */
  #writeTerminal(id: string, frame: RemoteTerminalFrame): void {
    for (const response of this.#terminalStreams.get(id) ?? []) {
      if (!response.writableEnded) response.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
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
      const route = matchAgentRoute(url.pathname)
      if (route === undefined) throw new RemoteProtocolError({ code: 'route/not-found', message: 'unknown route' })
      const hostId = firstHeader(req.headers[HEADER_HOST_ID]) ?? this.hostId

      if (req.method === 'POST') {
        const body = await readJson(req)
        switch (route.kind) {
          case 'workspaces': {
            const record = body as { path?: unknown; title?: unknown }
            if (typeof record.path !== 'string' || record.path.trim() === '') {
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'path is required' })
            }
            const workspaceId = `workspace-created-${this.#fixtures.workspaces.length + 1}`
            const workspace = {
              workspaceId,
              path: record.path,
              title: typeof record.title === 'string' && record.title !== '' ? record.title : record.path,
              sessionIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
            this.#fixtures.workspaces.push(workspace)
            sendJson(res, workspace)
            return
          }
          case 'sessions': {
            if (this.failNextCreate) {
              this.failNextCreate = false
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'forced create failure' })
            }
            const record = body as { workspaceId?: unknown; cwd?: unknown; agentPreset?: unknown }
            this.createRequests.push({
              ...typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {},
              ...typeof record.cwd === 'string' ? { cwd: record.cwd } : {},
              ...typeof record.agentPreset === 'string' ? { agentPreset: record.agentPreset } : {},
            })
            const sessionId = `session-created-${this.#sessions.size + 1}`
            const session: FakeSession = {
              sessionId,
              workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
              cwd: typeof record.cwd === 'string' ? record.cwd : null,
              createdAt: new Date().toISOString(),
              live: true,
              events: [],
            }
            this.#sessions.set(sessionId, session)
            sendJson(res, { sessionId, ...typeof record.agentPreset === 'string' ? { agentPreset: record.agentPreset } : {}})
            return
          }
          case 'session-archive': {
            const session = this.#sessions.get(route.sessionId)
            if (session !== undefined) this.#sessions.delete(route.sessionId)
            sendJson(res, { accepted: true })
            return
          }
          case 'session-prompt': {
            const record = body as { text?: unknown; provider?: unknown; model?: unknown; reasoningEffort?: unknown; content?: unknown }
            if (typeof record.text !== 'string' || record.text.trim() === '') {
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'text is required' })
            }
            if (this.failNextPrompt || this.failPromptText === record.text) {
              this.failNextPrompt = false
              this.failPromptText = undefined
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'forced prompt failure' })
            }
            const session = this.#getSession(route.sessionId)
            this.promptRequests.push({
              sessionId: route.sessionId,
              text: record.text,
              ...typeof record.provider === 'string' ? { provider: record.provider } : {},
              ...typeof record.model === 'string' ? { model: record.model } : {},
              ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
              ...record.content === undefined ? {} : { content: record.content },
            })
            const time = Date.now()
            const userSeq = session.events.length
            session.events.push({ seq: userSeq, type: 'user/message', time, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: record.text }], id: `msg-${userSeq}` } })
            const assistantSeq = session.events.length
            session.events.push({ seq: assistantSeq, type: 'assistant/message', time: time + 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${record.text}` }] } } })
            sendJson(res, { accepted: true })
            return
          }
          case 'session-cancel':
            this.#getSession(route.sessionId)
            sendJson(res, { accepted: true })
            return
          case 'approval-answer': {
            const record = body as { id?: unknown; outcome?: unknown }
            const outcomes: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
            if (typeof record.id !== 'string' || typeof record.outcome !== 'string' || !outcomes.includes(record.outcome as ApprovalOutcome)) {
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'approval id and outcome are required' })
            }
            if (!this.#approvals.has(record.id)) {
              throw new RemoteProtocolError({ code: 'request/invalid', message: `approval ${record.id} is not pending` })
            }
            this.#approvals.delete(record.id)
            this.approvalAnswers.push({ id: record.id, outcome: record.outcome as ApprovalOutcome })
            sendJson(res, { accepted: true })
            return
          }
          case 'terminals': {
            const record = body as { id?: unknown; cwd?: unknown; title?: unknown; shellPath?: unknown; cols?: unknown; rows?: unknown }
            const id = typeof record.id === 'string' && record.id !== '' ? record.id : `terminal-${this.#terminals.size + 1}`
            const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : '/home/tester'
            const title = typeof record.title === 'string' && record.title !== '' ? record.title : 'Remote terminal'
            const info: RemoteTerminalInfo = {
              id,
              title,
              cwd,
              shell: { path: typeof record.shellPath === 'string' ? record.shellPath : '/bin/bash', name: 'bash', args: [] },
              cols: typeof record.cols === 'number' ? record.cols : 80,
              rows: typeof record.rows === 'number' ? record.rows : 24,
              state: 'running',
              exitCode: null,
            }
            this.#terminals.set(id, info)
            this.terminalCreates.push({
              id,
              cwd,
              title,
              ...typeof record.shellPath === 'string' ? { shellPath: record.shellPath } : {},
            })
            sendJson(res, info)
            return
          }
          case 'terminal-input': {
            const input = body as RemoteTerminalInput
            if (input.type !== 'write' && input.type !== 'resize') {
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'terminal input must be write or resize' })
            }
            this.terminalInputs.push({ id: route.terminalId, input })
            if (input.type === 'write') {
              this.#terminalSequence += 1
              this.#writeTerminal(route.terminalId, { type: 'output', sequence: this.#terminalSequence, data: input.data })
            }
            sendJson(res, { accepted: true })
            return
          }
          case 'terminal-rename': {
            const info = this.#terminals.get(route.terminalId)
            if (info === undefined) throw new RemoteProtocolError({ code: 'request/invalid', message: 'unknown terminal' })
            const title = (body as { title?: unknown }).title
            if (typeof title !== 'string' || title.trim() === '') {
              throw new RemoteProtocolError({ code: 'request/invalid', message: 'title is required' })
            }
            this.#terminals.set(route.terminalId, { ...info, title })
            sendJson(res, { accepted: true })
            return
          }
          case 'terminal-close': {
            this.terminalCloses.push(route.terminalId)
            this.#terminals.delete(route.terminalId)
            for (const response of this.#terminalStreams.get(route.terminalId) ?? []) response.end()
            this.#terminalStreams.delete(route.terminalId)
            sendJson(res, { accepted: true })
            return
          }
          default:
            throw new RemoteProtocolError({ code: 'request/invalid', message: 'POST is not supported here', httpStatus: 405 })
        }
      }
      if (req.method !== 'GET') {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'unsupported method', httpStatus: 405 })
      }

      switch (route.kind) {
        case 'health':
        case 'host':
          sendJson(res, { ...this.#fixtures.hostInfo, hostId })
          return
        case 'workspaces':
          sendJson(res, { workspaces: this.#fixtures.workspaces })
          return
        case 'directory-list': {
          const requested = url.searchParams.get('path') ?? '~'
          const base = requested === '~' ? '/home/tester' : requested.replace(/\/+$/u, '')
          sendJson(res, {
            path: base,
            parent: base === '/home/tester' ? '/home' : '/home/tester',
            entries: base === '/home/tester'
              ? [{ name: 'project', path: '/home/tester/project' }]
              : [],
            truncated: false,
          })
          return
        }
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
        case 'approval-events':
          this.#streamApprovals(req, res)
          return
        case 'web-url':
          sendJson(res, { path: '/?token=fake-browser-token' })
          return
        case 'terminals':
          sendJson(res, { terminals: [...this.#terminals.values()] })
          return
        case 'terminal-attach': {
          const info = this.#terminals.get(route.terminalId)
          if (info === undefined) throw new RemoteProtocolError({ code: 'request/invalid', message: 'unknown terminal' })
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
          })
          res.write('retry: 5000\n\n')
          const snapshot: RemoteTerminalFrame = { type: 'snapshot', sequence: 0, screen: '', info, writable: true }
          res.write(`event: frame\ndata: ${JSON.stringify(snapshot)}\n\n`)
          const streams = this.#terminalStreams.get(route.terminalId) ?? new Set<ServerResponse>()
          streams.add(res)
          this.#terminalStreams.set(route.terminalId, streams)
          const cleanup = (): void => {
            streams.delete(res)
            if (streams.size === 0) this.#terminalStreams.delete(route.terminalId)
          }
          req.on('close', cleanup)
          res.on('close', cleanup)
          return
        }
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

  #streamApprovals(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 5000\n\n')
    writeApprovalFrame(res, { type: 'ready' })
    for (const request of this.#approvals.values()) writeApprovalFrame(res, { type: 'request', request })
    this.#approvalStreams.add(res)
    const cleanup = (): void => {
      const timer = this.#approvalTimers.get(res)
      if (timer !== undefined) clearInterval(timer)
      this.#approvalTimers.delete(res)
      this.#approvalStreams.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write('event: heartbeat\ndata: {}\n\n')
    }, this.#heartbeatMs)
    heartbeat.unref?.()
    this.#approvalTimers.set(res, heartbeat)
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeFrame(res: ServerResponse, frame: SessionStreamFrame): void {
  if (res.writableEnded) return
  res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
}

function writeApprovalFrame(res: ServerResponse, frame: { readonly type: 'ready' } | { readonly type: 'request'; readonly request: RemoteApprovalRequest }): void {
  if (res.writableEnded) return
  res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
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
