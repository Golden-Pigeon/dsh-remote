/**
 * Strict SSH destination parser.
 *
 * The plugin spawns `ssh` with an argv array, never a shell, so the parser's
 * job is to reject strings that could be mistaken for options or that carry
 * shell metacharacters before they reach the process boundary.
 *
 * @module dsh-remote-local/ssh/target
 */

import { LocalError } from '../errors.ts'

/** One validated SSH destination. */
export interface ParsedSshTarget {
  readonly raw: string
  readonly user: string | null
  readonly host: string
  readonly port: number | null
  /** `user@host` for argv. */
  readonly destination: string
  /** Canonical user/host/port spelling used for ids and duplicate checks. */
  readonly canonical: string
  /** Extra ssh argv options parsed from a user-entered ssh command. */
  readonly sshArgs?: readonly string[]
}

const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/u

/** Parse and validate a destination such as `user@host`, `host:2222`, or `ssh://user@host:22`. */
export function parseSshTarget(raw: string): ParsedSshTarget {
  const input = raw.trim()
  if (input === '') {
    throw new LocalError('host/invalid', 'SSH target must not be empty')
  }
  if (/[\s\u0000-\u001f]/u.test(input)) {
    throw new LocalError('host/invalid', 'SSH target must not contain whitespace or control characters')
  }
  if (input.startsWith('-')) {
    throw new LocalError('host/invalid', 'SSH target must not start with "-"')
  }

  let user: string | null = null
  let hostAndPort = input
  if (input.startsWith('ssh://')) {
    let url: URL
    try {
      url = new URL(input)
    } catch (error) {
      throw new LocalError('host/invalid', `invalid ssh URL: ${input}`, { cause: error })
    }
    if (url.protocol !== 'ssh:') {
      throw new LocalError('host/invalid', `unsupported SSH URL scheme: ${url.protocol}`)
    }
    if (url.pathname !== '' && url.pathname !== '/') {
      throw new LocalError('host/invalid', 'ssh URL must not contain a path')
    }
    if (url.username === '' && url.password !== '') {
      throw new LocalError('host/invalid', 'ssh URL password is not supported; use keys or ssh-agent')
    }
    user = url.username === '' ? null : decodeURIComponent(url.username)
    if (url.hostname === '') {
      throw new LocalError('host/invalid', 'ssh URL has no hostname')
    }
    const port = url.port === '' ? null : Number(url.port)
    return validate({ raw: input, user, host: url.hostname, port })
  }

  const at = input.indexOf('@')
  if (at >= 0) {
    user = input.slice(0, at)
    hostAndPort = input.slice(at + 1)
    if (user === '') {
      throw new LocalError('host/invalid', 'SSH target has an empty user')
    }
  }

  let host = hostAndPort
  let port: number | null = null
  // Only the last colon can be a port. A bare IPv6 literal is intentionally
  // rejected; users can keep it in ~/.ssh/config under an alias.
  const colon = hostAndPort.lastIndexOf(':')
  if (colon >= 0) {
    const portText = hostAndPort.slice(colon + 1)
    host = hostAndPort.slice(0, colon)
    if (!/^\d{1,5}$/u.test(portText)) {
      throw new LocalError('host/invalid', `invalid SSH port: ${JSON.stringify(portText)}`)
    }
    port = Number(portText)
  }

  return validate({ raw: input, user, host, port })
}

function validate(input: {
  raw: string
  user: string | null
  host: string
  port: number | null
}): ParsedSshTarget {
  if (input.user !== null && !USER_PATTERN.test(input.user)) {
    throw new LocalError('host/invalid', `invalid SSH user: ${JSON.stringify(input.user)}`)
  }
  if (!HOST_PATTERN.test(input.host)) {
    throw new LocalError('host/invalid', `unsupported SSH host: ${JSON.stringify(input.host)}`)
  }
  if (input.port !== null && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    throw new LocalError('host/invalid', `SSH port must be between 1 and 65535, got ${String(input.port)}`)
  }
  const destination = input.user === null ? input.host : `${input.user}@${input.host}`
  const canonical = input.port === null ? destination : `${destination}:${input.port}`
  return {
    raw: input.raw,
    user: input.user,
    host: input.host,
    port: input.port,
    destination,
    canonical,
  }
}

/** Attach user-entered ssh options to a parsed target. */
export function withSshArgs(target: ParsedSshTarget, sshArgs: readonly string[] | undefined): ParsedSshTarget {
  return sshArgs === undefined || sshArgs.length === 0 ? target : { ...target, sshArgs: [...sshArgs] }
}

/** A target plus the optional ssh argv prefix parsed from free-form input. */
export interface ParsedSshInput {
  readonly raw: string
  readonly target: ParsedSshTarget
  /** Options only; the destination and remote command are not included. */
  readonly sshArgs: readonly string[]
}

/** Options that consume the following argv item. */
const VALUE_OPTIONS = new Set([
  'B', 'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'm', 'O', 'o', 'Q', 'R', 'S', 'W', 'w',
])

/** Options that cannot be combined with the plugin's own non-interactive commands. */
const INCOMPATIBLE_OPTIONS = new Set(['-G', '-N', '-O', '-M', '-f', '-s', '-W', '-t', '-Q'])

/** Split a command line without a shell; quotes and backslashes are honoured. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of input) {
    if (escaped) {
      current += char
      started = true
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      started = true
      escaped = true
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      started = true
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += '\\'
  if (quote !== null) throw new LocalError('host/invalid', 'SSH command has an unterminated quote')
  if (started) tokens.push(current)
  return tokens
}

function safeArg(value: string): void {
  if (/[\u0000-\u001f]/u.test(value)) {
    throw new LocalError('host/invalid', 'SSH command arguments must not contain control characters')
  }
}

function rebuildTarget(base: ParsedSshTarget, user: string | null, port: number | null): ParsedSshTarget {
  if (user === null && port === null) return base
  if (user !== null && base.user !== null && user !== base.user) {
    throw new LocalError('host/invalid', 'SSH user is specified twice')
  }
  if (port !== null && base.port !== null && port !== base.port) {
    throw new LocalError('host/invalid', 'SSH port is specified twice')
  }
  const resolvedUser = user ?? base.user
  const resolvedPort = port ?? base.port
  const destination = resolvedUser === null ? base.host : `${resolvedUser}@${base.host}`
  return parseSshTarget(resolvedPort === null ? destination : `${destination}:${resolvedPort}`)
}

/**
 * Parse a plain destination or a complete `ssh` command line.
 *
 * The command is tokenized into argv; it is never passed to a shell. Options
 * that need a remote command (ProxyCommand is an ssh option, not a remote
 * command) are preserved as ssh argv so the real ssh client handles config,
 * Match exec, ProxyJump, and ProxyCommand exactly as it normally would.
 */
export function parseSshInput(raw: string): ParsedSshInput {
  const input = raw.trim()
  if (input === '') throw new LocalError('host/invalid', 'SSH target must not be empty')
  const tokens = tokenize(input)
  if (tokens.length === 0) throw new LocalError('host/invalid', 'SSH target must not be empty')
  const first = tokens[0]!
  if (!/^(?:.*[\\/])?ssh(?:\.exe)?$/u.test(first) || tokens.length === 1) {
    if (tokens.length !== 1) {
      throw new LocalError('host/invalid', 'SSH input with spaces must be a command starting with "ssh"')
    }
    return { raw: input, target: parseSshTarget(first), sshArgs: [] }
  }

  let index = 1
  let targetToken: string | undefined
  let user: string | null = null
  let port: number | null = null
  const sshArgs: string[] = []
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '--') {
      index += 1
      targetToken = tokens[index]
      index += 1
      break
    }
    if (!token.startsWith('-') || token === '-') {
      targetToken = token
      index += 1
      break
    }
    const option = token.length >= 2 ? token.slice(0, 2) : token
    if (INCOMPATIBLE_OPTIONS.has(option)) {
      throw new LocalError('host/invalid', `SSH option ${option} is incompatible with a managed host connection`)
    }
    if (option === '-p' || option === '-l') {
      const attached = token.length > 2
      const value = attached ? token.slice(2) : tokens[index + 1]
      if (value === undefined) throw new LocalError('host/invalid', `SSH option ${option} needs a value`)
      safeArg(value)
      if (option === '-p') {
        if (!/^\d{1,5}$/u.test(value)) throw new LocalError('host/invalid', `invalid SSH port: ${JSON.stringify(value)}`)
        port = Number(value)
      } else {
        user = value
      }
      index += attached ? 1 : 2
      continue
    }
    safeArg(token)
    sshArgs.push(token)
    const takesValue = VALUE_OPTIONS.has(option.slice(1))
    const attached = token.length > 2
    if (takesValue && !attached) {
      const value = tokens[index + 1]
      if (value === undefined) throw new LocalError('host/invalid', `SSH option ${option} needs a value`)
      safeArg(value)
      sshArgs.push(value)
      index += 2
    } else {
      index += 1
    }
  }
  if (targetToken === undefined) throw new LocalError('host/invalid', 'SSH command has no destination')
  if (index < tokens.length) {
    throw new LocalError('host/invalid', 'SSH command must not include a remote command')
  }
  const target = withSshArgs(rebuildTarget(parseSshTarget(targetToken), user, port), sshArgs)
  return { raw: input, target, sshArgs }
}

/** Validate a display label. */
export function validateHostLabel(label: string): string {
  const value = label.trim()
  if (value === '') throw new LocalError('host/invalid', 'host label must not be empty')
  if (value.length > 120) throw new LocalError('host/invalid', 'host label must be at most 120 characters')
  if (/[\u0000-\u001f]/u.test(value)) throw new LocalError('host/invalid', 'host label must not contain control characters')
  return value
}
