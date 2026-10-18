/**
 * One SSH local-forward tunnel to a remote agent.
 *
 * The tunnel binds `127.0.0.1` only and forwards to the remote agent's
 * loopback port. It never exposes a public interface and never starts a
 * shell on the remote side (`-N`).
 *
 * @module dsh-remote-local/ssh/tunnel
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { LocalError } from '../errors.ts'
import { baseSshArgs } from './probe.ts'
import type { ParsedSshTarget } from './target.ts'

/** Tunnel options. */
export interface TunnelOptions {
  readonly sshBinary: string
  readonly target: ParsedSshTarget
  readonly remotePort: number
  readonly connectTimeoutMs: number
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  /** Called once when an unexpected exit happens. */
  readonly onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void
}

/** Build the tunnel argv (exported for tests). */
export function tunnelArgs(options: TunnelOptions, localPort: number): string[] {
  if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65_535) {
    throw new LocalError('host/invalid', `remote agent port is invalid: ${String(options.remotePort)}`)
  }
  return [
    ...baseSshArgs(options.target, {
      timeoutMs: options.connectTimeoutMs,
      strictHostKeyChecking: options.strictHostKeyChecking,
    }),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${options.remotePort}`,
    options.target.destination,
  ]
}

/** Ask the OS for one free loopback port. */
export async function allocateLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close(error => (error === undefined ? resolve(port) : reject(error)))
    })
  })
}

/** Wait until a loopback port accepts a TCP connection. */
export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const connected = await tryConnect(port)
    if (connected) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for 127.0.0.1:${port}`)
    await new Promise(resolve => setTimeout(resolve, 80))
  }
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

/** A started SSH tunnel. */
export class Tunnel {
  readonly localPort: number
  readonly localUrl: string

  readonly #options: TunnelOptions
  readonly #child: ChildProcess
  readonly #stderr: Buffer[] = []
  #stderrBytes = 0
  #stopping = false
  #exited = false

  private constructor(options: TunnelOptions, localPort: number, child: ChildProcess) {
    this.#options = options
    this.localPort = localPort
    this.localUrl = `http://127.0.0.1:${localPort}`
    this.#child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr.push(chunk)
      this.#stderrBytes += chunk.length
      while (this.#stderrBytes > 8 * 1024 && this.#stderr.length > 1) {
        const removed = this.#stderr.shift()
        this.#stderrBytes -= removed?.length ?? 0
      }
    })
    child.once('exit', (code, signal) => {
      this.#exited = true
      if (this.#stopping) return
      options.onExit?.({ code, signal, stderr: this.stderr })
    })
  }

  /** Start a tunnel, retrying port allocation if the first bind races. */
  static async start(options: TunnelOptions, attempts = 3): Promise<Tunnel> {
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const localPort = await allocateLocalPort()
      const child = spawn(options.sshBinary, tunnelArgs(options, localPort), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
      const tunnel = new Tunnel(options, localPort, child)
      try {
        await tunnel.#awaitReady()
        return tunnel
      } catch (error) {
        lastError = error
        await tunnel.stop()
      }
    }
    throw lastError instanceof LocalError
      ? lastError
      : new LocalError('ssh/tunnel-failed', `could not establish SSH tunnel to ${options.target.canonical}`, {
        cause: lastError,
        retryable: true,
      })
  }

  /** Child process id. */
  get pid(): number | undefined {
    return this.#child.pid
  }

  /** Captured stderr tail. */
  get stderr(): string {
    return Buffer.concat(this.#stderr).toString('utf8').trim()
  }

  /** Stop the tunnel; idempotent. */
  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    if (this.#exited) return
    this.#child.kill('SIGTERM')
    const exited = await waitForExit(this.#child, 2_000)
    if (!exited) {
      this.#child.kill('SIGKILL')
      await waitForExit(this.#child, 1_000)
    }
  }

  async #awaitReady(): Promise<void> {
    const exited = new Promise<never>((_, reject) => {
      this.#child.once('error', error => {
        reject(new LocalError('ssh/tunnel-failed', `SSH tunnel failed to spawn: ${String(error)}`, { cause: error }))
      })
      this.#child.once('exit', (code, signal) => {
        if (this.#stopping) return
        const detail = this.stderr
        reject(new LocalError('ssh/tunnel-failed', [
          `SSH tunnel exited before it was ready (code ${String(code)}, signal ${String(signal)})`,
          detail === '' ? '' : `: ${detail.split('\n')[0]}`,
        ].join('')))
      })
    })
    await Promise.race([
      waitForPort(this.localPort, this.#options.connectTimeoutMs),
      exited,
    ])
    // A port-forward is only useful if ssh is still alive after the bind.
    if (this.#exited) {
      throw new LocalError('ssh/tunnel-failed', `SSH tunnel exited immediately: ${this.stderr.split('\n')[0] ?? 'unknown error'}`)
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
