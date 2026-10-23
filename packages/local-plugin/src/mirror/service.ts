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
  SessionSnapshot,
  RemoteWorkspace,
  PromptContentPart,
  PromptDeliveryMode,
} from '@dsh-remote/protocol'
import type { ResolvedConfig } from '../config.ts'
import { singleFlight } from './inflight.ts'
import { isTestHidden, loadTestVisibility, type TestVisibility } from './test-visibility.ts'
import { abandonedTurnEnd } from './recovery.ts'
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

interface PendingUser {
  readonly message: unknown
  localSeq: number
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
  assistantAttempt: { attemptId: string; revision: number; turn: number; step: number; index: number; ended: boolean; settled: boolean; emitted: boolean } | undefined
  durableAssistantSteps: Set<string>
  latestTurn: number
  awaitingTurn: number | null
  awaitingStarted: boolean
  applyingRemote: boolean
  running: boolean
  stopped: boolean
  lastError: string | null
  pendingUsers: PendingUser[]
  waiters: Array<() => void>
}

interface MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: { provider: string; model: string; reasoningEffort?: string }
  readonly ctx: Context
  readonly inbox: MirrorInbox
  readonly status: 'idle' | 'running'
  cancel(cause?: unknown): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: unknown, target?: unknown, wakeup?: boolean): void
  followup(message: unknown): void
  steer(message: unknown): void
  inject(message: unknown): void
}

interface MirrorInbox {
  readonly 'next-turn': unknown[]
  readonly 'next-step': unknown[]
  readonly nextTurn: unknown[]
  readonly nextStep: unknown[]
  readonly hasPending: boolean
  remove(id: unknown): boolean
  replace(id: unknown, message: unknown): boolean
  splice(target: string, start: number, deleteCount: number, inserted: unknown[]): unknown[]
  clear(): void
}

function messageIdentity(message: unknown): unknown {
  return typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined
}

function createMirrorInbox(session: Session): MirrorInbox {
  const nextTurn: unknown[] = []
  const nextStep: unknown[] = []
  const locate = (id: unknown): { target: 'next-turn' | 'next-step'; index: number } | undefined => {
    for (const target of ['next-turn', 'next-step'] as const) {
      const list = target === 'next-turn' ? nextTurn : nextStep
      const index = list.findIndex(message => messageIdentity(message) === id)
      if (index >= 0) return { target, index }
    }
    return undefined
  }
  const append = (target: 'next-turn' | 'next-step', start: number, inserted: unknown[], removedCount = 0): void => {
    try {
      ;(session as unknown as { append(type: string, data: unknown): unknown }).append('agent/inbox/spliced', {
        target,
        start,
        ...removedCount === 0 ? {} : { removedCount },
        inserted,
      })
    } catch {
      // The local Session may be disposing; the in-memory queue remains usable.
    }
  }
  const inbox: MirrorInbox = {
    'next-turn': nextTurn,
    'next-step': nextStep,
    nextTurn,
    nextStep,
    get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
    remove(id) {
      const found = locate(id)
      if (found === undefined) return false
      const list = found.target === 'next-turn' ? nextTurn : nextStep
      list.splice(found.index, 1)
      append(found.target, found.index, [], 1)
      return true
    },
    replace(id, message) {
      const found = locate(id)
      if (found === undefined) return false
      const list = found.target === 'next-turn' ? nextTurn : nextStep
      list.splice(found.index, 1, message)
      append(found.target, found.index, [message], 1)
      return true
    },
    splice(target, start, deleteCount, inserted) {
      const list = target === 'next-turn' ? nextTurn : nextStep
      const removed = list.splice(start, deleteCount, ...inserted)
      append(target === 'next-turn' ? 'next-turn' : 'next-step', start, inserted, removed.length)
      return removed
    },
    clear() {
      if (nextStep.length > 0) {
        const count = nextStep.length
        nextStep.length = 0
        append('next-step', 0, [], count)
      }
      if (nextTurn.length > 0) {
        const count = nextTurn.length
        nextTurn.length = 0
        append('next-turn', 0, [], count)
      }
    },
  }
  return inbox
}

/** One custom Agent façade backed by the remote agent's session. */
class RemoteMirrorAgent implements MirrorAgent {
  readonly id: SessionId
  readonly session: Session
  readonly options: MirrorAgent['options']
  readonly ctx: Context
  readonly inbox: MirrorInbox
  #runtime: MirrorRuntime
  #mirror: RemoteMirrorService

  constructor(mirror: RemoteMirrorService, runtime: MirrorRuntime, ctx: Context, options: MirrorAgent['options']) {
    this.#mirror = mirror
    this.#runtime = runtime
    this.id = runtime.session.id
    this.session = runtime.session
    this.ctx = ctx
    this.options = options
    this.inbox = createMirrorInbox(runtime.session)
  }

  get status(): 'idle' | 'running' {
    return this.#runtime.running ? 'running' : 'idle'
  }

  cancel(): void {
    this.inbox.clear()
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
    if (wakeup || this.#runtime.running) this.followup(message)
    else this.#mirror.prompt(this.#runtime, message, 'queue')
  }

  followup(message: unknown): void {
    if (this.#runtime.running) {
      this.inbox.splice('next-turn', this.inbox.nextTurn.length, 0, [message])
      return
    }
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
  #mirrorsInFlight = new Map<string, Promise<MirrorRecord | undefined>>()
  #syncing = false
  #saveQueue: Promise<void> = Promise.resolve()
  #timer: NodeJS.Timeout | undefined
  #selectionOff: (() => void) | undefined
  #disposed = false

  constructor(ctx: Context, hosts: RemoteHostsService, config: ResolvedConfig) {
    this.#ctx = ctx
    this.#hosts = hosts
    this.#config = config
  }

  /** Load mappings and begin periodic discovery. */
  async start(): Promise<void> {
    await this.#load()
    this.#selectionOff = this.#ctx.on('session/event' as never, ((session: Session, event: SessionEvent) => {
      this.#onLocalSessionEvent(session, event)
    }) as never, { global: true } as never)
    if (!this.#config.mirrorSessions) return
    // Catalog reconciliation is much less urgent than event delivery.
    this.#timer = setInterval(() => { void this.sync() }, Math.max(5_000, this.#config.mirrorPollMs * 4))
    await this.sync()
  }

  /** Stop mirrors and timers. */
  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#selectionOff?.()
    this.#selectionOff = undefined
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

  /** Local workspace ids that represent remote workspaces. */
  localWorkspaceIds(): string[] {
    return Object.values(this.#state.workspaces)
      .map(workspace => workspace.localWorkspaceId)
      .filter((id): id is string => typeof id === 'string' && id !== '')
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
      const sessions = await this.#hosts.sessions(hostId, workspace.workspaceId, true)
      const summary = sessions.sessions.find(item => item.sessionId === remoteSessionId)
      if (summary === undefined) continue
      const localWorkspace = await this.#ensureWorkspace(host, workspace)
      const record = await this.#ensureMirror(host, summary, localWorkspace, workspace.path)
      return record?.localSessionId
    }
    const all = await this.#hosts.sessions(hostId, undefined, true)
    const summary = all.sessions.find(item => item.sessionId === remoteSessionId)
    if (summary === undefined) return undefined
    if (summary.cwd !== null && isTestHidden(summary.cwd, '', this.#testVisibility)) return undefined
    const localWorkspace = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
    return (await this.#ensureMirror(host, summary, localWorkspace.workspace, localWorkspace.anchor))?.localSessionId
  }

  /** Route one prompt from the local Agent façade to the remote session. */
  prompt(runtime: MirrorRuntime, message: unknown, mode: PromptDeliveryMode): void {
    const parts = promptParts(message)
    if (parts.length === 0) return
    const pending: PendingUser = { message, localSeq: -1 }
    runtime.pendingUsers.push(pending)
    if (!runtime.running) {
      runtime.awaitingTurn = runtime.latestTurn + 1
      runtime.awaitingStarted = false
    } else {
      runtime.awaitingStarted = true
    }
    this.#setRunning(runtime, true)
    if (runtime.stopped || runtime.timer === undefined) {
      runtime.stopped = false
      runtime.lastError = null
      this.#schedule(runtime)
    }
    const selection = this.#selectionFor(runtime)
    if (selection !== undefined) Object.assign(runtime.agent.options, selection)
    void this.#promptContent(message).then(({ text, content }) => this.#hosts.promptSession(
      runtime.record.hostId,
      runtime.record.remoteSessionId,
      text,
      mode,
      selection,
      content,
    )).then(() => {
      if (!runtime.pendingUsers.includes(pending)) return
      const before = (runtime.session as unknown as { seq: number }).seq
      try {
        runtime.session.append('user/message', messageData(message) as never, { surfaceOp: 'append' } as never)
        pending.localSeq = (runtime.session as unknown as { seq: number }).seq > before
          ? (runtime.session as unknown as { seq: number }).seq - 1
          : -1
      } catch (error) {
        this.#ctx.logger.warn('dsh-remote-local: could not append accepted user message: %s', String(error))
      }
    }).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      const index = runtime.pendingUsers.indexOf(pending)
      if (index >= 0) runtime.pendingUsers.splice(index, 1)
      this.#ctx.logger.warn('dsh-remote-local: remote prompt failed: %s', runtime.lastError)
      try {
        const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
        emit.call(this.#ctx, 'agent/error', {
          agent: runtime.agent,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      } catch (emitError) {
        this.#ctx.logger.warn('dsh-remote-local: prompt error notification failed: %s', String(emitError))
      }
      this.#setRunning(runtime, false)
    })
  }

  async #promptContent(message: unknown): Promise<{ text: string; content: PromptContentPart[] }> {
    const content: PromptContentPart[] = []
    for (const part of promptParts(message)) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text })
        continue
      }
      const attachments = this.#ctx.get('attachments') as unknown as {
        readImage(ref: unknown): Promise<{
          data: Uint8Array
          mediaType?: unknown
          ref?: { mediaType?: unknown; name?: unknown }
        }>
      } | undefined
      if (attachments === undefined) throw new Error('本地附件服务不可用')
      const stored = await attachments.readImage(part.attachment)
      const mediaType = typeof stored.mediaType === 'string'
        ? stored.mediaType
        : typeof stored.ref?.mediaType === 'string' ? stored.ref.mediaType : undefined
      if (mediaType === undefined) throw new Error('图片缺少 mediaType')
      const name = part.name ?? (typeof stored.ref?.name === 'string' ? stored.ref.name : undefined)
      content.push({
        type: 'image',
        data: Buffer.from(stored.data).toString('base64'),
        mediaType,
        ...name === undefined ? {} : { name },
      })
    }
    const text = content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (content.length === 0) throw new Error('消息内容为空')
    return { text, content }
  }

  /** Route cancellation to the remote session only after the remote accepts it. */
  cancel(runtime: MirrorRuntime): void {
    void this.#hosts.cancelSession(runtime.record.hostId, runtime.record.remoteSessionId).then(() => {
      runtime.awaitingTurn = null
      runtime.awaitingStarted = false
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
  }

  async #syncHost(host: HostView): Promise<void> {
    this.#ensureApprovalStream(host)
    await this.#reconcileTestHidden(host)
    const workspaces = await this.#hosts.workspaces(host.id)
    const covered = new Set<string>()
    const subagents = new Set<string>()
    const byPath = new Map<string, { workspace: Workspace; anchor: string }>()
    for (const workspace of workspaces) {
      if (isTestHidden(workspace.path, workspace.workspaceId, this.#testVisibility)) {
        const sessions = await this.#hosts.sessions(host.id, workspace.workspaceId, true)
        for (const summary of sessions.sessions) covered.add(summary.sessionId)
        continue
      }
      const local = await this.#ensureWorkspace(host, workspace)
      byPath.set(workspace.path, { workspace: local, anchor: this.#anchorFor(local) })
      const sessions = await this.#hosts.sessions(host.id, workspace.workspaceId, true)
      for (const summary of sessions.sessions) {
        covered.add(summary.sessionId)
        if (summary.origin === 'subagent') {
          subagents.add(summary.sessionId)
          continue
        }
        await this.#ensureMirror(host, summary, local, workspace.path)
      }
    }
    const all = await this.#hosts.sessions(host.id, undefined, true)
    for (const summary of all.sessions) {
      if (summary.origin === 'subagent') subagents.add(summary.sessionId)
      if (covered.has(summary.sessionId)) continue
      if (summary.origin === 'subagent') continue
      if (summary.cwd !== null && isTestHidden(summary.cwd, '', this.#testVisibility)) continue
      const workspace = summary.cwd === null ? undefined : byPath.get(summary.cwd)
      if (workspace !== undefined) {
        await this.#ensureMirror(host, summary, workspace.workspace, workspace.anchor)
        continue
      }
      const ungrouped = await this.#ensureUngroupedWorkspace(host, summary.cwd ?? 'ungrouped')
      await this.#ensureMirror(host, summary, ungrouped.workspace, ungrouped.anchor)
    }
    await this.#pruneMirroredSubagents(host.id, subagents)
  }

  /** Remove local mirrors for remote subagent Sessions, including stale rows. */
  async #pruneMirroredSubagents(hostId: string, subagents: ReadonlySet<string>): Promise<void> {
    let changed = false
    for (const [ref, record] of Object.entries(this.#state.sessions)) {
      if (record.hostId !== hostId || !subagents.has(record.remoteSessionId)) continue
      const runtime = this.#runtimes.get(record.localSessionId)
      if (runtime !== undefined) {
        runtime.stopped = true
        if (runtime.timer !== undefined) clearTimeout(runtime.timer)
        runtime.stream?.abort()
        runtime.assistant?.abort()
        this.#runtimes.delete(record.localSessionId)
      }
      const registration = this.#registrations.get(record.localSessionId)
      if (registration !== undefined) {
        registration()
        this.#registrations.delete(record.localSessionId)
      }
      await this.#archive(record.localSessionId as SessionId)
      delete this.#state.sessions[ref]
      changed = true
    }
    if (!changed) return
    for (const [ref, workspace] of Object.entries(this.#state.workspaces)) {
      if (workspace.hostId !== hostId || workspace.remoteWorkspaceId !== null) continue
      const used = Object.values(this.#state.sessions).some(
        session => session.hostId === hostId && session.anchor === workspace.anchor,
      )
      if (used) continue
      try {
        await this.#workspaceRegistry.delete(workspace.localWorkspaceId as WorkspaceId)
      } catch {
        // The local row may already be gone; dropping the mirror record is enough.
      }
      delete this.#state.workspaces[ref]
    }
    await this.#save()
  }

  /**
   * Apply the test-only manifest to already-mirrored workspaces. Hidden entries  /**
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

  /**
   * Ensure exactly one local mirror per remote Session.
   *
   * Creation is check-then-act across several awaits (workspace and session
   * discovery, snapshot fetch), so a periodic sync and an on-demand
   * `host/session/create` can both observe no mapping and each create a local
   * Session for the same remote Session. Coalesce every caller by remote
   * identity: the first one creates, the others await and share its result.
   */
  async #ensureMirror(
    host: HostView,
    remote: RemoteSessionSummary,
    workspace: Workspace,
    remotePath: string,
  ): Promise<MirrorRecord | undefined> {
    return singleFlight(
      this.#mirrorsInFlight,
      key(host.id, remote.sessionId),
      () => this.#ensureMirrorOnce(host, remote, workspace, remotePath),
    )
  }

  async #ensureMirrorOnce(
    host: HostView,
    remote: RemoteSessionSummary,
    workspace: Workspace,
    _remotePath: string,
  ): Promise<MirrorRecord | undefined> {
    const ref = key(host.id, remote.sessionId)
    const existing = this.#state.sessions[ref]
    let reuse: Session | undefined
    if (existing !== undefined) {
      const live = this.#sessions.get(existing.localSessionId as SessionId)
      const runtime = this.#runtimes.get(existing.localSessionId)
      if (live !== undefined && runtime !== undefined && (!runtime.stopped || !remote.live)) {
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
      if (live !== undefined) reuse = live
    }

    const snapshot = await this.#hosts.snapshot(host.id, remote.sessionId, this.#config.mirrorMaxEvents)
    const anchor = this.#anchorFor(workspace)
    await mkdir(anchor, { recursive: true })
    // A long remote Session may only be available as a truncated tail. Seed
    // from the first complete turn in that tail instead of refusing the mirror
    // entirely; older remote history stays available in the remote UI.
    let seedEvents = snapshot.events
    let seedEndSeq = seedEvents.at(-1)?.seq
    if (snapshot.truncated && (seedEvents[0]?.seq ?? 0) > 0) {
      const firstTurn = seedEvents.findIndex(event => event.type === 'turn/start')
      if (firstTurn > 0) {
        let lastEnd = -1
        for (let index = seedEvents.length - 1; index >= firstTurn; index -= 1) {
          if (seedEvents[index]?.type === 'turn/end') { lastEnd = index; break }
        }
        seedEvents = lastEnd >= firstTurn ? seedEvents.slice(firstTurn, lastEnd + 1) : seedEvents.slice(firstTurn)
        seedEndSeq = seedEvents.at(-1)?.seq
      }
    }
    const filtered = seedEvents.filter(event => !isMirrorNoise(event))
    const seqMap = new Map(filtered.map((event, index) => [event.seq, index]))
    let latestTurn = 0
    for (const event of filtered) {
      if (event.type !== 'turn/start') continue
      const turn = (event.data as { turn?: unknown }).turn
      if (typeof turn === 'number') latestTurn = Math.max(latestTurn, turn)
    }
    const remoteToLocalSeq = new Map<number, number>()
    for (const [index, event] of filtered.entries()) remoteToLocalSeq.set(event.seq, index)

    if (reuse !== undefined) {
      const localEvents = reuse.snapshotEvents()
      for (let index = 0; index < Math.min(localEvents.length, filtered.length); index += 1) {
        const localEvent = localEvents[index]
        const remoteEvent = filtered[index]
        if (localEvent !== undefined && remoteEvent !== undefined) {
          remoteToLocalSeq.set(remoteEvent.seq, localEvent.seq)
        }
      }
      const record = existing as MirrorRecord
      await this.#attach(workspace, reuse.id)
      await this.#mountRuntime(record, reuse, snapshot, remoteToLocalSeq, latestTurn, remote.live)
      this.#ctx.logger.info(
        'dsh-remote-local: reattached remote session %s to local %s',
        remote.sessionId,
        reuse.id,
      )
      return record
    }

    const localId = existing?.localSessionId ?? `session-${randomUUID()}`
    let session: Session
    try {
      const seed = filtered.map((event, index) => toSeedEvent(event, index, seqMap))
      const remoteCreatedAt = Date.parse(remote.createdAt)
      session = this.#sessions.create(localId as SessionId, {
        ...seed.length === 0 ? {} : { seed },
        meta: {
          cwd: anchor,
          ...Number.isFinite(remoteCreatedAt) ? { createdAt: remoteCreatedAt } : {},
        },
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

    const record: MirrorRecord = existing === undefined
      ? {
          hostId: host.id,
          remoteSessionId: remote.sessionId,
          localSessionId: localId,
          remoteWorkspaceId: remote.workspaceId,
          anchor,
          lastSeq: (seedEndSeq ?? snapshot.cursor - 1) + 1,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...existing,
          remoteWorkspaceId: remote.workspaceId,
          anchor,
          lastSeq: (seedEndSeq ?? snapshot.cursor - 1) + 1,
          updatedAt: new Date().toISOString(),
        }
    this.#state.sessions[ref] = record
    await this.#mountRuntime(record, session, snapshot, remoteToLocalSeq, latestTurn, remote.live)
    this.#ctx.logger.info(
      'dsh-remote-local: mirrored remote session %s as local %s',
      remote.sessionId,
      localId,
    )
    return record
  }

  async #mountRuntime(
    record: MirrorRecord,
    session: Session,
    snapshot: SessionSnapshot,
    remoteToLocalSeq: Map<number, number>,
    latestTurn: number,
    live: boolean,
  ): Promise<void> {
    const runtime = {
      record,
      agent: null as unknown as MirrorAgent,
      session,
      timer: undefined,
      stream: undefined,
      assistant: undefined,
      remoteToLocalSeq,
      pendingAssistantEnds: new Map(),
      assistantAttempt: undefined,
      durableAssistantSteps: new Set(),
      latestTurn,
      awaitingTurn: null,
      awaitingStarted: false,
      applyingRemote: false,
      running: false,
      stopped: false,
      lastError: null,
      pendingUsers: [],
      waiters: [],
    } satisfies MirrorRuntime
    const options = this.#defaultSelection() ?? modelOptions(snapshot.events)
    const agent = new RemoteMirrorAgent(this, runtime, this.#ctx, options)
    runtime.agent = agent
    this.#runtimes.set(record.localSessionId, runtime)
    this.#registrations.set(record.localSessionId, this.#agents.enter(agent as never, undefined))
    const localMode = this.#localSandboxMode(session)
    const remoteMode = latestRemoteSandboxMode(snapshot.events)
    if (localMode !== undefined && remoteMode !== undefined && localMode !== remoteMode) {
      void this.#hosts.setSandboxMode(record.hostId, record.remoteSessionId, localMode).catch(error => {
        this.#ctx.logger.warn('dsh-remote-local: initial sandbox mode failed: %s', String(error))
      })
    }
    await this.#save()
    this.#schedule(runtime)
    if (live) {
      this.#startStream(runtime)
      this.#startAssistantStream(runtime)
    }
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
        const first = snapshot.events[0]?.seq
        this.#ctx.logger.warn(
          'dsh-remote-local: remote log for %s skipped ahead to seq %s (window %d)',
          runtime.record.remoteSessionId,
          String(first ?? snapshot.cursor),
          this.#config.mirrorMaxEvents,
        )
        runtime.record.lastSeq = first ?? snapshot.cursor
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
        if (runtime.running) this.#closeAbandonedTurn(runtime)
        if (!runtime.running) {
          runtime.stopped = true
          runtime.stream?.abort()
          runtime.assistant?.abort()
        }
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

  /**
   * Close a turn the remote Session opened but never ended, for example when the remote
   * DSH host restarted mid-step. Without this the mirror keeps reporting `running`, queues
   * every later prompt in its local inbox, and never follows the remote again.
   */
  #closeAbandonedTurn(runtime: MirrorRuntime): void {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const boundary = projections?.stateOf?.(runtime.session, 'turnBoundary') as
      | { openTurnStartSeq?: unknown }
      | undefined
    const event = abandonedTurnEnd(boundary, runtime.latestTurn)
    if (event === undefined) return
    try {
      runtime.session.append('turn/end', event as never)
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-remote-local: could not close the abandoned turn of %s: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
    }
    this.#setRunning(runtime, false)
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
    runtime.applyingRemote = true
    let mappedSeq: number | undefined
    try {
      if (!isMirrorNoise(event)) {
        mappedSeq = appendRemoteEvent(runtime.session, remapRemoteEvent(event, runtime.remoteToLocalSeq), runtime)
      }
    } finally {
      runtime.applyingRemote = false
    }
    const after = (runtime.session as unknown as { seq: number }).seq
    if (mappedSeq !== undefined) {
      runtime.remoteToLocalSeq.set(event.seq, mappedSeq)
      this.#flushAssistantEnd(runtime, event.seq)
    } else if (after > before) {
      runtime.remoteToLocalSeq.set(event.seq, after - 1)
      this.#flushAssistantEnd(runtime, event.seq)
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { turn?: unknown; step?: unknown }
      if (typeof data.turn === 'number' && typeof data.step === 'number') {
        runtime.durableAssistantSteps.add(`${data.turn}:${data.step}`)
        if (runtime.assistantAttempt?.turn === data.turn && runtime.assistantAttempt.step === data.step) {
          runtime.assistantAttempt.settled = true
        }
      }
    }
    const turn = typeof event.data === 'object' && event.data !== null
      ? (event.data as { turn?: unknown }).turn
      : undefined
    if (typeof turn !== 'number') return
    if (event.type === 'turn/start') {
      runtime.latestTurn = Math.max(runtime.latestTurn, turn)
      this.#setRunning(runtime, true)
      return
    }
    if (event.type !== 'turn/end') return
    runtime.latestTurn = Math.max(runtime.latestTurn, turn)
    if (runtime.awaitingTurn === null || turn >= runtime.awaitingTurn) {
      runtime.awaitingTurn = null
      runtime.awaitingStarted = false
      this.#setRunning(runtime, false)
      const reason = typeof event.data === 'object' && event.data !== null
        ? (event.data as { reason?: { kind?: unknown } }).reason?.kind
        : undefined
      if (reason === 'aborted') {
        runtime.agent.inbox.clear()
      } else if (runtime.agent.inbox.hasPending) {
        const next = runtime.agent.inbox.nextTurn[0]
        if (next !== undefined) {
          runtime.agent.inbox.remove(messageIdentity(next))
          this.prompt(runtime, next, 'queue')
        }
      }
    }
  }

  #onLocalSessionEvent(session: Session, event: SessionEvent): void {
    const candidate = event as unknown as { type?: string; data?: unknown }
    if (candidate.type !== 'model/selection' && candidate.type !== 'sandbox/mode') return
    const runtime = [...this.#runtimes.values()].find(item => item.session.id === session.id)
    if (runtime === undefined || runtime.stopped || runtime.applyingRemote) return
    if (candidate.type === 'sandbox/mode') {
      const mode = (candidate.data as { mode?: unknown }).mode
      if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') return
      void this.#hosts.setSandboxMode(runtime.record.hostId, runtime.record.remoteSessionId, mode).catch(error => {
        runtime.lastError = error instanceof Error ? error.message : String(error)
        this.#ctx.logger.warn('dsh-remote-local: remote sandbox mode failed: %s', runtime.lastError)
      })
      return
    }
    const record = candidate.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return
    const selection = {
      provider: record.provider,
      model: record.model,
      ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
    }
    Object.assign(runtime.agent.options, selection)
    void this.#hosts.selectModel(runtime.record.hostId, runtime.record.remoteSessionId, selection).catch(error => {
      runtime.lastError = error instanceof Error ? error.message : String(error)
      this.#ctx.logger.warn('dsh-remote-local: remote model selection failed: %s', runtime.lastError)
    })
  }

  #localSandboxMode(session: Session): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
    const projections = this.#ctx.get('sessionProjections') as unknown as {
      stateOf?: (session: Session, key: string) => unknown
    } | undefined
    const mode = projections?.stateOf?.(session, 'sandboxMode')
    return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
      ? mode
      : undefined
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
          runtime.awaitingStarted = true
          this.#setRunning(runtime, true)
          const start = frame as RemoteAssistantFrame & { startedAfterSeq?: number }
          const startedAfterSeq = typeof start.startedAfterSeq === 'number'
            ? runtime.remoteToLocalSeq.get(start.startedAfterSeq) ?? Math.max(0, runtime.session.seq - 1)
            : Math.max(0, runtime.session.seq - 1)
          runtime.assistantAttempt = {
            attemptId: start.attemptId,
            revision: start.revision,
            turn: start.turn ?? runtime.latestTurn,
            step: start.step ?? 0,
            index: 0,
            ended: false,
            settled: false,
            emitted: false,
          }
          const stepKey = `${runtime.assistantAttempt.turn}:${runtime.assistantAttempt.step}`
          if (runtime.durableAssistantSteps.has(stepKey)) {
            runtime.assistantAttempt.settled = true
            continue
          }
          runtime.assistantAttempt.emitted = true
          this.#emitAssistant(runtime, { ...start, startedAfterSeq } as RemoteAssistantFrame)
          continue
        }
        if (frame.type === 'chunk') {
          // Transient tool-call cards are completed by the durable assistant
          // message + tool/result pair. Forwarding partial tool-call chunks
          // leaves a second card stuck in "preparing" when the durable
          // settlement replaces only the first one.
          const chunkType = (frame.chunk as { type?: unknown } | undefined)?.type
          if (chunkType !== 'tool-call-delta') {
            const attempt = runtime.assistantAttempt
            if (attempt === undefined) {
              this.#emitAssistant(runtime, frame)
              continue
            }
            if (!attempt.emitted || attempt.settled) continue
            const forwarded = { ...frame, index: attempt.index } as RemoteAssistantFrame
            attempt.index += 1
            this.#emitAssistant(runtime, forwarded)
          }
          continue
        }
        const outcome = frame.outcome
        if (outcome === undefined) return
        let endFrame = frame
        if (runtime.assistantAttempt?.attemptId === frame.attemptId) {
          if (runtime.assistantAttempt.ended) continue
          if (!runtime.assistantAttempt.emitted) continue
          runtime.assistantAttempt.ended = true
          endFrame = { ...frame, index: runtime.assistantAttempt.index } as RemoteAssistantFrame
        }
        if (outcome.kind !== 'committed') {
          this.#emitAssistant(runtime, endFrame)
          continue
        }
        const localSeq = runtime.remoteToLocalSeq.get(outcome.seq)
        if (localSeq === undefined) {
          runtime.pendingAssistantEnds.set(outcome.seq, endFrame)
          continue
        }
        this.#emitAssistant(runtime, {
          ...endFrame,
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
    try {
      const emit = this.#ctx.emit as unknown as (name: string, payload: unknown) => void
      emit.call(this.#ctx, 'agent/status', {
        agent: runtime.agent,
        status: running ? 'running' : 'idle',
      })
    } catch (error) {
      this.#ctx.logger.warn(
        'dsh-remote-local: local agent status %s failed: %s',
        runtime.record.remoteSessionId,
        String(error),
      )
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

function remapRemoteEvent(
  event: RemoteSessionEvent,
  remoteToLocal: ReadonlyMap<number, number>,
): RemoteSessionEvent {
  // Remote replacement ranges are defined in the remote log's sequence space.
  // A mirror can omit events (prefix trimming, local-only optimistic messages,
  // non-surface events), so replaying the original replacement can target a
  // node that is no longer the current local surface. Append the replacement as
  // a fresh surface event instead of risking the whole history projection.
  const hadReplacement = typeof event.surfaceOp === 'object'
  const sourceEventSeqs = hadReplacement
    ? undefined
    : event.sourceEventSeqs
      ?.map(seq => remoteToLocal.get(seq))
      .filter((seq): seq is number => seq !== undefined)
  return {
    ...event,
    ...sourceEventSeqs === undefined || sourceEventSeqs.length === 0 ? {} : { sourceEventSeqs },
    ...hadReplacement ? { surfaceOp: 'append' as const } : event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp },
  } as RemoteSessionEvent
}

function isMirrorNoise(event: RemoteSessionEvent): boolean {
  // Inbox splices are projections of remote pending input, and compaction
  // events describe the remote context window, not the conversation. Neither
  // has a local counterpart.
  if (event.type === 'agent/inbox/spliced' || event.type.startsWith('compaction/')) return true
  // Remote DSH injects context as user/message events with non-human sources
  // (compaction checkpoint, instructions, runtime context, skill catalog).
  // Replaying those into the local transcript corrupts its prompts and can
  // stall the mirror on a large synthetic message.
  if (event.type === 'user/message') {
    const source = (event.data as { source?: { kind?: unknown } }).source
    return source?.kind !== 'user'
  }
  return false
}

function appendRemoteEvent(
  session: Session,
  event: RemoteSessionEvent,
  runtime: MirrorRuntime,
): number | undefined {
  // The remote user message carries the remote request id. Reuse the local
  // optimistic message instead so the client settles its pending submission,
  // and keep the remote event's position in the turn.
  if (event.type === 'user/message' && runtime.pendingUsers.length > 0) {
    const source = (event.data as { source?: { kind?: unknown } }).source
    if (source?.kind === 'user') {
      const pending = runtime.pendingUsers.shift()
      if (pending !== undefined && pending.localSeq >= 0) return pending.localSeq
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
  return undefined
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
  // A seeded tail may start in the middle of a replacement chain. Replaying a
  // remote replacement can then target a node that was dropped with the prefix
  // and poison the whole local surface projection. Seed every result as its own
  // surface append instead.
  const hadReplacement = typeof event.surfaceOp === 'object'
  const surfaceOp = event.surfaceOp === undefined || hadReplacement ? (hadReplacement ? 'append' : undefined) : event.surfaceOp
  const sourceEventSeqs = hadReplacement
    ? undefined
    : event.sourceEventSeqs
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

function latestRemoteSandboxMode(events: readonly RemoteSessionEvent[]): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'sandbox/mode') continue
    const mode = (event.data as { mode?: unknown }).mode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
  }
  return undefined
}

function promptParts(message: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown; name?: string }> {
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown; name?: string }> = []
  for (const part of content) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') parts.push({ type: 'text', text })
      continue
    }
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image') {
      const attachment = (part as { attachment?: unknown }).attachment
      if (attachment === undefined) continue
      const name = (attachment as { name?: unknown }).name
      parts.push({ type: 'image', attachment, ...typeof name === 'string' ? { name } : {} })
    }
  }
  return parts
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
