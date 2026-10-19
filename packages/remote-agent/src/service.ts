/**
 * Remote-agent service: the read-only projection over one DSH host.
 *
 * Route handling lives in `http.ts`; this module owns state, discovery, and
 * the workspace/session snapshots so the HTTP layer stays a thin transport.
 *
 * @module dsh-remote-agent/service
 */

import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  PROTOCOL_VERSION,
  RemoteProtocolError,
  type AcceptedResult,
  type RemoteApprovalRequest,
  type RemoteAssistantFrame,
  type CreateSessionRequest,
  type CreateSessionResult,
  type CreateWorkspaceRequest,
  type HostInfo,
  type ListSessionsResult,
  type PromptSessionRequest,
  type SelectModelRequest,
  type ListWorkspacesResult,
  type RemoteSessionSummary,
  type RemoteWorkspace,
  type SessionSnapshot,
  type SessionStreamFrame,
  type WebUrlResult,
} from '@dsh-remote/protocol'
import { isLoopbackAddress } from './auth.ts'
import {
  resolveConfig,
  resolveDshHome,
  type Config,
  type ResolvedConfig,
} from './config.ts'
import {
  findWorkspaceId,
  projectSession,
  projectWorkspaces,
  toWireEvent,
  type SessionHeaderLike,
  type WorkspaceLike,
} from './projection.ts'
import {
  openState,
  withListener,
  withStopped,
  writeState,
  type AgentState,
} from './state.ts'
import { AsyncQueue } from './queue.ts'
import { followLiveSession } from './stream.ts'
import { AGENT_VERSION, resolveDshVersion } from './version.ts'

/** One page size used when a backend cannot report its event count. */
const COLD_SCAN_PAGE = 500

/** Safety ceiling while scanning a cold log without event-count metadata. */
const COLD_SCAN_LIMIT = 100_000

interface PendingApproval {
  readonly request: RemoteApprovalRequest
  resolve(outcome: ApprovalOutcome): void
}

/** Service returned by the plugin and consumed by the HTTP adapter. */
export class RemoteAgentService {
  readonly ctx: Context
  readonly config: ResolvedConfig
  readonly token: string
  readonly startedAt: string
  readonly dshVersion: string

  #state: AgentState
  readonly #approvalEvents = new EventEmitter()
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  readonly #approvalScopes = new Map<string, () => void>()

  private constructor(ctx: Context, config: ResolvedConfig, state: AgentState, token: string, dshVersion: string) {
    this.ctx = ctx
    this.config = config
    this.#state = state
    this.token = token
    this.startedAt = state.startedAt
    this.dshVersion = dshVersion
  }

  /** Open or mint the token, then publish the listener endpoint into the state file. */
  static async create(ctx: Context, config: Config = {}): Promise<RemoteAgentService> {
    const resolved = resolveConfig(config)
    const dshVersion = resolveDshVersion()
    const opened = await openState(resolved.stateFile, resolved.token, {
      agentVersion: AGENT_VERSION,
      dshVersion,
    })
    const service = new RemoteAgentService(ctx, resolved, opened.state, opened.token, dshVersion)
    service.#bindApprovals()
    await service.#bindListener()
    ctx.logger.info(
      'dsh-remote-agent: listening on %s (state: %s)',
      service.#state.url ?? 'unknown',
      resolved.stateFile,
    )
    return service
  }

  /** Absolute path of the discovery/state file. */
  get stateFile(): string {
    return this.config.stateFile
  }

  /** Current state snapshot (tests and diagnostics). */
  get state(): AgentState {
    return this.#state
  }

  /** Whether a peer address is admitted by this composition. */
  admitsPeer(address: string | undefined): boolean {
    return !this.config.loopbackOnly || isLoopbackAddress(address)
  }

  /** Host identity and capability document. */
  hostInfo(hostId: string): HostInfo {
    return {
      hostId,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      dshVersion: this.dshVersion,
      agentVersion: AGENT_VERSION,
      home: resolveDshHome(),
      startedAt: this.startedAt,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [
        'health',
        'host.info',
        'workspace.list',
        'workspace.create',
        'session.list',
        'session.snapshot',
        'session.follow',
        'session.create',
        'session.prompt',
        'session.cancel',
        'approval.follow',
        'approval.answer',
        'web.url',
      ],
      workspaceCount: this.ctx.workspaceRegistry.list().length,
      modelBaseUrl: process.env.DEEPSEEK_BASE_URL ?? null,
      modelKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
      modelKeyFingerprint: process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === ''
        ? null
        : createHash('sha256').update(process.env.DEEPSEEK_API_KEY).digest('hex'),
    }
  }

  /** Project the workspace registry. */
  listWorkspaces(): ListWorkspacesResult {
    const workspaces = this.ctx.workspaceRegistry.list()
    return { workspaces: projectWorkspaces(workspaces.map(toWorkspaceLike)) }
  }

  /** List sessions in one workspace, or every visible session. */
  async listSessions(workspaceId?: string): Promise<ListSessionsResult> {
    const workspaces = this.ctx.workspaceRegistry.list()
    if (workspaceId !== undefined && !workspaces.some(workspace => String(workspace.id) === workspaceId)) {
      throw new RemoteProtocolError({
        code: 'workspace/not-found',
        message: `workspace ${workspaceId} is not registered on this host`,
        details: { workspaceId },
      })
    }

    const persisted = await this.#persistedBySession()
    const owner = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) owner.set(String(sessionId), String(workspace.id))
    }

    const summaries: RemoteSessionSummary[] = []
    const seen = new Set<string>()
    const add = (sessionId: string): void => {
      if (seen.has(sessionId)) return
      seen.add(sessionId)
      const sessionWorkspace = owner.get(sessionId) ?? null
      if (workspaceId !== undefined && sessionWorkspace !== workspaceId) return
      const live = this.ctx.sessions.get(sessionId as SessionId)
      const snapshot = persisted.get(sessionId)
      const header = live?.header ?? snapshot?.header
      if (header === undefined) return
      summaries.push(projectSession({
        header: toHeaderLike(header),
        live: live !== undefined,
        eventCount: live !== undefined ? live.seq : snapshot?.eventCount ?? null,
        workspaceId: sessionWorkspace,
      }))
    }

    for (const workspace of workspaces) {
      if (workspaceId !== undefined && String(workspace.id) !== workspaceId) continue
      for (const sessionId of workspace.sessionIds) add(String(sessionId))
    }
    if (workspaceId === undefined) {
      // Sessions persisted outside a workspace are still part of the host's
      // history; surface them as ungrouped rather than hiding them.
      for (const sessionId of persisted.keys()) add(sessionId)
    }

    summaries.sort((left, right) => {
      if (left.createdAt === right.createdAt) return left.sessionId.localeCompare(right.sessionId)
      return right.createdAt.localeCompare(left.createdAt)
    })
    return { sessions: summaries }
  }

  /** Register a remote workspace over the agent API. */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<RemoteWorkspace> {
    const path = request.path.trim()
    if (path === '') {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'workspace path must not be empty' })
    }
    const workspace = await this.ctx.workspaceRegistry.create(path, request.title)
    return projectWorkspaces([workspace as never])[0]!
  }

  /** Create a remote session in a workspace or directory. */
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'workspaceId and cwd are mutually exclusive',
      })
    }
    const created = await this.ctx.sessionController.create({
      ...request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId as WorkspaceId },
      ...request.cwd === undefined ? {} : { cwd: request.cwd },
      ...request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset },
    })
    return {
      sessionId: String(created.sessionId),
      ...created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset },
    }
  }

  /** Select and install the model/reasoning effort for one remote session. */
  async selectModel(sessionId: string, request: SelectModelRequest): Promise<AcceptedResult> {
    await this.ctx.sessionController.selectModel({
      sessionId: sessionId as SessionId,
      provider: request.provider,
      model: request.model,
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort as never },
    })
    return { accepted: true }
  }

  /** Set the file-effect sandbox mode for one remote session. */
  async setSandboxMode(
    sessionId: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  ): Promise<AcceptedResult> {
    const session = this.assertLiveSession(sessionId) as unknown as {
      append(type: string, data: unknown): unknown
    }
    session.append('sandbox/mode', { mode })
    return { accepted: true }
  }

  /** Send a prompt to one remote session. */
  async promptSession(sessionId: string, request: PromptSessionRequest): Promise<AcceptedResult> {
    const text = request.text.trim()
    const content = request.content === undefined || request.content.length === 0
      ? text === '' ? [] : [{ type: 'text' as const, text }]
      : request.content.map(part => part.type === 'image'
        ? {
            type: 'image' as const,
            data: part.data,
            mediaType: part.mediaType,
            ...part.name === undefined ? {} : { name: part.name },
          }
        : { type: 'text' as const, text: part.text })
    if (content.length === 0) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'prompt content must not be empty' })
    }
    if (request.provider !== undefined && request.model !== undefined) {
      await this.ctx.sessionController.selectModel({
        sessionId: sessionId as SessionId,
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort as never },
      })
    }
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as never,
      sessionId: sessionId as SessionId,
      mode: request.mode ?? 'queue',
      content: content as never,
    }, new AbortController().signal)
    return { accepted: true }
  }

  /** Pending approval questions, replayed when a follower connects. */
  approvalRequests(): RemoteApprovalRequest[] {
    return [...this.#pendingApprovals.values()].map(entry => entry.request)
  }

  /** Subscribe to new approval questions. */
  onApprovalRequest(listener: (request: RemoteApprovalRequest) => void): () => void {
    this.#approvalEvents.on('request', listener)
    return () => { this.#approvalEvents.off('request', listener) }
  }

  /** Answer one pending approval. */
  answerApproval(id: string, outcome: ApprovalOutcome): AcceptedResult {
    const pending = this.#pendingApprovals.get(id)
    if (pending === undefined) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: `approval ${id} is not pending` })
    }
    pending.resolve(outcome)
    return { accepted: true }
  }

  #bindApprovals(): void {
    this.ctx.effect(
      () => this.ctx.on('approval/request', async (request: ApprovalRequestEvent) => this.#askApproval(request)),
      'dsh-remote-agent: approval bridge',
    )
  }

  #askApproval(request: ApprovalRequestEvent): Promise<ApprovalOutcome> {
    const id = randomUUID()
    const projected: RemoteApprovalRequest = {
      id,
      sessionId: String(request.agent.id),
      toolName: request.toolName,
      ...request.callId === undefined ? {} : { callId: String(request.callId) },
      ...request.reason === undefined ? {} : { reason: request.reason },
      ...request.displayReason === undefined ? {} : { displayReason: request.displayReason },
    }
    return new Promise<ApprovalOutcome>(resolve => {
      let settled = false
      const finish = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        this.#pendingApprovals.delete(id)
        resolve(outcome)
      }
      const onAbort = (): void => { finish('cancelled') }
      const timer = setTimeout(() => { finish('unavailable') }, 10 * 60_000)
      if (request.signal?.aborted === true) {
        finish('cancelled')
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.#pendingApprovals.set(id, { request: projected, resolve: finish })
      this.#approvalEvents.emit('request', projected)
    })
  }

  /** Cancel the active turn of one remote session. */
  cancelSession(sessionId: string): AcceptedResult {
    this.ctx.sessionController.cancel({ sessionId: sessionId as SessionId })
    return { accepted: true }
  }

  /** Read the newest page of one session's event log. */
  async snapshotSession(hostId: string, sessionId: string, limit?: number): Promise<SessionSnapshot> {
    const bounded = Math.min(
      Math.max(limit ?? this.config.defaultSnapshotEvents, 1),
      this.config.maxSnapshotEvents,
    )
    const workspaceId = findWorkspaceId(
      this.ctx.workspaceRegistry.list().map(toWorkspaceLike),
      sessionId,
    )

    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live !== undefined) {
      const end = live.seq
      const from = Math.max(0, end - bounded)
      const events = live.snapshotEvents(from as SessionLogOffset, end as SessionLogOffset).map(toWireEvent)
      return {
        hostId,
        sessionId,
        cursor: end,
        live: true,
        workspaceId,
        cwd: live.header.cwd ?? null,
        events,
        truncated: from > 0,
      }
    }

    const snapshot = await this.ctx.sessionPersistence.stat(sessionId as SessionId)
    if (snapshot === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-found',
        message: `session ${sessionId} is not known on this host`,
        details: { sessionId },
      })
    }

    const handle = await this.ctx.sessionPersistence.open(sessionId as SessionId, 'read')
    try {
      if (snapshot.eventCount !== undefined) {
        const offset = Math.max(0, snapshot.eventCount - bounded)
        const page = await handle.read(offset, bounded)
        const events = page.events.map(toWireEvent)
        return {
          hostId,
          sessionId,
          cursor: events.length === 0 ? snapshot.eventCount : events[events.length - 1]!.seq + 1,
          live: false,
          workspaceId,
          cwd: snapshot.header.cwd ?? null,
          events,
          truncated: offset > 0,
        }
      }

      let offset = 0
      let total = 0
      let tail: SessionEvent[] = []
      for (;;) {
        const page = await handle.read(offset, COLD_SCAN_PAGE)
        if (page.events.length === 0) break
        total += page.events.length
        offset += page.events.length
        tail = [...tail, ...page.events]
        if (tail.length > bounded) tail = tail.slice(-bounded)
        if (total >= COLD_SCAN_LIMIT) {
          throw new RemoteProtocolError({
            code: 'request/too-large',
            message: `session ${sessionId} exceeds the no-metadata scan ceiling; use a persistence backend that reports eventCount`,
            details: { sessionId, scanned: total },
          })
        }
      }
      const events = tail.map(toWireEvent)
      return {
        hostId,
        sessionId,
        cursor: events.length === 0 ? total : events[events.length - 1]!.seq + 1,
        live: false,
        workspaceId,
        cwd: snapshot.header.cwd ?? null,
        events,
        truncated: total > events.length,
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Validate a follow request before the HTTP layer commits SSE headers.
   * @returns the live session to follow.
   */
  assertCanFollow(sessionId: string, cursor: number): Session {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'cursor must be a non-negative safe integer',
        details: { cursor },
      })
    }
    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} is not live on this host; resume is a Phase 2 capability`,
        details: { sessionId },
      })
    }
    if (cursor > live.seq) {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: `cursor ${cursor} is ahead of session end ${live.seq}`,
        details: { sessionId, cursor, end: live.seq },
      })
    }
    return live
  }

  /** Require one live Session without imposing a durable-event cursor. */
  assertLiveSession(sessionId: string): Session {
    const live = this.ctx.sessions.get(sessionId as SessionId)
    if (live === undefined) {
      throw new RemoteProtocolError({
        code: 'session/not-live',
        message: `session ${sessionId} is not live on this host`,
        details: { sessionId },
      })
    }
    return live
  }

  /** Follow dense process-local Assistant frames for one live Session. */
  async *followAssistantFrames(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteAssistantFrame> {
    this.assertLiveSession(sessionId)
    const queue = new AsyncQueue<RemoteAssistantFrame>(2_048)
    const onFrame = (payload: unknown): void => {
      const record = payload as { agent?: { session?: { id?: unknown } }; frame?: unknown }
      if (String(record.agent?.session?.id) !== sessionId) return
      if (record.frame !== undefined) {
        queue.push(record.frame as RemoteAssistantFrame)
      }
    }
    const onDisposed = (session: Session): void => {
      if (String(session.id) !== sessionId) return
      queue.close()
    }
    const offFrame = this.ctx.on('agent/assistant-stream' as never, onFrame as never, { global: true } as never)
    const offDisposed = this.ctx.on('session/disposed' as never, onDisposed as never, { global: true } as never)
    const onAbort = (): void => { queue.close() }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const frame of queue) {
        if (signal.aborted) break
        yield frame
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      offFrame()
      offDisposed()
      queue.close()
    }
  }

  /** Follow one live session; call {@link assertCanFollow} first. */
  followSession(
    hostId: string,
    sessionId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamFrame> {
    const live = this.assertCanFollow(sessionId, cursor)
    return followLiveSession(this.ctx, live, cursor, {
      hostId,
      heartbeatMs: this.config.heartbeatMs,
      signal,
    })
  }

  /** Browser-authenticated path of the remote DSH Web UI, relative to its origin. */
  webUrl(): WebUrlResult {
    try {
      const connection = this.ctx.get('connection') as
        | { authenticatedUrl?: (baseUrl: string) => string }
        | undefined
      if (connection?.authenticatedUrl === undefined) return { path: '/' }
      const url = new URL(connection.authenticatedUrl(this.ctx.webServer.getOrigin()))
      return { path: `${url.pathname}${url.search}` }
    } catch {
      return { path: '/' }
    }
  }

  /** Publish the final state and wait for it to reach disk. */
  async dispose(): Promise<void> {
    try {
      this.#state = withStopped(this.#state)
      await writeState(this.config.stateFile, this.#state)
    } catch (error) {
      this.ctx.logger.warn('dsh-remote-agent: failed to write stopped state: %s', String(error))
    }
  }

  async #bindListener(): Promise<void> {
    const port = this.ctx.webServer.port
    if (port === undefined) {
      throw new RemoteProtocolError({
        code: 'agent/not-ready',
        message: 'dsh-remote-agent requires an active web listener with a bound port',
      })
    }
    const url = this.ctx.webServer.getOrigin()
    this.#state = withListener(this.#state, { port, url })
    await writeState(this.config.stateFile, this.#state)
  }

  async #persistedBySession(): Promise<Map<string, SessionPersistenceSnapshot>> {
    try {
      const snapshots = await this.ctx.sessionPersistence.list()
      return new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot]))
    } catch (error) {
      this.ctx.logger.warn('dsh-remote-agent: session persistence list failed: %s', String(error))
      return new Map()
    }
  }
}

function toWorkspaceLike(workspace: Workspace): WorkspaceLike {
  return {
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds.map(String),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function toHeaderLike(header: SessionHeader): SessionHeaderLike {
  return {
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
  }
}

/** Re-exported for tests that exercise the cold path without a real host. */
export { COLD_SCAN_LIMIT }
export { takeTail } from './projection.ts'
