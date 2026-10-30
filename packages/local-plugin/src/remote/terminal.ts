/**
 * Remote PTY terminals for mirrored Sessions.
 *
 * The stock terminal controller spawns processes in the local execution
 * environment. For a mirror, this manager talks to the remote agent's PTY API
 * over the existing SSH tunnel and exposes the browser protocol the normal
 * terminal UI consumes.
 *
 * @module dsh-remote-local/remote/terminal
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { TerminalFrame, TerminalInput, TerminalShell, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller'
import type { RemoteAgentClient } from '@dsh-remote/protocol'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'

interface AgentTerminalRecord {
  readonly sessionId: string
  info: WebTerminalInfo
}

/** One host-side terminal manager. */
export class RemoteTerminals {
  #ctx: Context
  #hosts: RemoteHostsService
  #mirrors: RemoteMirrorService
  #terminals = new Map<string, AgentTerminalRecord>()

  constructor(ctx: Context, hosts: RemoteHostsService, mirrors: RemoteMirrorService) {
    this.#ctx = ctx
    this.#hosts = hosts
    this.#mirrors = mirrors
  }

  /** Whether this Session owns a mirrored workspace. */
  isMirrored(sessionId: string): boolean {
    return this.#context(sessionId) !== undefined
  }

  /** Return the remote cwd/limits for one Session. */
  environment(sessionId: string): { cwd: string; maxInputBytes: number; maxBufferedBytes: number; maxCols: number; maxRows: number; scrollback: number } {
    const context = this.#context(sessionId)
    return {
      cwd: context?.remoteRoot ?? '/',
      maxInputBytes: 64 * 1024,
      maxBufferedBytes: 512 * 1024,
      maxCols: 240,
      maxRows: 80,
      scrollback: 4_000,
    }
  }

  /** One remote shell candidate. */
  shells(): TerminalShell[] {
    return [{ path: '/bin/bash', name: 'Remote Bash', args: [] }]
  }

  /** Terminals retained for one Session. */
  async list(sessionId: string): Promise<WebTerminalInfo[]> {
    const context = this.#context(sessionId)
    if (context === undefined) return []
    const live = await this.#client(context.hostId).listTerminals()
    const liveIds = new Set(live.map(info => info.id))
    for (const id of this.#terminals.keys()) {
      if (!liveIds.has(id)) this.#terminals.delete(id)
    }
    for (const info of live) {
      const tracked = this.#terminals.get(info.id)
      if (tracked !== undefined) this.#terminals.set(info.id, { ...tracked, info: info as unknown as WebTerminalInfo })
    }
    return [...this.#terminals.values()]
      .filter(item => item.sessionId === sessionId)
      .map(item => item.info)
  }

  /** Allocate a PTY through the agent API. */
  async create(sessionId: string, request: { id?: string; shellPath?: string; cols?: number; rows?: number }): Promise<WebTerminalInfo> {
    const context = this.#context(sessionId)
    if (context === undefined) throw new LocalError('agent/unavailable', 'terminal is only available for mirrored sessions')
    const id = request.id ?? randomUUID()
    const existing = this.#terminals.get(id)
    if (existing !== undefined) return existing.info
    const info = await this.#client(context.hostId).createTerminal({
      id,
      cwd: context.remoteRoot,
      title: `Remote · ${context.remoteRoot.split('/').at(-1) ?? context.remoteRoot}`,
      ...request.shellPath === undefined ? {} : { shellPath: request.shellPath },
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
    }) as unknown as WebTerminalInfo
    this.#terminals.set(id, { sessionId, info })
    return info
  }

  /** Feed input/resize into one remote PTY. */
  async input(id: string, input: TerminalInput): Promise<void> {
    const record = this.#terminals.get(id)
    if (record === undefined) throw new LocalError('agent/unavailable', `terminal ${id} is unavailable`)
    const context = this.#context(record.sessionId)
    if (context === undefined) throw new LocalError('agent/unavailable', `terminal ${id} is unavailable`)
    await this.#client(context.hostId).terminalInput(id, input.type === 'write'
      ? { type: 'write', data: input.data }
      : { type: 'resize', cols: input.cols, rows: input.rows })
  }

  /** Rename a retained terminal. */
  async rename(id: string, title: string): Promise<void> {
    const record = this.#terminals.get(id)
    if (record === undefined) return
    const context = this.#context(record.sessionId)
    if (context === undefined) return
    await this.#client(context.hostId).renameTerminal(id, title)
    this.#terminals.set(id, { ...record, info: { ...record.info, title } })
  }

  /** Close one terminal. */
  async close(id: string): Promise<void> {
    const record = this.#terminals.get(id)
    if (record === undefined) return
    const context = this.#context(record.sessionId)
    this.#terminals.delete(id)
    if (context !== undefined) await this.#client(context.hostId).closeTerminal(id).catch(() => {})
  }

  /** Stream frames for one attachment. */
  async *attach(id: string, signal: AbortSignal): AsyncGenerator<TerminalFrame> {
    const record = this.#terminals.get(id)
    if (record === undefined) throw new LocalError('agent/unavailable', `terminal ${id} is unavailable`)
    const context = this.#context(record.sessionId)
    if (context === undefined) throw new LocalError('agent/unavailable', `terminal ${id} is unavailable`)
    for await (const frame of this.#client(context.hostId).attachTerminal(id, signal)) {
      yield frame as unknown as TerminalFrame
    }
  }

  /** Dispose every remote process. */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#terminals].map(async ([id, terminal]) => {
      const context = this.#context(terminal.sessionId)
      if (context !== undefined) await this.#client(context.hostId).closeTerminal(id)
    }))
    this.#terminals.clear()
  }

  #client(hostId: string): RemoteAgentClient {
    if (!this.#hosts.supportsAgent(hostId, 'terminal')) {
      throw new LocalError(
        'agent/unavailable',
        'remote agent does not advertise terminal; reinstall it',
        { retryable: false, ui: { key: 'error.agentOutdated' } },
      )
    }
    return this.#hosts.agentFor(hostId)
  }

  #context(sessionId: string): { hostId: string; remoteRoot: string; anchor: string } | undefined {
    const sessions = this.#ctx.get('sessions')
    const session = sessions?.get(sessionId as never)
    const cwd = session?.header.cwd
    if (cwd === undefined) return undefined
    return this.#mirrors.remoteFileContext(cwd)
  }
}
