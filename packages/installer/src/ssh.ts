/**
 * Minimal SSH/scp process wrapper for the installer.
 *
 * The installer is not a long-lived service; it needs one validated
 * destination, bounded commands, and streaming output. Runtime host control
 * lives in dsh-remote-local-plugin's more complete SSH layer.
 *
 * @module @dsh-remote/installer/ssh
 */

import { spawn } from 'node:child_process'
import { installerErrorForExit } from './errors.ts'

/** One validated destination. */
export interface ParsedTarget {
  readonly raw: string
  readonly destination: string
  readonly port: number | null
  readonly canonical: string
}

/** Target parsing failure. */
export class SshTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshTargetError'
  }
}

/** Validate an SSH destination without invoking a shell. */
export function parseTarget(raw: string): ParsedTarget {
  const input = raw.trim()
  if (input === '') throw new SshTargetError('SSH target must not be empty')
  if (/[\s\u0000-\u001f]/u.test(input)) throw new SshTargetError('SSH target must not contain whitespace')
  if (input.startsWith('-')) throw new SshTargetError('SSH target must not start with "-"')

  let user: string | null = null
  let hostAndPort = input
  if (input.startsWith('ssh://')) {
    let url: URL
    try {
      url = new URL(input)
    } catch (error) {
      throw new SshTargetError(`invalid ssh URL: ${input}`)
    }
    if (url.protocol !== 'ssh:') throw new SshTargetError(`unsupported scheme: ${url.protocol}`)
    if (url.pathname !== '' && url.pathname !== '/') throw new SshTargetError('ssh URL must not contain a path')
    user = url.username === '' ? null : decodeURIComponent(url.username)
    const port = url.port === '' ? null : Number(url.port)
    return validate(input, user, url.hostname, port)
  }

  const at = input.indexOf('@')
  if (at >= 0) {
    user = input.slice(0, at)
    hostAndPort = input.slice(at + 1)
  }
  let host = hostAndPort
  let port: number | null = null
  const colon = hostAndPort.lastIndexOf(':')
  if (colon >= 0) {
    const portText = hostAndPort.slice(colon + 1)
    if (!/^\d{1,5}$/u.test(portText)) throw new SshTargetError(`invalid SSH port: ${portText}`)
    host = hostAndPort.slice(0, colon)
    port = Number(portText)
  }
  return validate(input, user, host, port)
}

function validate(raw: string, user: string | null, host: string, port: number | null): ParsedTarget {
  if (user !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u.test(user)) {
    throw new SshTargetError(`invalid SSH user: ${JSON.stringify(user)}`)
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/u.test(host)) {
    throw new SshTargetError(`unsupported SSH host: ${JSON.stringify(host)}`)
  }
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new SshTargetError(`invalid SSH port: ${String(port)}`)
  }
  const destination = user === null ? host : `${user}@${host}`
  return {
    raw,
    destination,
    port,
    canonical: port === null ? destination : `${destination}:${port}`,
  }
}

/** Options shared by every remote command. */
export interface SshOptions {
  readonly binary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly timeoutMs: number
  readonly verbose: boolean
  /** Optional streaming callback for the bootstrap script; never used as UI text directly. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

/** Options shared by every upload. */
export interface ScpOptions {
  /** scp executable to run; the caller pairs it with {@link SshOptions.binary}. */
  readonly binary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly verbose: boolean
  /** Upload timeout in milliseconds; also bounds scp's connect phase. */
  readonly timeoutMs?: number
}

/** Result of a remote command. */
export interface RemoteResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Build the common ssh argv. */
export function sshArgs(target: ParsedTarget, options: SshOptions): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.timeoutMs / 1_000))}`,
    '-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...target.port === null ? [] : ['-p', String(target.port)],
  ]
}

/** Build the common scp argv. */
export function scpArgs(target: ParsedTarget, options: ScpOptions, local: string, remote: string): string[] {
  return [
    // BatchMode keeps the upload from blocking on a password prompt; sshArgs
    // already refuses interactive auth for the install itself.
    '-o', 'BatchMode=yes',
    ...options.timeoutMs === undefined
      ? []
      : ['-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.timeoutMs / 1_000))}`],
    '-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`,
    ...target.port === null ? [] : ['-P', String(target.port)],
    local,
    `${target.destination}:${remote}`,
  ]
}

/** Upload one local file to a remote path. */
export function uploadFile(
  local: string,
  remote: string,
  target: ParsedTarget,
  options: ScpOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.binary, scpArgs(target, options, local, remote), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      // POSIX: put scp in its own process group so a timeout can take its
      // ssh child down with it. Windows has no equivalent group; the direct
      // kill below is the best available there.
      detached: process.platform !== 'win32',
    })
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const stderrTail = (): string => Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/u).pop() ?? ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const killTree = (): void => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          // The group is already gone; fall back to the direct child.
        }
      }
      child.kill('SIGKILL')
    }
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      stderrBytes += chunk.length
      // Keep only the tail; a verbose scp can stream a lot of progress.
      while (stderrBytes > 64 * 1024 && stderr.length > 0) {
        const first = stderr[0]!
        const excess = stderrBytes - 64 * 1024
        if (first.length <= excess) {
          stderr.shift()
          stderrBytes -= first.length
          continue
        }
        // One chunk larger than the cap must still keep its tail, which is
        // where the actual error line lives.
        stderr[0] = first.subarray(excess)
        stderrBytes -= excess
        break
      }
      if (options.verbose) process.stderr.write(chunk)
    })
    timer = setTimeout(() => {
      killTree()
      const tail = stderrTail()
      finish(new Error(`scp timed out after ${String(options.timeoutMs ?? 120_000)}ms${tail === '' ? '' : `: ${tail}`}`))
    }, options.timeoutMs ?? 120_000)
    timer.unref?.()
    child.once('error', error => finish(error))
    // `close` (rather than `exit`) waits until stderr has been drained, so the
    // reported cause is complete.
    child.once('close', code => {
      if (code === 0) {
        finish()
        return
      }
      const tail = stderrTail()
      finish(new Error(`scp failed with ${String(code ?? 1)}${tail === '' ? '' : `: ${tail}`}`))
    })
  })
}

/** Run one command through the remote shell and collect bounded output. */
export function runRemote(
  target: ParsedTarget,
  command: string,
  options: SshOptions,
): Promise<RemoteResult> {
  return new Promise<RemoteResult>((resolve, reject) => {
    const child = spawn(options.binary, [...sshArgs(target, options), target.destination, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      reject(new Error(`SSH command timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()

    const append = (buffer: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      buffer.push(chunk)
      if (options.verbose) process.stderr.write(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: RemoteResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? (signal === null ? 1 : 137),
      }
      if (result.code === 0) resolve(result)
      else reject(Object.assign(new Error(`remote command exited with ${String(result.code)}`), { result }))
    })
  })
}

/** Pipe a bootstrap script to a remote `bash -s`. */
export function runRemoteScript(
  target: ParsedTarget,
  script: string,
  options: SshOptions,
): Promise<RemoteResult> {
  return new Promise<RemoteResult>((resolve, reject) => {
    const child = spawn(options.binary, [...sshArgs(target, options), target.destination, 'bash -s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`remote bootstrap timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()

    const append = (target: Buffer[], stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
      if (options.verbose) process.stderr.write(chunk)
      try {
        options.onOutput?.(stream, chunk.toString('utf8'))
      } catch {
        // Progress reporting must never break the installer.
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, 'stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, 'stderr', chunk))
    child.stdin.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    // `close` waits until stdout/stderr are drained; `exit` can fire before the
    // final stderr line that explains the failure.
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: RemoteResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? (signal === null ? 1 : 137),
      }
      if (result.code === 0) {
        resolve(result)
        return
      }
      const tail = result.stderr
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line !== '')
        .slice(-2)
        .join(' | ')
        .slice(0, 500)
      // A deliberate `exit 21`-`exit 26` carries a known cause; anything else
      // keeps the raw code so an unexpected shell failure is still visible.
      const known = installerErrorForExit(result.code, tail === '' ? undefined : tail)
      if (known !== undefined) {
        reject(Object.assign(known, { result }))
        return
      }
      const message = `remote bootstrap exited with ${String(result.code)}${tail === '' ? '' : `: ${tail}`}`
      reject(Object.assign(new Error(message), { result }))
    })
    child.stdin.end(script)
  })
}

/** Quote a remote path for the fixed commands the installer sends. */
export function quoteRemote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
