/**
 * Wire value shapes. Everything here is JSON-safe and free of DSH imports so
 * the same declarations can be consumed by the host plugin, the installer,
 * tests, and (type-only) the browser bundle.
 *
 * @module @dsh-remote/protocol/types
 */

/** JSON primitive. */
export type JsonPrimitive = string | number | boolean | null

/** JSON value accepted by the wire protocol. */
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

/** Capability names advertised by an agent during health negotiation. */
export type AgentCapability =
  | 'health'
  | 'host.info'
  | 'workspace.list'
  | 'session.list'
  | 'session.snapshot'
  | 'session.follow'
  | 'web.url'

/** Identity and environment of the remote DSH host serving the agent API. */
export interface HostInfo {
  /** Logical host id supplied by the local registry; falls back to a local slug. */
  readonly hostId: string
  /** Remote hostname (`os.hostname()`). */
  readonly hostname: string
  /** Node platform, for example `linux` or `darwin`. */
  readonly platform: string
  /** Node architecture, for example `arm64`. */
  readonly arch: string
  /** DSH runtime version known to the agent. */
  readonly dshVersion: string
  /** Remote agent package version. */
  readonly agentVersion: string
  /** Agent home directory used for state and diagnostics. */
  readonly home: string
  /** ISO-8601 instant at which the agent plugin started. */
  readonly startedAt: string
  /** Protocol revision advertised by this agent. */
  readonly protocolVersion: number
  /** Capability set the client may rely on. */
  readonly capabilities: readonly AgentCapability[]
  /** Number of registered remote workspaces at the instant of the call. */
  readonly workspaceCount: number
}

/** One workspace projected from `ctx.workspaceRegistry`. */
export interface RemoteWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** One session summary projected from the live store or session persistence. */
export interface RemoteSessionSummary {
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly cwd: string | null
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** True when the session is live in the remote process. */
  readonly live: boolean
  /** Persisted logical event count when cheaply available. */
  readonly eventCount: number | null
}

/** One persisted DSH session event, reduced to its JSON-safe frame fields. */
export interface RemoteSessionEvent {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: JsonValue
}

/** Snapshot returned before a live event stream is opened. */
export interface SessionSnapshot {
  readonly hostId: string
  readonly sessionId: string
  /** Next sequence number the client should expect. */
  readonly cursor: number
  readonly live: boolean
  readonly workspaceId: string | null
  readonly cwd: string | null
  readonly events: readonly RemoteSessionEvent[]
  /** True when older events were omitted to respect the request limit. */
  readonly truncated: boolean
}

/** Reason a session stream ended. */
export type SessionStreamEndReason =
  | 'session-closed'
  | 'server-shutdown'
  | 'client-abort'
  | 'error'

/** Frame streamed over SSE by `session.follow`. */
export type SessionStreamFrame =
  | {
    readonly type: 'ready'
    readonly hostId: string
    readonly sessionId: string
    readonly cursor: number
    readonly live: boolean
  }
  | {
    readonly type: 'event'
    readonly cursor: number
    readonly event: RemoteSessionEvent
  }
  | {
    readonly type: 'heartbeat'
    readonly cursor: number
    readonly time: number
  }
  | {
    readonly type: 'end'
    readonly cursor: number
    readonly reason: SessionStreamEndReason
  }

/** Result of `workspace.list`. */
export interface ListWorkspacesResult {
  readonly workspaces: readonly RemoteWorkspace[]
}

/** Result of `session.list`. */
export interface ListSessionsResult {
  readonly sessions: readonly RemoteSessionSummary[]
}

/**
 * A relative URL that authenticates a browser against the remote DSH Web UI.
 * The local plugin rewrites its port to the tunnel's local port.
 */
export interface WebUrlResult {
  readonly path: string
}

/** Successful response envelope. */
export interface ApiSuccess<T> {
  readonly ok: true
  readonly protocolVersion: number
  readonly serverTime: string
  readonly data: T
}

/** Machine-readable failure body. */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: JsonValue
}

/** Failed response envelope. */
export interface ApiFailure {
  readonly ok: false
  readonly protocolVersion: number
  readonly serverTime: string
  readonly error: RemoteFailure
}

/** Every JSON response from the agent uses one of these envelopes. */
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure

/** Options accepted by `session.snapshot`. */
export interface SessionSnapshotOptions {
  /** Number of most-recent events to include. Defaults to 500; capped by the agent. */
  readonly limit?: number
}
