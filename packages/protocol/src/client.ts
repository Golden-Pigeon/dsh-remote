/**
 * Typed HTTP client for the remote agent API.
 *
 * This is transport, not policy: it validates envelopes and protocol
 * version, surfaces stable error codes, and offers a streaming session
 * follower. Reconnection, backoff, host lookup, and credential storage live
 * in the local plugin's service layer.
 *
 * @module @dsh-remote/protocol/client
 */

import { EventCursor } from './cursor.ts'
import { RemoteProtocolError } from './errors.ts'
import {
  sessionAssistantEventsPath,
  sessionCancelPath,
  sessionEventsPath,
  sessionPath,
  sessionPromptPath,
  workspaceSessionsPath,
  AGENT_ROUTES,
} from './routes.ts'
import { parseSseStream } from './sse.ts'
import { isRemoteAssistantFrame } from './types.ts'
import type {
  AcceptedResult,
  ApprovalOutcome,
  RemoteApprovalFrame,
  RemoteAssistantFrame,
  CreateSessionRequest,
  CreateSessionResult,
  CreateWorkspaceRequest,
  HostInfo,
  ListSessionsResult,
  ListWorkspacesResult,
  RemoteSessionEvent,
  RemoteSessionSummary,
  PromptSessionRequest,
  RemoteWorkspace,
  SessionSnapshot,
  SessionSnapshotOptions,
  SessionStreamFrame,
  WebUrlResult,
} from './types.ts'
import {
  isAcceptedResult,
  isRemoteApprovalFrame,
  isApiFailure,
  isCreateSessionResult,
  isHostInfoValue,
  isListSessionsResult,
  isListWorkspacesResult,
  isRemoteWorkspace,
  isSessionSnapshot,
  isSessionStreamFrame,
  isWebUrlResult,
} from './validation.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEADER_HOST_ID,
  HEADER_PROTOCOL_VERSION,
  HEADER_SERVER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  isProtocolSupported,
} from './version.ts'

/** Options accepted by {@link RemoteAgentClient}. */
export interface RemoteAgentClientOptions {
  /** Agent origin, for example `http://127.0.0.1:41234`. */
  readonly baseUrl: string
  /** Bearer token read from the remote agent's private state file. */
  readonly token: string
  /** Logical host id echoed to the agent for diagnostics and future ACLs. */
  readonly hostId?: string
  /** Per-request timeout for non-streaming calls. */
  readonly timeoutMs?: number
  /** Injection point for tests and alternate transports. */
  readonly fetchImpl?: typeof fetch
}

/** Envelope guard type. */
type Guard<T> = (value: unknown) => value is T

/** Strip a trailing slash and reject an unparsable base URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`remote agent base URL must be http(s), got ${url.protocol}`)
  }
  return url.origin
}

/** Reject non-loopback URLs; the local plugin only talks to an SSH tunnel. */
export function assertLoopbackBaseUrl(baseUrl: string): void {
  const host = new URL(baseUrl).hostname
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (normalized !== '127.0.0.1' && normalized !== 'localhost' && normalized !== '::1') {
    throw new TypeError(`remote agent URL must target loopback, got ${host}`)
  }
}

/** Combine an optional caller signal with a timeout for one fetch. */
function fetchWithTimeout(
  input: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  const signal = callerSignal === undefined
    ? timeout.signal
    : AbortSignal.any([callerSignal, timeout.signal])
  return fetchImpl(input, { ...init, signal }).finally(() => clearTimeout(timer))
}

/** Targeted client for one remote host. */
export class RemoteAgentClient {
  readonly baseUrl: string
  readonly hostId: string | undefined

  readonly #token: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: RemoteAgentClientOptions) {
    if (options.token.trim() === '') throw new TypeError('remote agent token must not be empty')
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.hostId = options.hostId
    this.#token = options.token
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#fetch = options.fetchImpl ?? globalThis.fetch
  }

  /** Fetch and validate the agent health document. */
  health(): Promise<HostInfo> {
    return this.#request(AGENT_ROUTES.health, isHostInfoValue)
  }

  /** Alias for `health`, named after the protocol capability. */
  hostInfo(): Promise<HostInfo> {
    return this.#request(AGENT_ROUTES.host, isHostInfoValue)
  }

  /** List workspaces visible on the remote host. */
  async listWorkspaces(): Promise<readonly RemoteWorkspace[]> {
    const result = await this.#request(AGENT_ROUTES.workspaces, isListWorkspacesResult)
    return result.workspaces
  }

  /** List sessions, optionally scoped to one remote workspace. */
  async listSessions(workspaceId?: string): Promise<readonly RemoteSessionSummary[]> {
    const path = workspaceId === undefined ? AGENT_ROUTES.sessions : workspaceSessionsPath(workspaceId)
    const result: ListSessionsResult = await this.#request(path, isListSessionsResult)
    return result.sessions
  }

  /** Read the newest page of a session's event log. */
  snapshotSession(sessionId: string, options: SessionSnapshotOptions = {}): Promise<SessionSnapshot> {
    const suffix = options.limit === undefined ? '' : `?limit=${encodeURIComponent(String(options.limit))}`
    return this.#request(`${sessionPath(sessionId)}${suffix}`, isSessionSnapshot)
  }

  /** Register a remote workspace over the agent API. */
  createWorkspace(request: CreateWorkspaceRequest): Promise<RemoteWorkspace> {
    return this.#request(AGENT_ROUTES.workspaces, isRemoteWorkspace, { method: 'POST', body: request })
  }

  /** Create a remote session in a workspace or directory. */
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.#request(AGENT_ROUTES.sessions, isCreateSessionResult, {
      method: 'POST',
      body: request,
    })
  }

  /** Send a text prompt to a remote session. */
  async promptSession(sessionId: string, request: PromptSessionRequest): Promise<void> {
    await this.#request(sessionPromptPath(sessionId), isAcceptedResult, {
      method: 'POST',
      body: request,
    })
  }

  /** Cancel a remote session's active turn. */
  async cancelSession(sessionId: string): Promise<void> {
    await this.#request(sessionCancelPath(sessionId), isAcceptedResult, {
      method: 'POST',
      body: {},
    })
  }

  /** Follow the remote approval question stream. */
  async *followApprovals(signal: AbortSignal): AsyncGenerator<RemoteApprovalFrame> {
    const response = await this.#openStream(AGENT_ROUTES.approvalEvents, signal)
    const body = response.body
    if (body === null) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'remote agent returned an empty approval stream' })
    }
    for await (const message of parseSseStream(body)) {
      if (message.data === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(message.data)
      } catch (error) {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'remote agent sent malformed approval JSON', cause: error })
      }
      if (!isRemoteApprovalFrame(frame)) {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'remote agent sent an unknown approval frame' })
      }
      yield frame
    }
  }

  /** Answer one pending remote approval. */
  answerApproval(id: string, outcome: ApprovalOutcome): Promise<AcceptedResult> {
    return this.#request(AGENT_ROUTES.approvalAnswer, isAcceptedResult, {
      method: 'POST',
      body: { id, outcome },
    })
  }

  /** Fetch a browser-authenticated path for the remote Web UI. */
  webUrl(): Promise<WebUrlResult> {
    return this.#request(AGENT_ROUTES.webUrl, isWebUrlResult)
  }

  /**
   * Follow one session's live events from `cursor`.
   *
   * The caller owns reconnection. If the stream drops mid-turn the caller
   * should request a fresh snapshot and resume from its cursor.
   */
  async *followSession(
    sessionId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncGenerator<SessionStreamFrame> {
    const response = await this.#openStream(sessionEventsPath(sessionId, cursor), signal)
    const body = response.body
    if (body === null) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'remote agent returned an empty event stream',
      })
    }

    for await (const message of parseSseStream(body)) {
      if (message.data === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(message.data)
      } catch (error) {
        throw new RemoteProtocolError({
          code: 'request/invalid',
          message: 'remote agent sent malformed event JSON',
          cause: error,
        })
      }
      if (!isSessionStreamFrame(frame)) {
        throw new RemoteProtocolError({
          code: 'request/invalid',
          message: 'remote agent sent an unknown event frame',
        })
      }
      yield frame
    }
  }

  /** Follow one session's dense process-local Assistant frames. */
  async *followAssistantFrames(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteAssistantFrame> {
    const response = await this.#openStream(sessionAssistantEventsPath(sessionId), signal)
    const body = response.body
    if (body === null) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'remote agent returned an empty assistant stream',
      })
    }
    for await (const message of parseSseStream(body)) {
      if (message.data === '') continue
      let frame: unknown
      try {
        frame = JSON.parse(message.data)
      } catch (error) {
        throw new RemoteProtocolError({
          code: 'request/invalid',
          message: 'remote agent sent malformed assistant JSON',
          cause: error,
        })
      }
      if (!isRemoteAssistantFrame(frame)) {
        throw new RemoteProtocolError({
          code: 'request/invalid',
          message: 'remote agent sent an unknown assistant frame',
        })
      }
      yield frame
    }
  }

  /** Validate an event sequence against a cursor. */
  static guardEvent(cursor: EventCursor, event: RemoteSessionEvent): 'applied' | 'duplicate' | 'gap' {
    return cursor.accept(event)
  }

  async #openStream(path: string, signal: AbortSignal): Promise<Response> {
    const headers = this.#headers()
    headers.set('accept', 'text/event-stream')
    const response = await this.#fetch(`${this.baseUrl}${path}`, { headers, signal })
    if (!response.ok) await this.#throwResponseError(response)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('text/event-stream')) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: `remote agent returned ${JSON.stringify(contentType)} instead of text/event-stream`,
      })
    }
    return response
  }

  async #request<T>(
    path: string,
    guard: Guard<T>,
    init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
  ): Promise<T> {
    const headers = this.#headers()
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: init.method ?? 'GET',
        headers,
        redirect: 'error',
        ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
      },
      this.#fetch,
      this.#timeoutMs,
      undefined,
    )
    if (!response.ok) await this.#throwResponseError(response)

    const envelope: unknown = await response.json().catch((error: unknown) => {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'remote agent returned invalid JSON',
        cause: error,
      })
    })

    if (isApiFailure(envelope)) {
      throw new RemoteProtocolError({
        code: isCode(envelope.error.code) ? envelope.error.code : 'internal',
        message: envelope.error.message,
        retryable: envelope.error.retryable,
        details: isDetails(envelope.error.details) ? envelope.error.details : undefined,
      })
    }

    if (!isRecord(envelope) || envelope.ok !== true) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'remote agent returned an unrecognized envelope',
      })
    }

    const serverVersion = typeof envelope.protocolVersion === 'number'
      ? envelope.protocolVersion
      : Number(response.headers.get(HEADER_SERVER_PROTOCOL_VERSION))
    if (!isProtocolSupported(serverVersion)) {
      throw new RemoteProtocolError({
        code: 'protocol/version-mismatch',
        message: `remote agent speaks protocol ${String(serverVersion)}, this client speaks ${PROTOCOL_VERSION}`,
        details: { clientVersion: PROTOCOL_VERSION, serverVersion },
      })
    }

    if (!guard(envelope.data)) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'remote agent returned an unexpected response shape',
      })
    }
    return envelope.data
  }

  async #throwResponseError(response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => undefined)
    if (isApiFailure(body)) {
      throw new RemoteProtocolError({
        code: isCode(body.error.code) ? body.error.code : 'internal',
        message: body.error.message,
        retryable: body.error.retryable,
        details: isDetails(body.error.details) ? body.error.details : undefined,
        httpStatus: response.status,
      })
    }
    throw new RemoteProtocolError({
      code: response.status === 401 ? 'auth/invalid' : 'internal',
      message: `remote agent request failed with HTTP ${response.status}`,
      httpStatus: response.status,
    })
  }

  #headers(): Headers {
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
      [HEADER_PROTOCOL_VERSION]: String(PROTOCOL_VERSION),
    })
    if (this.hostId !== undefined) headers.set(HEADER_HOST_ID, this.hostId)
    return headers
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDetails(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

const KNOWN_CODES = new Set([
  'protocol/version-mismatch', 'auth/missing', 'auth/invalid', 'auth/forbidden',
  'request/invalid', 'request/too-large', 'route/not-found', 'workspace/not-found',
  'session/not-found', 'session/not-live', 'agent/not-ready', 'internal',
])

function isCode(value: string): value is import('./errors.ts').ProtocolErrorCode {
  return KNOWN_CODES.has(value)
}

export { isApiFailure }
