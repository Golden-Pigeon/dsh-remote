/**
 * Native remote-session mirror.
 *
 * A remote DSH session is replayed into a local Session and registered with a
 * custom Agent. The existing local client therefore lists it beside local
 * workspaces and renders it with the ordinary Conversation UI, while prompts
 * and cancellation are routed back to the remote agent.
 *
 * This is a mirror, not a second agent loop: the local Session is a durable
 * projection of the remote log, and the remote DSH remains the execution owner.
 *
 * @module dsh-remote-local/mirror
 */

import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  ApprovalOutcome,
  RemoteApprovalRequest,
  RemoteAssistantFrame,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
  PromptDeliveryMode,
} from '@dsh-remote/protocol'
import type { ResolvedConfig } from '../config.ts'
import { isTestHidden, loadTestVisibility, type TestVisibility } from './test-visibility.ts'
import type { HostView } from '../hosts/types.ts'
import type { RemoteHostsService } from '../service.ts'

const MIRROR_VERSION = 1
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

interface MirrorRecord {
  readonly hostId: string
  readonly remoteSessionId: string
  localSessionId: string
  readonly remoteWorkspaceId: string | null
  readonly anchor: string
  lastSeq: number
  updatedAt: string
}

interface WorkspaceRecord {
  readonly hostId: string
  readonly remoteWorkspaceId: string | null
  localWorkspaceId: string
  readonly anchor: string
  readonly remoteRoot?: string
  readonly title: string
  readonly updatedAt: string
}

interface MirrorState {
  readonly version: number
  sessions: Record<string, MirrorRecord>
  workspaces: Record<string, WorkspaceRecord>
  /** Mirror keys hidden by the test-only manifest; used to restore on unhide. */
  testHidden: string[]
}

interface MirrorRuntime {
  readonly record: MirrorRecord
  readonly agent: MirrorAgent
  readonly session: Session
  timer: NodeJS.Timeout | undefined
  stream: AbortController | undefined
  assistant: AbortController | undefined
  remoteToLocalSeq: Map<number, number>
  pendingAssistantEnds: Map<number, RemoteAssistantFrame>
  latestTurn: number
  awaitingTurn: number | null
  running: boolean
  stopped: boolean
  lastError: string | null
  pendingUsers: unknown[]
  waiters: Array<() => void>
}

interface MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: { provider: string; model: string; reasoningEffort?: string }
  readonly ctx: Context
  readonly inbox: Record<string, unknown[]>
  readonly status: 'idle' | 'running'
  cancel(cause?: unknown): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: unknown, target?: unknown, wakeup?: boolean): void
  followup(message: unknown): void
  steer(message: unknown): void
  inject(message: unknown): void
}

/** One custom Agent façade backed by the remote agent's session. */
class RemoteMirrorAgent implements MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: MirrorAgent['options']
  readonly ctx: Context
  readonly inbox = { 'next-turn': [], 'next-step': [], nextTurn: [], nextStep: [] }
  #runtime: MirrorRuntime
  #mirror: RemoteMirrorService

  constructor(mirror: RemoteMirrorService, runtime: MirrorRuntime, ctx: Context, options: MirrorAgent['options']) {
    this.#mirror = mirror
    this.#runtime = runtime
    this.id = runtime.session.id
    this.session = runtime.session
    this.ctx = ctx
    this.options = options
  }

  get status(): 'idle' | 'running' {
    return this.#runtime.running ? 'running' : 'idle'
  }

  cancel(): void {
    this.#mirror.cancel(this.#runtime)
  }

  whenIdle(): Promise<void> {
    if (!this.#runtime.running) return Promise.resolve()
    return new Promise(resolve => { this.#runtime.waiters.push(resolve) })
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(message: unknown, _target?: unknown, wakeup = false): void {
    if (wakeup) this.followup(message)
    else this.#mirror.prompt(this.#runtime, message, 'queue')
  }

  followup(message: unknown): void {
    this.#mirror.prompt(this.#runtime, message, 'queue')
  }

  steer(message: unknown): void {
    this.#mirror.prompt(this.#runtime, message, 'steer')
  }

  inject(): void {
    // Remote context injection is not part of the mirror protocol yet.
  }
}

/** Mirror remote sessions into local Sessions and custom Agents. */
export class RemoteMirrorService {
  get #sessions(): Context['sessions'] {
    const value = this.#ctx.get('sessions')
    if (value === undefined) throw new Error('dsh-remote-local: sessions service is unavailable')
    return value
  }

  get #workspaceRegistry(): Context['workspaceRegistry'] {
    const value = this.#ctx.get('workspaceRegistry')
    if (value === undefined) throw new Error('dsh-remote-local: workspaceRegistry service is unavailable')
    return value
  }

  get #agents(): Context['agents'] {
    const value = this.#ctx.get('agents')
    if (value === undefined) throw new Error('dsh-remote-local: agents service is unavailable')
    return value
  }

  #ctx: Context
  #hosts: RemoteHostsService
  #config: ResolvedConfig
  #state: MirrorState = { version: MIRROR_VERSION, sessions: {}, workspaces: {}, testHidden: [] }
  #testVisibility: TestVisibility = { hiddenPaths: [], hiddenWorkspaceIds: [] }
  #runtimes = new Map<string, MirrorRuntime>()
  #registrations = new Map<string, () => void>()
  #approvalStreams = new Map<string, AbortController>()
  #syncing = false
  #saveQueue: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | undefined
  #disposed = false

  constructor(ctx: Context, hosts: RemoteHostsService, config: ResolvedConfig) {
    this.#ctx = ctx
    this.#hosts = hosts
    this.#config = config
  }

  /** Load mappings and begin periodic discovery. */
  async start(): Promise<void> {
    await this.#load()
    if (!this.#config.mirrorSessions) return
    // Catalog reconciliation is much less urgent than event delivery.
    this.#timer = setInterval(() => { void this.sync() }, Math.max(5_000, this.#config.mirrorPollMs * 4))
    await this.sync()
  }

  /** Stop mirrors and timers. */
  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    for (const runtime of this.#runtimes.values()) {
      runtime.stopped = true
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      runtime.stream?.abort()
      runtime.assistant?.abort()
    }
    for (const dispose of this.#registrations.values()) dispose()
    this.#registrations.clear()
    for (const controller of this.#approvalStreams.values()) controller.abort()
    this.#approvalStreams.clear()
    this.#runtimes.clear()
    await this.#save()
  }

  /** Reconcile connected hosts with the local workspace/session catalog. */
  async sync(): Promise<void> {
    if (this.#disposed || this.#syncing) return
    this.#syncing = true
    try {
      this.#testVisibility = await loadTestVisibility(this.#config.stateDir)
      for (const host of this.#hosts.list()) {
        if (host.phase !== 'connected') continue
        try {
          await this.#syncHost(host)
        } catch (error) {
          this.#ctx.logger.warn('dsh-remote-local: mirror sync for %s failed: %s', host.id, String(error))
        }
      }
    } finally {
      this.#syncing = false
    }
  }

  /** Resolve a local workspace anchor to its remote filesystem context. */
  remoteFileContext(workspaceRoot: string): { hostId: string; remoteRoot: string; anchor: string } | undefined {
    const root = canonicalPath(workspaceRoot)
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.remoteRoot === undefined) continue
      const anchor = canonicalPath(record.anchor)
      if (root === anchor || root.startsWith(`${anchor}/`)) {
        return { hostId: record.hostId, remoteRoot: record.remoteRoot, anchor }
      }
    }
    return undefined
  }

  /** Whether the test-only manifest excludes this remote workspace from UI listings. */
  isTestHidden(remoteWorkspaceId: string, remotePath: string): boolean {
    return isTestHidden(remotePath, remoteWorkspaceId, this.#testVisibility)
  }

  /** Find the local mirror workspace for one remote workspace. */
  localWorkspaceId(hostId: string, remoteWorkspaceId: string): string | undefined {
    return this.#state.workspaces[key(hostId, remoteWorkspaceId)]?.localWorkspaceId
  }

  /** Find the local mirror for one remote session. */
  localSessionId(hostId: string, remoteSessionId: string): string | undefined {
    return this.#state.sessions[key(hostId, remoteSessionId)]?.localSessionId
  }

  /** Create a mirror on demand and return its local session id. */
  async ensureRemoteSession(hostId: string, remoteSessionId: string): Promise<string | undefined> {
    const host = this.#hosts.list().find(item => item.id === hostId)
    if (host === undefined || host.phase !== 'connected') return undefined
    const existing = this.localSessionId(hostId, remoteSessionId)
    if (existing !== undefined && this.#sessions.get(existing as SessionId) !== undefined) return existing
    const workspaces = await this.#hosts.workspaces(hostId)
    for (const workspace of workspaces) {
      if (isTestHidden(workspace.path, workspace.workspaceId, this.#testVisibility)) continue
      const sessions = await this.#hosts.sessions(hostId, workspace.workspaceId)
      const summary = sessions.sessions.find(item => item.sessionId === remoteSessionId)
      if (summary === undefined) continue
      const localWorkspace = await this.#ensureWorkspace(host, workspace)
      const record = await this.#ensureMirror(host, summary, localWorkspace, workspace.path)
      return record?.localSessionId
    }
    const all = await this.#hosts.sessions(hostId)
    const summary = all.sessions.find(item => item.sessionId === remoteSessionId)
    if (summary === undefined) return undefined
    if (summary.cwd !== null && isTestHidden(summary.cwd, '', this.#testVisibility)) return undefined
    const localWorkspace = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
    return (await this.#ensureMirror(host, summary, localWorkspace.workspace, localWorkspace.anchor))?.localSessionId
  }

  /** Route one prompt from the local Agent façade to the remote session. */
  prompt(runtime: MirrorRuntime, message: unknown, mode: PromptDeliveryMode): void {
    const text = contentText(message)
    if (text === '') return
    runtime.pendingUsers.push(message)
    if (!runtime.running) runtime.awaitingTurn = runtime.latestTurn + 1
    this.#setRunning(runtime, true)
    if (runtime.stopped || runtime.timer === undefined) {
      runtime.stopped = false
      runtime.lastError = null
      this.#schedule(runtime)
    }
    const selection = this.#selectionFor(runtime)
    if (selection !== undefined) Object.assign(runtime.agent.options, selection)
    void this.#hosts.promptSession(
      runtime.record.hostId,
      runtime.record.remoteSessionId,
      text,
      mode,
      selection,
    ).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      runtime.pendingUsers.shift()
      this.#ctx.logger.warn('dsh-remote-local: remote prompt failed: %s', runtime.lastError)
      this.#setRunning(runtime, false)
    })
  }

  /** Route cancellation to the remote session only after the remote accepts it. */
  cancel(runtime: MirrorRuntime): void {
    void this.#hosts.cancelSession(runtime.record.hostId, runtime.record.remoteSessionId).then(() => {
      runtime.awaitingTurn = null
      this.#setRunning(runtime, false)
    }).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn('dsh-remote-local: remote cancel failed: %s', runtime.lastError)
      // Keep the local Agent running so the UI can offer Stop again.
      this.#setRunning(runtime, true)
    })
  }

  #selectionFor(runtime: MirrorRuntime): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const state = projections?.stateOf?.(runtime.session, 'modelSelection') as
      | { pending?: unknown; lastUsed?: unknown }
      | undefined
    const read = (candidate: unknown): { provider: string; model: string; reasoningEffort?: string } | undefined => {
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const record = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
      return {
        provider: record.provider,
        model: record.model,
        ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
      }
    }
    return read(state?.pending)
      ?? latestSelection(runtime.session)
      ?? read(runtime.agent.options)
      ?? read(state?.lastUsed)
      ?? this.#defaultSelection()
  }

  async #syncHost(host: HostView): Promise<void> {
    this.#ensureApprovalStream(host)
    await this.#reconcileTestHidden(host)
    const workspaces = await this.#hosts.workspaces(host.id)
    const covered = new Set<string>()
    const byPath = new Map<string, { workspace: Workspace; anchor: string }>()
    for (const workspace of workspaces) {
      if (isTestHidden(workspace.path, workspace.workspaceId, this.#testVisibility)) {
        const sessions = await this.#hosts.sessions(host.id, workspace.workspaceId)
        for (const summary of sessions.sessions) covered.add(summary.sessionId)
        continue
      }
      const local = await this.#ensureWorkspace(host, workspace)
      byPath.set(workspace.path, { workspace: local, anchor: this.#anchorFor(local) })
      const sessions = await this.#hosts.sessions(host.id, workspace.workspaceId)
      for (const summary of sessions.sessions) {
        covered.add(summary.sessionId)
        await this.#ensureMirror(host, summary, local, workspace.path)
      }
    }
    const all = await this.#hosts.sessions(host.id)
    for (const summary of all.sessions) {
      if (covered.has(summary.sessionId)) continue
      if (summary.cwd !== null && isTestHidden(summary.cwd, '', this.#testVisibility)) continue
      const workspace = summary.cwd === null ? undefined : byPath.get(summary.cwd)
      if (workspace !== undefined) {
        await this.#ensureMirror(host, summary, workspace.workspace, workspace.anchor)
        continue
      }
      const ungrouped = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
      await this.#ensureMirror(host, summary, ungrouped.workspace, ungrouped.anchor)
    }
  }

  /**
   * Apply the test-only manifest to already-mirrored workspaces. Hidden entries
   * archive local Sessions and remove the local workspace row; removing an
   * entry unarchives the Sessions and lets the normal sync rebuild the row.
   */
  async #reconcileTestHidden(host: HostView): Promise<void> {
    let changed = false
    const entries = Object.entries(this.#state.workspaces)
      .filter(([, record]) => record.hostId === host.id)
    for (const [ref, record] of entries) {
      const hidden = record.remoteRoot !== undefined
        && isTestHidden(record.remoteRoot, record.remoteWorkspaceId ?? '', this.#testVisibility)
      const tracked = this.#state.testHidden.includes(ref)
      if (hidden) {
        if (record.remoteRoot === undefined || tracked) continue
        for (const session of Object.values(this.#state.sessions)) {
          if (session.hostId !== host.id) continue
          if (session.remoteWorkspaceId !== record.remoteWorkspaceId) continue
          await this.#archive(session.localSessionId as SessionId)
        }
        try {
          await this.#workspaceRegistry.delete(record.localWorkspaceId as WorkspaceId)
        } catch (error) {
          this.#ctx.logger.warn('dsh-remote-local: could not hide test workspace %s: %s', ref, String(error))
        }
        this.#state.testHidden.push(ref)
        changed = true
      } else if (tracked) {
        for (const session of Object.values(this.#state.sessions)) {
          if (session.hostId !== host.id) continue
          if (session.remoteWorkspaceId !== record.remoteWorkspaceId) continue
          try {
            await this.#workspaceRegistry.unarchiveSession(session.localSessionId as SessionId)
          } catch {
            // Removed local Sessions are simply rebuilt by the next sync.
          }
        }
        this.#state.testHidden = this.#state.testHidden.filter(item => item !== ref)
        changed = true
      }
    }
    if (changed) await this.#save()
  }

  async #ensureWorkspace(host: HostView, remote: RemoteWorkspace): Promise<Workspace> {
    const ref = key(host.id, remote.workspaceId)
    const existing = this.#state.workspaces[ref]
    if (existing !== undefined) {
      try {
        await mkdir(existing.anchor, { recursive: true })
        const workspace = await this.#workspaceRegistry.create(existing.anchor, existing.title)
        existing.localWorkspaceId = String(workspace.id)
        if (existing.remoteRoot === undefined) {
          this.#state.workspaces[ref] = { ...existing, remoteRoot: remote.path }
          await this.#save()
        }
        return workspace
      } catch (error) {
        this.#ctx.logger.warn('dsh-remote-local: mapped workspace %s unavailable: %s', ref, String(error))
      }
    }
    const anchor = join(this.#config.stateDir, 'anchors', safe(host.id), safe(remote.workspaceId))
    await mkdir(anchor, { recursive: true })
    const title = `${host.label} · ${remote.title}`
    const workspace = await this.#workspaceRegistry.create(anchor, title)
    this.#state.workspaces[ref] = {
      hostId: host.id,
      remoteWorkspaceId: remote.workspaceId,
      localWorkspaceId: String(workspace.id),
      anchor,
      remoteRoot: remote.path,
      title,
      updatedAt: new Date().toISOString(),
    }
    await this.#save()
    return workspace
  }

  async #ensureUngroupedWorkspace(host: HostView, cwd: string): Promise<{ workspace: Workspace; anchor: string }> {
    const remoteId = `ungrouped:${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`
    const ref = key(host.id, remoteId)
    const existing = this.#state.workspaces[ref]
    if (existing !== undefined) {
      await mkdir(existing.anchor, { recursive: true })
      const workspace = await this.#workspaceRegistry.create(existing.anchor, existing.title)
      existing.localWorkspaceId = String(workspace.id)
      if (existing.remoteRoot === undefined) {
        this.#state.workspaces[ref] = { ...existing, remoteRoot: cwd }
        await this.#save()
      }
      return { workspace, anchor: existing.anchor }
    }
    const anchor = join(this.#config.stateDir, 'anchors', safe(host.id), 'ungrouped', remoteId.split(':')[1] ?? 'root')
    await mkdir(anchor, { recursive: true })
    const title = `${host.label} · ${cwd}`
    const workspace = await this.#workspaceRegistry.create(anchor, title)
    this.#state.workspaces[ref] = {
      hostId: host.id,
      remoteWorkspaceId: null,
      localWorkspaceId: String(workspace.id),
      anchor,
      remoteRoot: cwd,
      title,
      updatedAt: new Date().toISOString(),
    }
    await this.#save()
    return { workspace, anchor }
  }

  #ensureApprovalStream(host: HostView): void {
    if (this.#approvalStreams.has(host.id)) return
    const controller = new AbortController()
    this.#approvalStreams.set(host.id, controller)
    void (async () => {
      try {
        for await (const frame of this.#hosts.followApprovals(host.id, controller.signal)) {
          if (frame.type === 'request') void this.#handleApproval(host.id, frame.request)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.#ctx.logger.warn('dsh-remote-local: approval stream %s failed: %s', host.id, String(error))
        }
      } finally {
        this.#approvalStreams.delete(host.id)
      }
    })()
  }

  async #handleApproval(hostId: string, request: RemoteApprovalRequest): Promise<void> {
    const runtime = [...this.#runtimes.values()].find(
      item => item.record.hostId === hostId && item.record.remoteSessionId === request.sessionId,
    )
    if (runtime === undefined) {
      await this.#hosts.answerApproval(hostId, request.id, 'unavailable').catch(() => undefined)
      return
    }
    const local = new AbortController()
    let outcome: ApprovalOutcome = 'unavailable'
    try {
      const waterfall = this.#ctx.waterfall as unknown as (
        thisArg: unknown,
        name: string,
        request: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>
      outcome = await waterfall(
        scopeTarget(runtime.agent as never, runtime.agent as never),
        'approval/request',
        {
          agent: runtime.agent as never,
          toolName: request.toolName,
          ...request.callId === undefined ? {} : { callId: request.callId as never },
          ...request.reason === undefined ? {} : { reason: request.reason },
          ...request.displayReason === undefined ? {} : { displayReason: request.displayReason },
          signal: local.signal,
        },
        async () => 'unavailable',
      ) as ApprovalOutcome
    } catch (error) {
      this.#ctx.logger.warn('dsh-remote-local: local approval bridge failed: %s', String(error))
      outcome = 'unavailable'
    }
    await this.#hosts.answerApproval(hostId, request.id, outcome).catch(error => {
      this.#ctx.logger.warn('dsh-remote-local: approval answer failed: %s', String(error))
    })
  }

  async #ensureMirror(
    host: HostView,
    remote: RemoteSessionSummary,
    workspace: Workspace,
    _remotePath: string,
  ): Promise<MirrorRecord | undefined> {
    const ref = key(host.id, remote.sessionId)
    const existing = this.#state.sessions[ref]
    if (existing !== undefined) {
      const live = this.#sessions.get(existing.localSessionId as SessionId)
      const runtime = this.#runtimes.get(existing.localSessionId)
      if (live !== undefined && runtime !== undefined && !runtime.stopped) {
        await this.#attach(workspace, live.id)
        if (remote.live) {
          this.#startStream(runtime)
          this.#startAssistantStream(runtime)
        }
        return existing
      }
      const stalled = this.#runtimes.get(existing.localSessionId)
      if (stalled !== undefined) {
        stalled.stopped = true
        if (stalled.timer !== undefined) clearTimeout(stalled.timer)
        stalled.stream?.abort()
        stalled.assistant?.abort()
        this.#runtimes.delete(existing.localSessionId)
      }
      const registration = this.#registrations.get(existing.localSessionId)
      if (registration !== undefined) {
        registration()
        this.#registrations.delete(existing.localSessionId)
      }
      if (live !== undefined) {
        // A previous process left a persisted mirror; hide it before replacing.
        await this.#archive(existing.localSessionId as SessionId)
      } else if (existing.localSessionId !== '') {
        await this.#archive(existing.localSessionId as SessionId)
      }
    }

    const snapshot = await this.#hosts.snapshot(host.id, remote.sessionId, this.#config.mirrorMaxEvents)
    if (snapshot.truncated && (snapshot.events[0]?.seq ?? 0) > 0) {
      this.#ctx.logger.warn(
        'dsh-remote-local: remote session %s is too long to mirror (%d events); open it in the remote UI',
        remote.sessionId,
        snapshot.cursor,
      )
      return undefined
    }
    const anchor = this.#anchorFor(workspace)
    await mkdir(anchor, { recursive: true })
    const localId = `session-${randomUUID()}`
    let session: Session
    const remoteToLocalSeq = new Map<number, number>()
    let latestTurn = 0
    try {
      const filtered = snapshot.events.filter(event => !isMirrorNoise(event.type))
      for (const event of filtered) {
        if (event.type !== 'turn/start') continue
        const turn = (event.data as { turn?: unknown }).turn
        if (typeof turn === 'number') latestTurn = Math.max(latestTurn, turn)
      }
      for (const [index, event] of filtered.entries()) remoteToLocalSeq.set(event.seq, index)
      const seqMap = new Map(filtered.map((event, index) => [event.seq, index]))
      const seed = filtered.map((event, index) => toSeedEvent(event, index, seqMap))
      session = this.#sessions.create(localId as SessionId, {
        ...seed.length === 0 ? {} : { seed },
        meta: { cwd: anchor },
      })
    } catch (error) {
      this.#ctx.logger.warn('dsh-remote-local: could not seed mirror for %s: %s', remote.sessionId, String(error))
      return undefined
    }
    await this.#attach(workspace, session.id)
    try {
      await this.#sessions.flush(session)
    } catch (error) {
      this.#ctx.logger.debug('dsh-remote-local: mirror flush failed: %s', String(error))
    }

    const record: MirrorRecord = {
      hostId: host.id,
      remoteSessionId: remote.sessionId,
      localSessionId: localId,
      remoteWorkspaceId: remote.workspaceId,
      anchor,
      lastSeq: snapshot.cursor,
      updatedAt: new Date().toISOString(),
    }
    this.#state.sessions[ref] = record

    const runtime = {
      record,
      agent: null as unknown as MirrorAgent,
      session,
      timer: undefined,
      stream: undefined,
      assistant: undefined,
      remoteToLocalSeq,
      pendingAssistantEnds: new Map(),
      latestTurn,
      awaitingTurn: null,
      running: false,
      stopped: false,
      lastError: null,
      pendingUsers: [],
      waiters: [],
    } satisfies MirrorRuntime
    const options = this.#defaultSelection() ?? modelOptions(snapshot.events)
    const agent = new RemoteMirrorAgent(this, runtime, this.#ctx, options)
    runtime.agent = agent
    this.#runtimes.set(localId, runtime)
    this.#registrations.set(localId, this.#agents.enter(agent as never, undefined))
    await this.#save()
    this.#schedule(runtime)
    if (remote.live) {
      this.#startStream(runtime)
      this.#startAssistantStream(runtime)
    }
    this.#ctx.logger.info(
      'dsh-remote-local: mirrored remote session %s as local %s',
      remote.sessionId,
      localId,
    )
    return record
  }

  #schedule(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed) return
    runtime.timer = setTimeout(() => { void this.#poll(runtime) }, Math.max(500, this.#config.mirrorPollMs))
  }

  async #poll(runtime: MirrorRuntime): Promise<void> {
    if (runtime.stopped || this.#disposed) return
    try {
      const local = this.#sessions.get(runtime.session.id)
      if (local === undefined) {
        runtime.stopped = true
        runtime.stream?.abort()
        runtime.assistant?.abort()
        return
      }
      const snapshot = await this.#hosts.snapshot(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        this.#config.mirrorMaxEvents,
      )
      if (snapshot.truncated && (snapshot.events[0]?.seq ?? 0) > runtime.record.lastSeq) {
        runtime.lastError = 'remote log grew past the mirror window'
        runtime.stopped = true
        runtime.stream?.abort()
        runtime.assistant?.abort()
        return
      }
      for (const event of snapshot.events) {
        if (event.seq < runtime.record.lastSeq) continue
        if (event.seq !== runtime.record.lastSeq) {
          throw new Error(`remote event gap at ${event.seq}, mirror ${runtime.record.lastSeq}`)
        }
        this.#appendEvent(runtime, event)
        runtime.record.lastSeq = event.seq + 1
      }
      runtime.record.updatedAt = new Date().toISOString()
      if (!snapshot.live && runtime.record.lastSeq >= snapshot.cursor) {
        runtime.stopped = true
        runtime.stream?.abort()
        runtime.assistant?.abort()
      }
      await this.#save()
      if (snapshot.live && !runtime.stopped) {
        this.#startStream(runtime)
        this.#startAssistantStream(runtime)
      }
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn(
        'dsh-remote-local: mirror poll %s failed: %s',
        runtime.record.remoteSessionId,
        runtime.lastError,
      )
    }
    this.#schedule(runtime)
  }

  #startStream(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed || runtime.stream !== undefined) return
    const controller = new AbortController()
    runtime.stream = controller
    void this.#followStream(runtime, controller.signal).finally(() => {
      if (runtime.stream === controller) runtime.stream = undefined
    })
  }

  async #followStream(runtime: MirrorRuntime, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.#hosts.followSessionEvents(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        runtime.record.lastSeq,
        signal,
      )) {
        if (runtime.stopped || this.#disposed || signal.aborted) return
        if (frame.type === 'end') return
        if (frame.type !== 'event') continue
        const event = frame.event
        if (event.seq < runtime.record.lastSeq) continue
        if (event.seq !== runtime.record.lastSeq) {
          runtime.lastError = `remote event gap at ${event.seq}, mirror ${runtime.record.lastSeq}`
          return
        }
        this.#appendEvent(runtime, event)
        runtime.record.lastSeq = event.seq + 1
        runtime.record.updatedAt = new Date().toISOString()
        await this.#save()
      }
    } catch (error) {
      if (signal.aborted || runtime.stopped || this.#disposed) return
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn(
        'dsh-remote-local: mirror stream %s failed: %s',
        runtime.record.remoteSessionId,
        runtime.lastError,
      )
    }
  }

  #appendEvent(runtime: MirrorRuntime, event: RemoteSessionEvent): void {
    const before = (runtime.session as unknown as { seq: number }).seq
    if (!isMirrorNoise(event.type)) appendRemoteEvent(runtime.session, event, runtime)
    const after = (runtime.session as unknown as { seq: number }).seq
    if (after > before) {
      runtime.remoteToLocalSeq.set(event.seq, after - 1)
      this.#flushAssistantEnd(runtime, event.seq)
    }
    const turn = typeof event.data === 'object' && event.data !== null
      ? (event.data as { turn?: unknown }).turn
      : undefined
    if (typeof turn !== 'number') return
    if (event.type === 'turn/start') {
      runtime.latestTurn = Math.max(runtime.latestTurn, turn)
      return
    }
    if (event.type !== 'turn/end') return
    runtime.latestTurn = Math.max(runtime.latestTurn, turn)
    if (runtime.awaitingTurn === null || turn >= runtime.awaitingTurn) {
      runtime.awaitingTurn = null
      this.#setRunning(runtime, false)
    }
  }

  #defaultSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const defaults = this.#ctx.get('agentDefaultModel') as unknown as {
      currentSelection?: () => unknown
    } | undefined
    const candidate = defaults?.currentSelection?.()
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const record = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
    return {
      provider: record.provider,
      model: record.model,
      ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
    }
  }

  #flushAssistantEnd(runtime: MirrorRuntime, remoteSeq: number): void {
    const pending = runtime.pendingAssistantEnds.get(remoteSeq)
    if (pending === undefined) return
    const localSeq = runtime.remoteToLocalSeq.get(remoteSeq)
    if (localSeq === undefined) return
    runtime.pendingAssistantEnds.delete(remoteSeq)
    if (pending.outcome?.kind !== 'committed') {
      this.#emitAssistant(runtime, pending)
      return
    }
    this.#emitAssistant(runtime, {
      ...pending,
      outcome: { ...pending.outcome, seq: localSeq },
    })
  }

  #emitAssistant(runtime: MirrorRuntime, frame: RemoteAssistantFrame): void {
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/assistant-stream', { agent: runtime.agent, frame })
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-remote-local: local assistant frame %s failed: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
  }

  #startAssistantStream(runtime: MirrorRuntime): void {
    if (runtime.stopped || this.#disposed || runtime.assistant !== undefined) return
    const controller = new AbortController()
    runtime.assistant = controller
    void this.#followAssistant(runtime, controller.signal).finally(() => {
      if (runtime.assistant === controller) runtime.assistant = undefined
    })
  }

  async #followAssistant(runtime: MirrorRuntime, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.#hosts.followAssistantFrames(
        runtime.record.hostId,
        runtime.record.remoteSessionId,
        signal,
      )) {
        if (runtime.stopped || this.#disposed || signal.aborted) return
        if (frame.type === 'start') {
          this.#setRunning(runtime, true)
          const { startedAfterSeq: _startedAfterSeq, ...rest } = frame as RemoteAssistantFrame & { startedAfterSeq?: number }
          this.#emitAssistant(runtime, rest as RemoteAssistantFrame)
          continue
        }
        if (frame.type === 'chunk') {
          this.#emitAssistant(runtime, frame)
          continue
        }
        const outcome = frame.outcome
        if (outcome === undefined) return
        if (outcome.kind !== 'committed') {
          this.#emitAssistant(runtime, frame)
          continue
        }
        const localSeq = runtime.remoteToLocalSeq.get(outcome.seq)
        if (localSeq === undefined) {
          runtime.pendingAssistantEnds.set(outcome.seq, frame)
          continue
        }
        this.#emitAssistant(runtime, {
          ...frame,
          outcome: { ...outcome, seq: localSeq },
        })
      }
    } catch (error) {
      if (signal.aborted || runtime.stopped || this.#disposed) return
      this.#ctx.logger.warn(
        'dsh-remote-local: assistant stream %s failed: %s',
        runtime.record.remoteSessionId,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  #setRunning(runtime: MirrorRuntime, running: boolean): void {
    if (runtime.running === running) return
    runtime.running = running
    if (!running) {
      for (const waiter of runtime.waiters.splice(0)) waiter()
    }
  }

  async #attach(workspace: Workspace, sessionId: SessionId): Promise<void> {
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.#ctx.logger.debug('dsh-remote-local: attach mirror %s failed: %s', sessionId, String(error))
    }
  }

  async #archive(sessionId: SessionId): Promise<void> {
    try {
      await this.#workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    } catch {
      // Missing/active sessions are left alone; the new mirror is still usable.
    }
  }

  #anchorFor(workspace: Workspace): string {
    for (const record of Object.values(this.#state.workspaces)) {
      if (record.localWorkspaceId === String(workspace.id)) return record.anchor
    }
    return join(this.#config.stateDir, 'anchors', safe(String(workspace.id)))
  }

  async #load(): Promise<void> {
    try {
      const raw = await readFile(join(this.#config.stateDir, 'mirrors.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<MirrorState>
      if (parsed.version === MIRROR_VERSION && parsed.sessions !== undefined && parsed.workspaces !== undefined) {
        this.#state = {
          version: MIRROR_VERSION,
          sessions: parsed.sessions,
          workspaces: parsed.workspaces,
          testHidden: Array.isArray(parsed.testHidden) ? parsed.testHidden : [],
        }
      }
    } catch {
      // First run or a corrupt cache: rebuild from connected hosts.
    }
  }

  async #save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`
    const task = this.#saveQueue.then(async () => {
      await mkdir(this.#config.stateDir, { recursive: true })
      const path = join(this.#config.stateDir, 'mirrors.json')
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, path)
    })
    this.#saveQueue = task.then(() => undefined, () => undefined)
    return task
  }
}

function isMirrorNoise(type: string): boolean {
  // Inbox splices are projections of the remote pending-input state. Replaying
  // them into a local Session with a custom Agent has no local inbox owner and
  // can fail projection validation; the transcript does not need them.
  return type === 'agent/inbox/spliced'
}

function appendRemoteEvent(
  session: Session,
  event: RemoteSessionEvent,
  runtime: MirrorRuntime,
): void {
  // The remote user message carries the remote request id. Reuse the local
  // optimistic message instead so the client settles its pending submission,
  // and keep the remote event's position in the turn.
  if (event.type === 'user/message' && runtime.pendingUsers.length > 0) {
    const source = (event.data as { source?: { kind?: unknown } }).source
    if (source?.kind === 'user') {
      const message = runtime.pendingUsers.shift()
      if (message !== undefined) {
        session.append('user/message', messageData(message) as never, { surfaceOp: 'append' } as never)
        return
      }
    }
  }
  const append = session.append.bind(session) as (...args: unknown[]) => unknown
  if (SURFACE_TYPES.has(event.type)) {
    const opts = {
      surfaceOp: event.surfaceOp ?? 'append',
      ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
    }
    append(event.type, event.data, opts)
  } else {
    append(event.type, event.data)
  }
}

function messageData(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message
  const record = message as { id?: unknown; role?: unknown; content?: unknown; source?: unknown }
  return {
    ...typeof record.id === 'string' ? { id: record.id } : { id: `msg-${randomUUID()}` },
    role: 'user',
    content: Array.isArray(record.content) ? record.content : [],
    source: record.source ?? { kind: 'user' },
  }
}

function toSeedEvent(event: RemoteSessionEvent, seq: number, map: ReadonlyMap<number, number>): SessionEvent {
  const surfaceOp = typeof event.surfaceOp === 'object'
    ? {
        op: 'replace' as const,
        startSeq: map.get(event.surfaceOp.startSeq) ?? 0,
        endSeq: map.get(event.surfaceOp.endSeq) ?? 0,
      }
    : event.surfaceOp
  const sourceEventSeqs = event.sourceEventSeqs
    ?.map(source => map.get(source))
    .filter((source): source is number => source !== undefined)
  return {
    seq,
    type: event.type,
    time: event.time,
    data: event.data,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...sourceEventSeqs === undefined || sourceEventSeqs.length === 0 ? {} : { sourceEventSeqs },
  } as unknown as SessionEvent
}

function modelOptions(events: readonly RemoteSessionEvent[]): MirrorAgent['options'] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const data = event.data as { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
    if (typeof data.config?.provider === 'string' && typeof data.config.model === 'string') {
      return {
        provider: data.config.provider,
        model: data.config.model,
        ...typeof data.config.reasoningEffort === 'string' ? { reasoningEffort: data.config.reasoningEffort } : {},
      }
    }
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

function latestSelection(session: Session): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const record = event as unknown as { type?: string; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
    if (record.type !== 'model/selection') continue
    const data = record.data ?? {}
    if (typeof data.provider === 'string' && typeof data.model === 'string') {
      return {
        provider: data.provider,
        model: data.model,
        ...typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {},
      }
    }
  }
  return undefined
}

function contentText(message: unknown): string {
  if (typeof message === 'string') return message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') texts.push(part)
    else if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.join('\n').trim()
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function key(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

function safe(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}
