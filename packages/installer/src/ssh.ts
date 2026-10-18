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
      child.kill('SIGKILL')
      reject(new Error(`remote bootstrap timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()

    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
      if (options.verbose) process.stderr.write(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
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
      else reject(Object.assign(new Error(`remote bootstrap exited with ${String(result.code)}`), { result }))
    })
    child.stdin.end(script)
  })
}

/** Quote a remote path for the fixed commands the installer sends. */
export function quoteRemote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
