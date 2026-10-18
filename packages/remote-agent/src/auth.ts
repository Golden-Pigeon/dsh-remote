/**
 * Bearer-token and peer-address checks for the agent surface.
 *
 * @module dsh-remote-agent/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Minimum accepted token length. Generated tokens are 64 hex characters. */
export const MIN_TOKEN_LENGTH = 16

/** Generate a fresh 256-bit token in hex. */
export function mintToken(): string {
  return randomBytes(32).toString('hex')
}

/** Whether a configured token is long enough to be useful. */
export function isValidToken(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH
}

/** Parse an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (value === undefined) return undefined
  const match = /^Bearer[ \t]+(.+)$/iu.exec(value.trim())
  return match?.[1]?.trim()
}

/** Constant-time token comparison. */
export function tokensEqual(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Normalize an IPv4-mapped IPv6 loopback address. */
export function normalizeRemoteAddress(address: string | undefined): string | undefined {
  if (address === undefined) return undefined
  if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length)
  return address
}

/** Whether a normalized peer address is loopback. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address)
  return normalized === '127.0.0.1' || normalized === '::1'
}
