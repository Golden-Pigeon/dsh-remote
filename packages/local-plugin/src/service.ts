/**
 * Host registry + tunnel lifecycle service.
 *
 * One instance owns every configured remote host, at most one SSH tunnel per
 * host, the remote agent client, health checks, and bounded reconnection with
 * exponential backoff. The browser and agent tools only ever see
 * {@link HostView}; tokens stay in this process.
 *
 * @module dsh-remote-local/service
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  type AcceptedResult,
  type ApprovalOutcome,
  type RemoteApprovalFrame,
  type RemoteAssistantFrame,
  type CreateSessionRequest,
  type CreateSessionResult,
  type CreateWorkspaceRequest,
  isAgentLive,
  type HostInfo,
  type ListSessionsResult,
  type ListWorkspacesResult,
  type PromptDeliveryMode,
  type RemoteWorkspace,
  type SessionSnapshot,
  type SessionStreamFrame,
  type WebUrlResult,
} from '@dsh-remote/protocol'
import type { ResolvedConfig } from './config.ts'
import { ModelCredentialProxy, type CredentialProxyAddress } from './credentials/proxy.ts'
import { LocalError, asLocalError } from './errors.ts'
import { hostIdFor } from './hosts/id.ts'
import { HostStore } from './hosts/store.ts'
import {
  idleRuntime,
  toHostView,
  type AddHostInput,
  type HostRecord,
  type HostRuntime,
  type HostView,
} from './hosts/types.ts'
import { RemoteProvisioner, agentVersionIsOlder, bundledAgentVersion } from './remote/provisioner.ts'
import { uiForErrorCode } from './messages.ts'
import { discoverAgent } from './ssh/probe.ts'
import { restartRemoteAgent } from './remote/restart.ts'
import { parseSshTarget, validateHostLabel, type ParsedSshTarget } from './ssh/target.ts'
import { Tunnel } from './ssh/tunnel.ts'
import { dshUpdateFor, resolveLocalDshVersion } from './version.ts'

function fingerprintKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Explicit workspace add, after the remote registration succeeded. @mode parallel */
    'dsh-remote/workspace-added'(hostId: string, workspace: RemoteWorkspace): Promise<void>
  }
}

/** Snapshot returned to the Settings page. */
export interface HostsState {
  readonly protocolVersion: number
  readonly hosts: readonly HostView[]
}

/** Connected resources for one host. */
interface Connected {
  readonly record: HostRecord
  readonly target: ParsedSshTarget
  readonly tunnel: Tunnel
  readonly client: RemoteAgentClient
}

/** Constructor inputs beyond config. */
export interface RemoteHostsServiceOptions {
  /** Resolve the local provider key at connect time; never cached in the view. */
  readonly resolveModelKey?: () => Promise<string | undefined>
  /** Override the hosting DSH version; tests inject it instead of the runtime. */
  readonly localDshVersion?: string
}

/** One host registry service. */
export class RemoteHostsService {
  readonly ctx: Context
  readonly config: ResolvedConfig

  readonly #store: HostStore
  readonly #provisioner: RemoteProvisioner
  readonly #resolveModelKey: (() => Promise<string | undefined>) | undefined
  readonly #localDshVersion: string | undefined
  #proxy: ModelCredentialProxy | undefined
  #proxyAddress: CredentialProxyAddress | undefined
  #directModel: { readonly baseUrl: string; readonly apiKey: string } | undefined
  #directModelAttempted = false
  readonly #modelReconciled = new Set<string>()
  readonly #records = new Map<string, HostRecord>()
  readonly #runtime = new Map<string, HostRuntime>()
  readonly #tunnels = new Map<string, Tunnel>()
  readonly #clients = new Map<string, RemoteAgentClient>()
  readonly #connectPromises = new Map<string, Promise<HostView>>()
  readonly #healthTimers = new Map<string, NodeJS.Timeout>()
  readonly #reconnectTimers = new Map<string, NodeJS.Timeout>()
  readonly #healthInFlight = new Set<string>()
  readonly #attempts = new Map<string, number>()
  readonly #manualDisconnect = new Set<string>()
  readonly #upgrades = new Set<string>()
  #disposed = false

  constructor(ctx: Context, config: ResolvedConfig, options: RemoteHostsServiceOptions = {}) {
    this.ctx = ctx
    this.config = config
    this.#store = new HostStore(`${config.stateDir}/hosts.json`)
    this.#provisioner = new RemoteProvisioner(config)
    this.#resolveModelKey = options.resolveModelKey
    this.#localDshVersion = options.localDshVersion ?? resolveLocalDshVersion()
  }

  /** Load the registry and auto-connect opted-in hosts. */
  async start(): Promise<void> {
    const loaded = await this.#store.load()
    for (const warning of loaded.warnings) this.ctx.logger.warn('dsh-remote: %s', warning)
    for (const record of loaded.hosts) {
      this.#records.set(record.id, record)
      this.#runtime.set(record.id, idleRuntime())
    }
    for (const record of loaded.hosts) {
      if (!record.autoConnect) continue
      this.#manualDisconnect.delete(record.id)
      this.#setRuntime(record.id, { phase: 'idle' })
      void this.connect(record.id).catch(error => {
        this.ctx.logger.warn('dsh-remote: auto-connect %s failed: %s', record.id, String(error))
      })
    }
  }

  /** Browser/tool snapshot. */
  state(): HostsState {
    return { protocolVersion: PROTOCOL_VERSION, hosts: this.list() }
  }

  /** All hosts in creation order. */
  list(): HostView[] {
    return [...this.#records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(record => this.view(record.id))
  }

  /** One host view. */
  view(id: string): HostView {
    const record = this.#requireRecord(id)
    return toHostView(record, this.#runtime.get(id) ?? idleRuntime())
  }

  /** Parse a destination without touching SSH. */
  validateTarget(raw: string): { canonical: string; host: string; user: string | null; port: number | null } {
    const target = parseSshTarget(raw)
    return { canonical: target.canonical, host: target.host, user: target.user, port: target.port }
  }

  /** Register a host and (by default) start connecting in the background. */
  async add(input: AddHostInput): Promise<HostView> {
    this.#assertAlive()
    const target = parseSshTarget(input.sshTarget)
    if (this.#records.has(hostIdFor(target.canonical, input.label))) {
      throw new LocalError('host/duplicate', `host ${target.canonical} already exists`)
    }
    if ([...this.#records.values()].some(record => record.sshTarget === target.canonical)) {
      throw new LocalError('host/duplicate', `host ${target.canonical} already exists`)
    }
    if (input.token !== undefined && input.token.trim() !== '' && input.token.trim().length < 16) {
      throw new LocalError('host/invalid', 'agent token must be at least 16 characters')
    }
    if (input.remoteAgentPort !== undefined
      && (!Number.isInteger(input.remoteAgentPort) || input.remoteAgentPort < 1 || input.remoteAgentPort > 65_535)) {
      throw new LocalError('host/invalid', 'remote agent port must be between 1 and 65535')
    }

    const label = validateHostLabel(input.label ?? target.host)
    const now = new Date().toISOString()
    const record: HostRecord = {
      id: hostIdFor(target.canonical, label),
      label,
      sshTarget: target.canonical,
      sshPort: target.port,
      remoteAgentPort: input.remoteAgentPort ?? null,
      token: input.token === undefined || input.token.trim() === '' ? null : input.token.trim(),
      autoConnect: input.autoConnect ?? true,
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.add(record)
    this.#records.set(record.id, record)
    this.#runtime.set(record.id, idleRuntime())
    this.#manualDisconnect.delete(record.id)

    if (record.autoConnect) {
      this.#setRuntime(record.id, { phase: 'discovering' })
      void this.connect(record.id).catch(error => {
        this.ctx.logger.warn('dsh-remote: connect %s failed: %s', record.id, String(error))
      })
    }
    return this.view(record.id)
  }

  /** Remove a host and tear down its tunnel. */
  async remove(id: string): Promise<void> {
    this.#assertAlive()
    this.#requireRecord(id)
    this.#manualDisconnect.add(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    await this.#store.remove(id)
    this.#records.delete(id)
    this.#runtime.delete(id)
    this.#attempts.delete(id)
    this.#manualDisconnect.delete(id)
  }

  /** Connect one host, waiting for discovery, tunnel, and health. */
  async connect(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    const existing = this.#connectPromises.get(id)
    if (existing !== undefined) return existing
    const promise = this.#doConnect(id).finally(() => {
      this.#connectPromises.delete(id)
    })
    this.#connectPromises.set(id, promise)
    return promise
  }

  /** Disconnect one host and suppress automatic reconnection. */
  async disconnect(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    this.#manualDisconnect.add(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    this.#attempts.delete(id)
    this.#setRuntime(id, {
      phase: 'disconnected',
      localPort: null,
      localUrl: null,
      hostInfo: null,
      workspaceCount: null,
      error: null,
      errorCode: null,
      errorUi: null,
      agentOutdated: false,
      connectedAt: null,
    })
    return this.view(id)
  }

  /** Re-discover the remote agent; reconnect when its port or token changed. */
  async refresh(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const connected = this.#connected(id)
    if (connected === undefined) return this.connect(id)

    const target = parseSshTarget(record.sshTarget)
    const discovery = await this.#discover(target)
    if (discovery.state.port !== record.remoteAgentPort || discovery.state.token !== record.token) {
      await this.#saveRecord(id, {
        remoteAgentPort: discovery.state.port,
        token: discovery.state.token,
      })
      return this.connect(id)
    }
    const health = await connected.client.health()
    this.#setConnected(id, health)
    return this.view(id)
  }

  /** Force a fresh remote install/restart, then reconnect. */
  async provision(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const target = parseSshTarget(record.sshTarget)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    const proxy = await this.#ensureModelProxy()
    const proxyToken = proxy === undefined ? undefined : await this.#ensureProxyToken(id)
    const direct = proxy === undefined ? await this.#ensureDirectModel() : undefined
    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'installing',
      modelProxy: proxy !== undefined,
      modelDirect: direct !== undefined,
      detail: 'preparing',
    })
    try {
      await this.#provisioner.ensureInstalled(target, {
        ...this.#modelEnvironment(proxy, proxyToken, direct),
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
    } catch (error) {
      const failure = this.#markError(id, error, 'agent/unavailable')
      this.#scheduleReconnect(id)
      throw failure
    }
    return this.connect(id)
  }

  /** Start a manual remote DSH upgrade to the local runtime version. */
  async upgrade(id: string): Promise<HostView> {
    this.#assertAlive()
    this.#requireRecord(id)
    const localVersion = this.#localDshVersion
    if (localVersion === undefined) {
      throw new LocalError('agent/unavailable', '无法确定本地 DSH 版本，无法更新远端 DSH')
    }
    if (this.#upgrades.has(id)) return this.view(id)
    this.#upgrades.add(id)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'installing',
      detail: 'dshUpdating',
    })
    void this.#runUpgrade(id, localVersion).catch(error => {
      // The task itself reports expected failures through the host runtime;
      // log anything unexpected without rejecting the Settings action.
      this.ctx.logger.warn('dsh-remote: upgrade task for %s failed: %s', id, String(error))
    }).finally(() => {
      this.#upgrades.delete(id)
    })
    return this.view(id)
  }

  async #runUpgrade(id: string, localVersion: string): Promise<void> {
    try {
      const record = this.#requireRecord(id)
      const target = parseSshTarget(record.sshTarget)
      await this.#stopTransport(id)
      const proxy = await this.#ensureModelProxy()
      const proxyToken = proxy === undefined ? undefined : await this.#ensureProxyToken(id)
      const direct = proxy === undefined ? await this.#ensureDirectModel() : undefined
      this.#setRuntime(id, {
        ...this.#runtimeFor(id),
        modelProxy: proxy !== undefined,
        modelDirect: direct !== undefined,
      })
      await this.#provisioner.ensureInstalled(target, {
        ...this.#modelEnvironment(proxy, proxyToken, direct),
        dshVersion: localVersion,
        upgrade: true,
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
      // The upgraded service may still be binding its listener when the first
      // health check runs; retry briefly instead of surfacing a transient error.
      const deadline = Date.now() + 60_000
      let lastError: unknown
      while (Date.now() < deadline) {
        try {
          await this.connect(id)
          return
        } catch (error) {
          lastError = error
          await new Promise(resolve => setTimeout(resolve, 1_500))
        }
      }
      // The upgrade itself succeeded; leave reconnection to the normal health
      // loop instead of reporting an action failure.
      this.ctx.logger.warn('dsh-remote: upgrade of %s is waiting to reconnect: %s', id, String(lastError))
    } catch (error) {
      this.#markError(id, error, 'agent/unavailable')
      this.#scheduleReconnect(id)
    }
  }

  /** Restart the remote DSH service and reconnect without reinstalling. */
  async restart(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    const target = parseSshTarget(record.sshTarget)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      localPort: null,
      localUrl: null,
      hostInfo: null,
      connectedAt: null,
      error: null,
      errorCode: null,
      detail: 'restarting',
      dshUpdate: null,
      retry: null,
    })
    try {
      await restartRemoteAgent(target, {
        sshBinary: this.config.sshBinary,
        strictHostKeyChecking: this.config.strictHostKeyChecking,
      })
    } catch (error) {
      const failure = this.#markError(id, error, 'agent/unavailable')
      throw failure
    }

    const deadline = Date.now() + 90_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const discovery = await this.#discover(target)
        if (isAgentLive(discovery.state)) {
          await this.#saveRecord(id, {
            remoteAgentPort: discovery.state.port,
            token: discovery.state.token,
          })
          return this.connect(id)
        }
      } catch (error) {
        lastError = error
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    const failure = new LocalError('agent/unavailable', '远端 DSH 重启后未能在 90 秒内就绪', {
      details: {
        host: target.canonical,
        reason: lastError instanceof Error ? lastError.message : String(lastError ?? 'state file not ready'),
      },
      retryable: true,
    })
    throw this.#markError(id, failure, 'agent/unavailable')
  }

  /** List remote workspaces. */
  async workspaces(id: string): Promise<readonly RemoteWorkspace[]> {
    const client = this.#requireClient(id)
    try {
      const workspaces = await client.listWorkspaces()
      this.#setRuntime(id, { workspaceCount: workspaces.length, error: null, errorCode: null, errorUi: null })
      return workspaces
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** List remote sessions, optionally within one workspace. */
  async sessions(
    id: string,
    workspaceId?: string,
    includeSubagents = false,
  ): Promise<ListSessionsResult> {
    const client = this.#requireClient(id)
    try {
      const sessions = await client.listSessions(workspaceId)
      return {
        sessions: includeSubagents
          ? sessions
          : sessions.filter(session => session.origin !== 'subagent'),
      }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Set the file-effect sandbox mode for one remote session. */
  async setSandboxMode(
    id: string,
    sessionId: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  ): Promise<void> {
    const client = this.#requireClient(id)
    try {
      await client.setSandboxMode(sessionId, { mode })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Follow a live remote session from a cursor as an SSE-backed stream. */
  async *followSessionEvents(
    id: string,
    sessionId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncGenerator<SessionStreamFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followSession(sessionId, cursor, signal)
    } catch (error) {
      if (signal.aborted) return
      throw this.#remoteFailure(id, error)
    }
  }

  /** Read one session snapshot. */
  async snapshot(id: string, sessionId: string, limit?: number): Promise<SessionSnapshot> {
    const client = this.#requireClient(id)
    try {
      return await client.snapshotSession(sessionId, limit === undefined ? {} : { limit })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Follow dense remote Assistant frames for one live Session. */
  async *followAssistantFrames(
    id: string,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteAssistantFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followAssistantFrames(sessionId, signal)
    } catch (error) {
      if (signal.aborted) return
      throw this.#remoteFailure(id, error)
    }
  }

  /** Register a remote workspace. */
  async createWorkspace(id: string, request: CreateWorkspaceRequest): Promise<RemoteWorkspace> {
    const client = this.#requireClient(id)
    let workspace: RemoteWorkspace
    try {
      workspace = await client.createWorkspace(request)
      this.#setRuntime(id, { workspaceCount: (this.#runtimeFor(id).workspaceCount ?? 0) + 1 })
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
    await this.ctx.parallel('dsh-remote/workspace-added', id, workspace)
    return workspace
  }

  /** Create a remote session. */
  async createSession(id: string, request: CreateSessionRequest): Promise<CreateSessionResult> {
    const client = this.#requireClient(id)
    try {
      return await client.createSession(request)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Install a model/reasoning-effort selection on a remote session. */
  async selectModel(
    id: string,
    sessionId: string,
    selection: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<void> {
    const client = this.#requireClient(id)
    try {
      await client.selectModel(sessionId, selection)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Send a prompt to a remote session. */
  async promptSession(
    id: string,
    sessionId: string,
    text: string,
    mode?: PromptDeliveryMode,
    selection?: { provider: string; model: string; reasoningEffort?: string },
    content?: readonly import('@dsh-remote/protocol').PromptContentPart[],
  ): Promise<AcceptedResult> {
    const client = this.#requireClient(id)
    try {
      await client.promptSession(sessionId, {
        text,
        ...mode === undefined ? {} : { mode },
        ...content === undefined ? {} : { content },
        ...selection === undefined ? {} : selection,
      })
      return { accepted: true }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Cancel a remote session's active turn. */
  async cancelSession(id: string, sessionId: string): Promise<AcceptedResult> {
    const client = this.#requireClient(id)
    try {
      await client.cancelSession(sessionId)
      return { accepted: true }
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Connected agent client for auxiliary remote adapters. */
  agentFor(id: string): import('@dsh-remote/protocol').RemoteAgentClient {
    return this.#requireClient(id)
  }

  /** Whether the connected agent advertises one capability. */
  supportsAgent(id: string, capability: import('@dsh-remote/protocol').AgentCapability): boolean {
    return this.#runtimeFor(id).hostInfo?.capabilities.includes(capability) === true
  }

  /** Follow remote approval questions for one host. */
  async *followApprovals(id: string, signal: AbortSignal): AsyncGenerator<RemoteApprovalFrame> {
    const client = this.#requireClient(id)
    try {
      yield* client.followApprovals(signal)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Send one approval answer to the remote agent. */
  async answerApproval(id: string, approvalId: string, outcome: ApprovalOutcome): Promise<AcceptedResult> {
    const client = this.#requireClient(id)
    try {
      return await client.answerApproval(approvalId, outcome)
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
  }

  /** Resolve the remote Web UI behind this host's tunnel. */
  async webUrl(id: string): Promise<{ url: string }> {
    const client = this.#requireClient(id)
    const connected = this.#connected(id)
    if (connected === undefined) throw new LocalError('host/not-connected', `host ${id} is not connected`)
    let path: WebUrlResult
    try {
      path = await client.webUrl()
    } catch (error) {
      throw this.#remoteFailure(id, error)
    }
    return { url: `${connected.tunnel.localUrl}${path.path}` }
  }

  /** Stop every tunnel and timer. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const id of [...this.#healthTimers.keys()]) this.#clearHealth(id)
    for (const id of [...this.#reconnectTimers.keys()]) this.#clearReconnect(id)
    await Promise.all([...this.#tunnels.keys()].map(id => this.#stopTransport(id)))
    await this.#proxy?.stop()
    this.#proxy = undefined
    this.#proxyAddress = undefined
    this.#directModel = undefined
    this.#directModelAttempted = false
    this.#records.clear()
    this.#runtime.clear()
    this.#connectPromises.clear()
  }

  async #doConnect(id: string): Promise<HostView> {
    this.#assertAlive()
    const record = this.#requireRecord(id)
    this.#manualDisconnect.delete(id)
    this.#clearReconnect(id)
    await this.#stopTransport(id)

    this.#setRuntime(id, {
      ...idleRuntime(),
      phase: 'discovering',
      detail: 'discovering',
    })

    const target = parseSshTarget(record.sshTarget)
    const proxy = await this.#ensureModelProxy()
    const proxyToken = proxy === undefined ? undefined : await this.#ensureProxyToken(id)
    const direct = proxy === undefined ? await this.#ensureDirectModel() : undefined
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      modelProxy: proxy !== undefined,
      modelDirect: direct !== undefined,
    })
    const reverseForward = proxy === undefined
      ? undefined
      : { remotePort: this.config.credentialProxyRemotePort, localPort: proxy.port }

    let remotePort = record.remoteAgentPort
    let token = record.token
    try {
      const discovery = await this.#discover(target)
      remotePort = discovery.state.port
      token = discovery.state.token
      if (remotePort === null) {
        throw new LocalError('agent/unavailable', 'remote agent has no active listener port')
      }
      await this.#saveRecord(id, { remoteAgentPort: remotePort, token })
    } catch (error) {
      const failure = asLocalError(error, 'ssh/probe-failed')
      if (this.config.autoProvision && failure.code === 'agent/unavailable') {
        this.#setRuntime(id, {
          ...this.#runtimeFor(id),
          phase: 'installing',
          error: null,
          errorCode: null,
          retry: null,
          detail: 'autoProvisioning',
        })
        try {
          await this.#provisioner.ensureInstalled(target, {
            ...this.#modelEnvironment(proxy, proxyToken, direct),
            onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
          })
          this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'readingState' })
          const discovery = await this.#discover(target)
          remotePort = discovery.state.port
          token = discovery.state.token
          await this.#saveRecord(id, { remoteAgentPort: remotePort, token })
        } catch (provisionError) {
          const provisionFailure = this.#markError(id, provisionError, 'agent/unavailable')
          this.#scheduleReconnect(id)
          throw provisionFailure
        }
      } else if (token !== null && remotePort !== null) {
        this.ctx.logger.warn(
          'dsh-remote: discovery for %s failed; using cached port %s: %s',
          id,
          String(remotePort),
          String(error),
        )
      } else {
        const marked = this.#markError(id, error, failure.code)
        this.#scheduleReconnect(id)
        throw marked
      }
    }

    if (remotePort === null || token === null) {
      const failure = this.#markError(
        id,
        new LocalError('agent/unavailable', 'no remote agent token or port is available'),
        'agent/unavailable',
      )
      this.#scheduleReconnect(id)
      throw failure
    }

    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      detail: 'connecting',
    })

    this.#setRuntime(id, { ...this.#runtimeFor(id), phase: 'connecting', detail: 'tunnel' })
    let tunnel: Tunnel | undefined
    let stage: 'tunnel' | 'health' = 'tunnel'
    try {
      tunnel = await Tunnel.start({
        sshBinary: this.config.sshBinary,
        target,
        remotePort,
        connectTimeoutMs: this.config.connectTimeoutMs,
        strictHostKeyChecking: this.config.strictHostKeyChecking,
        ...reverseForward === undefined ? {} : { reverseForward },
        onExit: info => this.#onTunnelExit(id, info),
      })
      stage = 'health'
      const client = new RemoteAgentClient({
        baseUrl: tunnel.localUrl,
        token,
        hostId: id,
      })
      this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'checkingAgent' })
      const health = await client.health()
      if (await this.#reconcileModelEnvironment(id, target, health, proxy, proxyToken, direct, tunnel)) {
        return this.#doConnect(id)
      }
      this.#tunnels.set(id, tunnel)
      this.#clients.set(id, client)
      this.#setConnected(id, health)
      this.#startHealthTimer(id)
      this.#attempts.delete(id)
      return this.view(id)
    } catch (error) {
      await tunnel?.stop()
      const failure = stage === 'health'
        ? this.#markError(id, new LocalError(
          'host/connect-failed',
          `远端 agent 健康检查失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error, ui: { key: 'error.healthCheckFailed' } },
        ), 'host/connect-failed')
        : this.#markError(id, error, 'host/connect-failed')
      this.#scheduleReconnect(id)
      throw failure
    }
  }

  async #reconcileModelEnvironment(
    id: string,
    target: ParsedSshTarget,
    health: { readonly modelBaseUrl?: string | null; readonly modelKeyConfigured?: boolean; readonly modelKeyFingerprint?: string | null },
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
    tunnel: Tunnel,
  ): Promise<boolean> {
    const desired = proxy === undefined
      ? direct?.baseUrl
      : `http://127.0.0.1:${this.config.credentialProxyRemotePort}`
    if (desired === undefined) return false
    const current = health.modelBaseUrl?.replace(/\/+$/u, '') ?? null
    const expectedKey = proxy === undefined ? direct?.apiKey : proxyToken
    const matches = current === desired.replace(/\/+$/u, '')
      && expectedKey !== undefined
      && health.modelKeyFingerprint === fingerprintKey(expectedKey)
    if (matches) {
      this.#modelReconciled.delete(id)
      return false
    }
    if (this.#modelReconciled.has(id) || !this.config.autoProvision) {
      this.ctx.logger.warn(
        'dsh-remote: model environment for %s still differs from this profile (%s vs %s)',
        id,
        current ?? 'unset',
        desired,
      )
      return false
    }
    this.#modelReconciled.add(id)
    this.#setRuntime(id, { ...this.#runtimeFor(id), detail: 'reconcilingModel' })
    this.ctx.logger.warn(
      'dsh-remote: remote model environment for %s is %s, expected %s; reinstalling',
      id,
      current ?? 'unset',
      desired,
    )
    await tunnel.stop()
    try {
      await this.#provisioner.ensureInstalled(target, {
        ...this.#modelEnvironment(proxy, proxyToken, direct),
        onProgress: detail => this.#setRuntime(id, { ...this.#runtimeFor(id), detail }),
      })
    } catch (error) {
      this.#modelReconciled.delete(id)
      throw error
    }
    return true
  }

  async #ensureDirectModel(): Promise<{ readonly baseUrl: string; readonly apiKey: string } | undefined> {
    if (this.config.credentialProxy || !this.config.copyModelKey) return undefined
    if (this.#directModelAttempted) return this.#directModel
    this.#directModelAttempted = true
    let key: string | undefined
    try {
      key = await this.#resolveModelKey?.()
    } catch (error) {
      this.ctx.logger.warn('dsh-remote: could not resolve local model credential: %s', String(error))
      return undefined
    }
    if (key === undefined || key.trim() === '') {
      this.ctx.logger.warn('dsh-remote: no local DEEPSEEK_API_KEY; remote host must use its own credentials')
      return undefined
    }
    this.#directModel = { baseUrl: this.config.remoteModelBaseUrl, apiKey: key }
    return this.#directModel
  }

  #modelEnvironment(
    proxy: CredentialProxyAddress | undefined,
    proxyToken: string | undefined,
    direct: { readonly baseUrl: string; readonly apiKey: string } | undefined,
  ): { modelBaseUrl?: string; modelApiKey?: string } {
    if (proxy !== undefined) {
      if (proxyToken === undefined) throw new LocalError('internal', 'credential proxy token is unavailable')
      return {
        modelBaseUrl: `http://127.0.0.1:${this.config.credentialProxyRemotePort}`,
        modelApiKey: proxyToken,
      }
    }
    if (direct !== undefined) return { modelBaseUrl: direct.baseUrl, modelApiKey: direct.apiKey }
    return {}
  }

  async #ensureProxyToken(id: string): Promise<string> {
    const record = this.#requireRecord(id)
    if (typeof record.proxyToken === 'string' && record.proxyToken.length >= 16) return record.proxyToken
    const token = randomBytes(32).toString('hex')
    await this.#saveRecord(id, { proxyToken: token })
    return token
  }

  #isProxyToken(token: string): boolean {
    const presented = Buffer.from(token, 'utf8')
    for (const record of this.#records.values()) {
      const expected = record.proxyToken
      if (typeof expected !== 'string') continue
      const candidate = Buffer.from(expected, 'utf8')
      if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) return true
    }
    return false
  }

  async #ensureModelProxy(): Promise<CredentialProxyAddress | undefined> {
    if (!this.config.credentialProxy) return undefined
    if (this.#proxyAddress !== undefined) return this.#proxyAddress
    let key: string | undefined
    try {
      key = await this.#resolveModelKey?.()
    } catch (error) {
      this.ctx.logger.warn('dsh-remote: could not resolve local model credential: %s', String(error))
      return undefined
    }
    if (key === undefined || key.trim() === '') {
      this.ctx.logger.warn('dsh-remote: no local DEEPSEEK_API_KEY; remote host must use its own credentials')
      return undefined
    }
    try {
      const proxy = new ModelCredentialProxy({
        apiKey: key,
        upstreamBaseUrl: this.config.credentialProxyUpstream,
        isTokenValid: token => this.#isProxyToken(token),
      })
      const address = await proxy.start()
      this.#proxy = proxy
      this.#proxyAddress = address
      return address
    } catch (error) {
      this.ctx.logger.warn('dsh-remote: could not start credential proxy: %s', String(error))
      return undefined
    }
  }

  async #discover(target: ParsedSshTarget) {
    return discoverAgent(target, {
      sshBinary: this.config.sshBinary,
      timeoutMs: this.config.probeTimeoutMs,
      strictHostKeyChecking: this.config.strictHostKeyChecking,
      remoteStateFile: this.config.remoteStateFile,
    })
  }

  #onTunnelExit(id: string, info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void {
    if (this.#disposed || this.#manualDisconnect.has(id)) return
    this.#clients.delete(id)
    this.#tunnels.delete(id)
    this.#clearHealth(id)
    const detail = info.stderr === '' ? '' : `: ${info.stderr.split('\n')[0]}`
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'error',
      localPort: null,
      localUrl: null,
      error: `SSH tunnel exited (code ${String(info.code)}, signal ${String(info.signal)})${detail}`,
      errorCode: 'ssh/tunnel-failed',
      errorUi: {
        key: 'error.tunnelExited',
        params: { code: info.code ?? 'null', signal: info.signal ?? 'null' },
      },
      agentOutdated: false,
      detail: 'reconnecting',
    })
    this.#scheduleReconnect(id)
  }

  #startHealthTimer(id: string): void {
    this.#clearHealth(id)
    const timer = setInterval(() => {
      void this.#healthCheck(id)
    }, this.config.healthIntervalMs)
    timer.unref?.()
    this.#healthTimers.set(id, timer)
  }

  async #healthCheck(id: string): Promise<void> {
    if (this.#disposed || this.#healthInFlight.has(id)) return
    const client = this.#clients.get(id)
    if (client === undefined) return
    this.#healthInFlight.add(id)
    try {
      const health = await client.health()
      this.#setConnected(id, health)
    } catch (error) {
      this.ctx.logger.warn('dsh-remote: health check %s failed: %s', id, String(error))
      const connected = this.#connected(id)
      await connected?.tunnel.stop()
      this.#tunnels.delete(id)
      this.#clients.delete(id)
      this.#clearHealth(id)
      this.#markError(id, new LocalError(
        'agent/unavailable',
        `远端 agent 健康检查失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error, ui: { key: 'error.healthCheckFailed' } },
      ), 'agent/unavailable')
      this.#scheduleReconnect(id)
    } finally {
      this.#healthInFlight.delete(id)
    }
  }

  #scheduleReconnect(id: string): void {
    if (this.#disposed || !this.config.reconnect || this.#manualDisconnect.has(id)) return
    if (this.#reconnectTimers.has(id)) return
    if (!this.#records.has(id)) return
    const attempt = (this.#attempts.get(id) ?? 0) + 1
    this.#attempts.set(id, attempt)
    const delay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 10), this.config.maxReconnectDelayMs)
    this.ctx.logger.info('dsh-remote: reconnecting %s in %dms (attempt %d)', id, delay, attempt)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'connecting',
      retry: { attempt, delayMs: delay, at: Date.now() + delay },
      detail: 'retrying',
    })
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(id)
      void this.connect(id).catch(error => {
        this.ctx.logger.warn('dsh-remote: reconnect %s failed: %s', id, String(error))
      })
    }, delay)
    timer.unref?.()
    this.#reconnectTimers.set(id, timer)
  }

  #clearReconnect(id: string): void {
    const timer = this.#reconnectTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.#reconnectTimers.delete(id)
  }

  #clearHealth(id: string): void {
    const timer = this.#healthTimers.get(id)
    if (timer !== undefined) clearInterval(timer)
    this.#healthTimers.delete(id)
  }

  async #stopTransport(id: string): Promise<void> {
    this.#clearHealth(id)
    const tunnel = this.#tunnels.get(id)
    this.#tunnels.delete(id)
    this.#clients.delete(id)
    await tunnel?.stop()
  }

  #requireRecord(id: string): HostRecord {
    const record = this.#records.get(id)
    if (record === undefined) throw new LocalError('host/not-found', `host ${id} does not exist`)
    return record
  }

  #connected(id: string): Connected | undefined {
    const record = this.#records.get(id)
    const tunnel = this.#tunnels.get(id)
    const client = this.#clients.get(id)
    if (record === undefined || tunnel === undefined || client === undefined) return undefined
    return { record, target: parseSshTarget(record.sshTarget), tunnel, client }
  }

  #requireClient(id: string): RemoteAgentClient {
    const client = this.#clients.get(id)
    if (client === undefined || this.#runtime.get(id)?.phase !== 'connected') {
      throw new LocalError('host/not-connected', `host ${id} is not connected; connect it first`)
    }
    return client
  }

  #runtimeFor(id: string): HostRuntime {
    return this.#runtime.get(id) ?? idleRuntime()
  }

  #setRuntime(id: string, patch: Partial<HostRuntime>): void {
    this.#runtime.set(id, { ...this.#runtimeFor(id), ...patch })
  }

  #setConnected(id: string, health: HostInfo): void {
    const existing = this.#connected(id)
    const bundledVersion = bundledAgentVersion()
    this.#setRuntime(id, {
      phase: 'connected',
      localPort: existing?.tunnel.localPort ?? this.#runtimeFor(id).localPort,
      localUrl: existing?.tunnel.localUrl ?? this.#runtimeFor(id).localUrl,
      hostInfo: health,
      workspaceCount: health.workspaceCount,
      error: null,
      errorCode: null,
      errorUi: null,
      connectedAt: this.#runtimeFor(id).connectedAt ?? new Date().toISOString(),
      dshUpdate: this.#dshUpdateFor(health),
      retry: null,
      agentOutdated: !health.capabilities.includes('file.watch')
        || agentVersionIsOlder(health.agentVersion, bundledVersion),
      detail: this.#runtimeFor(id).modelProxy
        ? 'connectedProxy'
        : this.#runtimeFor(id).modelDirect
          ? 'connectedDirect'
          : 'connectedRemote',
    })
  }

  #dshUpdateFor(health: HostInfo): HostRuntime['dshUpdate'] {
    return dshUpdateFor(health.dshVersion, this.#localDshVersion) ?? null
  }

  async #saveRecord(id: string, patch: Partial<HostRecord>): Promise<void> {
    const record = this.#requireRecord(id)
    const next: HostRecord = { ...record, ...patch, id, updatedAt: new Date().toISOString() }
    await this.#store.update(id, next)
    this.#records.set(id, next)
  }

  #markError(id: string, error: unknown, fallback: Parameters<typeof asLocalError>[1]): LocalError {
    const failure = asLocalError(error, fallback)
    this.#setRuntime(id, {
      ...this.#runtimeFor(id),
      phase: 'error',
      localPort: null,
      localUrl: null,
      error: failure.message,
      errorCode: failure.code,
      errorUi: failure.ui ?? uiForErrorCode(failure.code),
      agentOutdated: false,
      // Keep the last progress code so the failure still says which stage failed.
      detail: this.#runtimeFor(id).detail,
      dshUpdate: null,
      retry: null,
    })
    return failure
  }

  #remoteFailure(id: string, error: unknown): LocalError {
    if (error instanceof LocalError) return error
    const failure = error instanceof RemoteProtocolError
      ? new LocalError('agent/error', `remote agent: ${error.message}`, {
        details: { remoteCode: error.code, ...error.details },
        retryable: error.retryable,
        cause: error,
        ui: { key: 'error.agentError' },
      })
      : new LocalError('agent/unavailable', 'remote agent request failed', {
        cause: error,
        ui: { key: 'error.agentUnavailable' },
      })
    // Ordinary remote calls can fail while the host is being installed or
    // reconnected; that transient failure must not replace the install/retry
    // status on the host card with a red "remote agent request failed".
    const phase = this.#runtimeFor(id).phase
    if (phase !== 'installing' && phase !== 'connecting' && phase !== 'discovering') {
      this.#setRuntime(id, {
        error: failure.message,
        errorCode: failure.code,
        errorUi: failure.ui ?? uiForErrorCode(failure.code),
      })
    }
    return failure
  }

  #assertAlive(): void {
    if (this.#disposed) throw new LocalError('internal', 'remote host service is disposed')
  }
}
