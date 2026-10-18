/**
 * Local plugin error taxonomy.
 *
 * These codes are surfaced to the Settings UI and to agent tools; they are
 * never sent to a remote host as-is.
 *
 * @module dsh-remote-local/errors
 */

/** Stable local error codes. */
export type LocalErrorCode =
  | 'request/invalid'
  | 'host/invalid'
  | 'host/duplicate'
  | 'host/not-found'
  | 'host/not-connected'
  | 'host/connect-failed'
  | 'ssh/probe-failed'
  | 'ssh/tunnel-failed'
  | 'agent/unavailable'
  | 'agent/error'
  | 'mirror/unavailable'
  | 'workspace/not-found'
  | 'internal'

/** Error carrying a stable code and JSON-safe details. */
export class LocalError extends Error {
  readonly code: LocalErrorCode
  readonly details: Record<string, unknown>
  readonly retryable: boolean

  constructor(code: LocalErrorCode, message: string, options: {
    readonly details?: Record<string, unknown>
    readonly retryable?: boolean
    readonly cause?: unknown
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LocalError'
    this.code = code
    this.details = options.details ?? {}
    this.retryable = options.retryable ?? (code === 'agent/unavailable' || code === 'internal')
  }
}

/** Normalize unknown failures without leaking stack traces to the browser. */
export function asLocalError(error: unknown, fallback: LocalErrorCode = 'internal'): LocalError {
  if (error instanceof LocalError) return error
  const message = error instanceof Error && error.message !== '' ? error.message : 'remote host operation failed'
  return new LocalError(fallback, message, { cause: error })
}
