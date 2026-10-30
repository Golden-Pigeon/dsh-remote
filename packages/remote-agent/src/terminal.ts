/**
 * Remote PTY manager.
 *
 * Python's standard-library `pty` module owns the terminal, so the agent does
 * not need a native node-pty build. Each terminal is still a child of this
 * agent; the local plugin only sees frames over the existing tunnel.
 *
 * @module dsh-remote-agent/terminal
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { RemoteProtocolError, type RemoteTerminalCreateRequest, type RemoteTerminalFrame, type RemoteTerminalInfo, type RemoteTerminalInput } from '@dsh-remote/protocol'

const MAX_BUFFERED_BYTES = 512 * 1024
const MAX_COLS = 240
const MAX_ROWS = 80

const PTY_HELPER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios
cwd = sys.argv[1]
rows = max(1, min(int(sys.argv[2]), 200))
cols = max(1, min(int(sys.argv[3]), 500))
shell = sys.argv[4] if len(sys.argv) > 4 else '/bin/bash'
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(shell, [shell, '-l'])
    except Exception as error:
        sys.stderr.write(f'terminal exec failed: {error}\n')
        os._exit(127)
def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(cols, rows)
control = b''
while True:
    try:
        readable, _, _ = select.select([0, fd, 3], [], [])
    except InterruptedError:
        continue
    if 0 in readable:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(fd, data)
    if 3 in readable:
        chunk = os.read(3, 65536)
        if not chunk:
            break
        control += chunk
        while b'\n' in control:
            line, control = control.split(b'\n', 1)
            try:
                message = json.loads(line.decode('utf-8'))
                if message.get('type') == 'resize':
                    resize(int(message['cols']), int(message['rows']))
            except Exception:
                pass
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
try:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    code = 0
sys.exit(code)
`

interface Listener {
  (frame: RemoteTerminalFrame): void
}

interface TerminalRecord {
  readonly id: string
  info: RemoteTerminalInfo
  readonly child: ChildProcessWithoutNullStreams
  readonly control: NodeJS.WritableStream
  readonly decoder: StringDecoder
  readonly history: RemoteTerminalFrame[]
  readonly listeners: Set<Listener>
  historyBytes: number
  sequence: number
  stderr: string
  closed: boolean
}

/** Owns every remote PTY and its attachment fan-out. */
export class RemoteTerminalManager {
  readonly #terminals = new Map<string, TerminalRecord>()

  /** Allocate one PTY; repeated ids are idempotent while running. */
  create(request: RemoteTerminalCreateRequest): RemoteTerminalInfo {
    const id = request.id?.trim() === '' || request.id === undefined ? randomUUID() : request.id
    const existing = this.#terminals.get(id)
    if (existing !== undefined) return existing.info
    const cwd = resolve(request.cwd)
    const cols = clamp(request.cols ?? 80, 1, MAX_COLS)
    const rows = clamp(request.rows ?? 24, 1, MAX_ROWS)
    const shell = request.shellPath?.trim() || '/bin/bash'
    let child
    try {
      child = spawn('python3', ['-u', '-c', PTY_HELPER, cwd, String(rows), String(cols), shell], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams & { stdio: [NodeJS.WritableStream, NodeJS.ReadableStream, NodeJS.ReadableStream, NodeJS.WritableStream] }
    } catch (error) {
      throw new RemoteProtocolError({ code: 'terminal/error', message: `could not allocate remote PTY: ${String(error)}`, cause: error })
    }
    const control = child.stdio[3]
    if (control === undefined) {
      child.kill('SIGKILL')
      throw new RemoteProtocolError({ code: 'terminal/error', message: 'remote PTY control channel is unavailable' })
    }
    const title = request.title?.trim() || `Remote · ${basename(cwd) || cwd}`
    const info: RemoteTerminalInfo = {
      id,
      title,
      shell: { path: shell, name: shell, args: [] },
      cwd,
      cols,
      rows,
      state: 'running',
      exitCode: null,
    }
    const record: TerminalRecord = {
      id,
      info,
      child,
      control: control as NodeJS.WritableStream,
      decoder: new StringDecoder('utf8'),
      history: [],
      listeners: new Set(),
      historyBytes: 0,
      sequence: 0,
      stderr: '',
      closed: false,
    }
    this.#terminals.set(id, record)
    child.stdout.on('data', (chunk: Buffer) => this.#output(record, record.decoder.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => {
      record.stderr = `${record.stderr}${chunk.toString('utf8')}`.slice(-8 * 1024)
    })
    child.on('error', error => this.#finish(record, 'failed', null, String(error)))
    child.on('exit', code => this.#finish(record, code === 0 ? 'exited' : 'failed', code, undefined))
    return info
  }

  /** List terminals owned by the agent. */
  list(): RemoteTerminalInfo[] {
    return [...this.#terminals.values()].map(record => record.info)
  }

  /** Feed input or resize. */
  input(id: string, input: RemoteTerminalInput): void {
    const record = this.#terminals.get(id)
    if (record === undefined || record.closed) {
      throw new RemoteProtocolError({ code: 'terminal/unavailable', message: `terminal ${id} is unavailable` })
    }
    if (record.info.state !== 'running') {
      throw new RemoteProtocolError({ code: 'terminal/unavailable', message: `terminal ${id} is not running` })
    }
    if (input.type === 'write') {
      record.child.stdin.write(input.data)
    } else {
      const cols = clamp(input.cols, 1, MAX_COLS)
      const rows = clamp(input.rows, 1, MAX_ROWS)
      record.info = { ...record.info, cols, rows }
      record.control.write(`${JSON.stringify({ type: 'resize', cols, rows })}\n`)
    }
  }

  /** Rename one terminal. */
  rename(id: string, title: string): void {
    const record = this.#terminals.get(id)
    if (record === undefined) throw new RemoteProtocolError({ code: 'terminal/unavailable', message: `terminal ${id} is unavailable` })
    record.info = { ...record.info, title: title.trim() || record.info.title }
  }

  /** Close one terminal and its child. */
  close(id: string): void {
    const record = this.#terminals.get(id)
    if (record === undefined) return
    this.#finish(record, 'exited', record.info.exitCode, undefined)
    record.child.kill('SIGHUP')
    this.#terminals.delete(id)
  }

  /** Stream one attachment. */
  async *attach(id: string, signal: AbortSignal): AsyncGenerator<RemoteTerminalFrame> {
    const record = this.#terminals.get(id)
    if (record === undefined) throw new RemoteProtocolError({ code: 'terminal/unavailable', message: `terminal ${id} is unavailable` })
    const pending: RemoteTerminalFrame[] = []
    let wake: (() => void) | undefined
    const listener: Listener = frame => {
      pending.push(frame)
      wake?.()
      wake = undefined
    }
    record.listeners.add(listener)
    const history = [...record.history]
    try {
      yield { type: 'snapshot', sequence: record.sequence, screen: '', info: record.info, writable: record.info.state === 'running' }
      for (const frame of history) yield frame
      while (!signal.aborted) {
        if (pending.length > 0) {
          yield pending.shift()!
          continue
        }
        if (record.closed) return
        await new Promise<void>(resolvePromise => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', finish)
            resolvePromise()
          }
          wake = finish
          signal.addEventListener('abort', finish, { once: true })
        })
      }
    } finally {
      record.listeners.delete(listener)
    }
  }

  /** Terminate every PTY. */
  dispose(): void {
    for (const record of this.#terminals.values()) {
      record.closed = true
      record.child.kill('SIGHUP')
    }
    this.#terminals.clear()
  }

  #output(record: TerminalRecord, data: string): void {
    if (data === '' || record.closed) return
    const frame: RemoteTerminalFrame = { type: 'output', sequence: ++record.sequence, data }
    record.history.push(frame)
    record.historyBytes += Buffer.byteLength(JSON.stringify(frame))
    while (record.history.length > 1 && record.historyBytes > MAX_BUFFERED_BYTES) {
      const dropped = record.history.shift()
      record.historyBytes -= dropped === undefined ? 0 : Buffer.byteLength(JSON.stringify(dropped))
    }
    for (const listener of record.listeners) listener(frame)
  }

  #finish(record: TerminalRecord, state: 'exited' | 'failed', exitCode: number | null, error: string | undefined): void {
    if (record.closed) return
    const tail = record.decoder.end()
    if (tail !== '') this.#output(record, tail)
    record.info = {
      ...record.info,
      state,
      exitCode,
      ...error === undefined ? {} : { error },
      ...error === undefined && record.stderr !== '' && state === 'failed' ? { error: record.stderr.split('\n').at(-2) ?? record.stderr } : {},
    }
    const frame: RemoteTerminalFrame = { type: 'state', info: record.info, writable: false }
    record.history.push(frame)
    record.closed = true
    for (const listener of record.listeners) listener(frame)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}
