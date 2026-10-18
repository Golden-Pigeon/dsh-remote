/**
 * Remote PTY terminals for mirrored Sessions.
 *
 * The stock terminal controller spawns processes in the local execution
 * environment. For a mirror, this manager spawns an SSH PTY in the remote
 * workspace instead and exposes the browser protocol the normal terminal UI
 * already consumes.
 *
 * @module dsh-remote-local/remote/terminal
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { TerminalFrame, TerminalInput, TerminalShell, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'

interface TerminalRecord {
  readonly id: string
  readonly sessionId: string
  info: WebTerminalInfo
  readonly child: ChildProcessWithoutNullStreams
  readonly queue: TerminalFrame[]
  waiters: Array<(frame: IteratorResult<TerminalFrame>) => void>
  sequence: number
  title: string
  exited: boolean
}

/** One host-side terminal manager. */
export class RemoteTerminals {
  #ctx: Context
  #hosts: RemoteHostsService
  #mirrors: RemoteMirrorService
  #terminals = new Map<string, TerminalRecord>()

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
    return [{ path: 'ssh', name: 'Remote SSH', args: [] }]
  }

  /** Terminals retained for one Session. */
  list(sessionId: string): WebTerminalInfo[] {
    return [...this.#terminals.values()].filter(item => item.sessionId === sessionId).map(item => item.info)
  }

  /** Allocate an SSH PTY in the mirrored workspace. */
  create(sessionId: string, request: { id?: string; shellPath?: string; cols?: number; rows?: number }): WebTerminalInfo {
    const context = this.#context(sessionId)
    if (context === undefined) throw new Error('terminal is only available for mirrored sessions')
    const id = request.id ?? randomUUID()
    const existing = this.#terminals.get(id)
    if (existing !== undefined) return existing.info
    const ssh = this.#hosts.sshFor(context.hostId)
    const cwd = shellQuote(context.remoteRoot)
    const args = [
      '-tt',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10000',
      ...ssh.port === null ? [] : ['-p', String(ssh.port)],
      ssh.target,
      `cd ${cwd} && exec bash -l`,
    ]
    const child = spawn(ssh.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const info: WebTerminalInfo = {
      id: id as never,
      title: `Remote · ${context.remoteRoot.split('/').at(-1) ?? context.remoteRoot}`,
      shell: { path: 'ssh', name: 'Remote SSH', args: [] },
      cwd: context.remoteRoot,
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
      state: 'running',
      exitCode: null,
    }
    const runtime: TerminalRecord = {
      id, sessionId, info, child, queue: [], waiters: [],
      sequence: 0, title: info.title, exited: false,
    }
    this.#terminals.set(id, runtime)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data: string) => this.#push(runtime, { type: 'output', sequence: ++runtime.sequence, data }))
    child.stderr.on('data', (data: string) => this.#push(runtime, { type: 'output', sequence: ++runtime.sequence, data }))
    child.on('exit', code => {
      runtime.exited = true
      runtime.info = { ...runtime.info, state: code === 0 ? 'exited' : 'failed', exitCode: code }
      this.#push(runtime, { type: 'state', info: runtime.info, writable: false })
      this.#closeWaiters(runtime)
    })
    child.on('error', error => {
      runtime.exited = true
      runtime.info = { ...runtime.info, state: 'failed', error: String(error) }
      this.#push(runtime, { type: 'state', info: runtime.info, writable: false })
    })
    return info
  }

  /** Feed input/resize into one remote PTY. */
  input(id: string, input: TerminalInput): void {
    const runtime = this.#terminals.get(id)
    if (runtime === undefined || runtime.exited) return
    if (input.type === 'write') runtime.child.stdin.write(input.data)
    else {
      // ssh -tt picks up the remote PTY window size from the terminal, but a
      // pipe has no size. stty is best-effort and never fatal.
      runtime.child.stdin.write(`stty cols ${input.cols} rows ${input.rows} 2>/dev/null || true\n`)
    }
  }

  /** Rename a retained terminal. */
  rename(id: string, title: string): void {
    const runtime = this.#terminals.get(id)
    if (runtime !== undefined) runtime.title = title
  }

  /** Close one terminal. */
  close(id: string): void {
    const runtime = this.#terminals.get(id)
    if (runtime === undefined) return
    runtime.child.kill('SIGHUP')
    this.#terminals.delete(id)
  }

  /** Stream frames for one attachment. */
  async *attach(id: string, signal: AbortSignal): AsyncGenerator<TerminalFrame> {
    const runtime = this.#terminals.get(id)
    if (runtime === undefined) throw new Error(`terminal ${id} is unavailable`)
    yield {
      type: 'snapshot',
      sequence: runtime.sequence,
      screen: '',
      info: runtime.info,
      writable: !runtime.exited,
    }
    while (!signal.aborted) {
      if (runtime.queue.length > 0) {
        yield runtime.queue.shift()!
        continue
      }
      if (runtime.exited) return
      const next = await new Promise<IteratorResult<TerminalFrame>>(resolve => {
        runtime.waiters.push(resolve)
        signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
      })
      if (next.done) return
      yield next.value
    }
  }

  /** Retain acknowledgement used by reconnecting windows. */
  async *retain(): AsyncGenerator<{ type: 'retained' }> {
    yield { type: 'retained' }
  }

  /** Dispose every process. */
  dispose(): void {
    for (const runtime of this.#terminals.values()) runtime.child.kill('SIGHUP')
    this.#terminals.clear()
  }

  #context(sessionId: string): { hostId: string; remoteRoot: string; anchor: string } | undefined {
    const sessions = this.#ctx.get('sessions')
    const session = sessions?.get(sessionId as never)
    const cwd = session?.header.cwd
    if (cwd === undefined) return undefined
    return this.#mirrors.remoteFileContext(cwd)
  }

  #push(runtime: TerminalRecord, frame: TerminalFrame): void {
    const waiter = runtime.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: frame })
    else runtime.queue.push(frame)
  }

  #closeWaiters(runtime: TerminalRecord): void {
    for (const waiter of runtime.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
