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

/** Validate a display label. */
export function validateHostLabel(label: string): string {
  const value = label.trim()
  if (value === '') throw new LocalError('host/invalid', 'host label must not be empty')
  if (value.length > 120) throw new LocalError('host/invalid', 'host label must be at most 120 characters')
  if (/[\u0000-\u001f]/u.test(value)) throw new LocalError('host/invalid', 'host label must not contain control characters')
  return value
}
