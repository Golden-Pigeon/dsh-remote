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
  | 'workspace.create'
  | 'session.list'
  | 'session.snapshot'
  | 'session.follow'
  | 'session.create'
  | 'session.prompt'
  | 'session.cancel'
  | 'approval.follow'
  | 'approval.answer'
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
  /** Provider base URL configured for the remote DSH, without the key. */
  readonly modelBaseUrl?: string | null
  /** Whether a model API key is present in the remote process environment. */
  readonly modelKeyConfigured?: boolean
  /** SHA-256 of the configured model key, used only to detect drift; never the key itself. */
  readonly modelKeyFingerprint?: string | null
}

/** Closed approval outcomes understood by the remote and local approval seams. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One approval question raised by a remote tool call. */
export interface RemoteApprovalRequest {
  readonly id: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
}

/** Approval stream frame: ready, then one request per pending decision. */
export type RemoteApprovalFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'request'; readonly request: RemoteApprovalRequest }

/** One approval answer submitted to the remote agent. */
export interface RemoteApprovalAnswer {
  readonly id: string
  readonly outcome: ApprovalOutcome
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
  /** Surface placement, copied from the Host event for native transcript replay. */
  readonly surfaceOp?: 'append' | {
    readonly op: 'replace'
    readonly startSeq: number
    readonly endSeq: number
  }
  /** Earlier surface events cited by this message. */
  readonly sourceEventSeqs?: readonly number[]
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

/** Request to register a remote workspace. */
export interface CreateWorkspaceRequest {
  /** Absolute remote directory path. */
  readonly path: string
  /** Optional display title. */
  readonly title?: string
}

/** Request to create a remote session. */
export interface CreateSessionRequest {
  /** Existing remote workspace to join; exclusive with `cwd`. */
  readonly workspaceId?: string
  /** Directory for an ungrouped session; exclusive with `workspaceId`. */
  readonly cwd?: string
  /** Optional agent preset name. */
  readonly agentPreset?: string
}

/** Created or reused remote session. */
export interface CreateSessionResult {
  readonly sessionId: string
  readonly agentPreset?: string
}

/** Delivery mode for a remote prompt. */
export type PromptDeliveryMode = 'queue' | 'steer'

/** Request to send a text prompt to a remote session. */
export interface PromptSessionRequest {
  readonly text: string
  readonly mode?: PromptDeliveryMode
  /** Optional model selection to install on the remote session before prompting. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Accepted prompt/cancel receipt. */
export interface AcceptedResult {
  readonly accepted: true
}

/** Options accepted by `session.snapshot`. */
export interface SessionSnapshotOptions {
  /** Number of most-recent events to include. Defaults to 500; capped by the agent. */
  readonly limit?: number
}

/** Dense process-local Assistant stream frame forwarded by the remote agent. */
export interface RemoteAssistantFrame {
  readonly type: 'start' | 'chunk' | 'end'
  readonly attemptId: string
  readonly revision: number
  readonly turn?: number
  readonly step?: number
  readonly index?: number
  readonly time?: number
  readonly chunk?: unknown
  readonly outcome?:
    | { readonly kind: 'committed'; readonly eventType: string; readonly seq: number }
    | { readonly kind: 'abandoned' }
}

/** Validate a remote assistant frame without constraining its model chunk. */
export function isRemoteAssistantFrame(value: unknown): value is RemoteAssistantFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  if (frame.type !== 'start' && frame.type !== 'chunk' && frame.type !== 'end') return false
  if (typeof frame.attemptId !== 'string' || typeof frame.revision !== 'number') return false
  if (frame.type === 'start') {
    return typeof frame.turn === 'number' && typeof frame.step === 'number'
  }
  if (frame.type === 'chunk') {
    return typeof frame.index === 'number' && typeof frame.time === 'number' && 'chunk' in frame
  }
  if (typeof frame.index !== 'number') return false
  const outcome = frame.outcome
  if (typeof outcome !== 'object' || outcome === null) return false
  const kind = (outcome as Record<string, unknown>).kind
  if (kind === 'abandoned') return true
  if (kind !== 'committed') return false
  const record = outcome as Record<string, unknown>
  return typeof record.eventType === 'string' && typeof record.seq === 'number'
}
