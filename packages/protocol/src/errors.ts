/**
 * Protocol error taxonomy and the one error class both sides throw.
 *
 * Error codes are part of the wire contract: the local UI and the remote
 * agent switch on them, so they are stable strings rather than HTTP status
 * codes or free-form messages.
 *
 * @module @dsh-remote/protocol/errors
 */

import type { RemoteFailure } from './types.ts'

/** Every stable error code understood by the local plugin and remote agent. */
export const PROTOCOL_ERROR_CODES = [
  'protocol/version-mismatch',
  'auth/missing',
  'auth/invalid',
  'auth/forbidden',
  'request/invalid',
  'request/too-large',
  'route/not-found',
  'workspace/not-found',
  'session/not-found',
  'session/not-live',
  'agent/not-ready',
  'workspace-file/not-found',
  'workspace-file/not-regular-file',
  'workspace-file/not-text',
  'directory/unreadable',
  'terminal/unavailable',
  'terminal/error',
  'internal',
] as const

/** Stable error code union. */
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number]

/** Whether a string is a recognized protocol error code. */
export function isProtocolErrorCode(value: string): value is ProtocolErrorCode {
  return (PROTOCOL_ERROR_CODES as readonly string[]).includes(value)
}

/** HTTP status used for a code when the failure crosses HTTP. */
export function httpStatusForCode(code: ProtocolErrorCode): number {
  switch (code) {
    case 'protocol/version-mismatch':
      return 409
    case 'auth/missing':
    case 'auth/invalid':
      return 401
    case 'auth/forbidden':
      return 403
    case 'request/invalid':
      return 400
    case 'request/too-large':
      return 413
    case 'route/not-found':
    case 'workspace/not-found':
    case 'session/not-found':
    case 'workspace-file/not-found':
    case 'workspace-file/not-regular-file':
    case 'workspace-file/not-text':
    case 'directory/unreadable':
      return 404
    case 'session/not-live':
    case 'terminal/unavailable':
      return 409
    case 'agent/not-ready':
      return 503
    case 'terminal/error':
    case 'internal':
      return 500
  }
}

/** Whether replaying the same operation may succeed later. */
export function isRetryableCode(code: ProtocolErrorCode): boolean {
  return code === 'agent/not-ready' || code === 'internal'
}

/** Fields accepted by {@link RemoteProtocolError}. */
export interface RemoteProtocolErrorInit {
  readonly code: ProtocolErrorCode
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Record<string, unknown>
  readonly httpStatus?: number
  readonly cause?: unknown
}

/** Error transported between the agent and the local plugin. */
export class RemoteProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly retryable: boolean
  readonly details: Record<string, unknown> | undefined
  readonly httpStatus: number

  constructor(init: RemoteProtocolErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'RemoteProtocolError'
    this.code = init.code
    this.retryable = init.retryable ?? isRetryableCode(init.code)
    this.details = init.details
    this.httpStatus = init.httpStatus ?? httpStatusForCode(init.code)
  }

  /** JSON-safe failure body. */
  toFailure(): RemoteFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details as unknown as RemoteFailure['details'] }),
    }
  }
}

/** Convert an unknown thrown value into a protocol error without leaking internals. */
export function asProtocolError(error: unknown, fallbackMessage = 'remote agent request failed'): RemoteProtocolError {
  if (error instanceof RemoteProtocolError) return error
  const message = error instanceof Error && error.message !== '' ? error.message : fallbackMessage
  return new RemoteProtocolError({ code: 'internal', message, cause: error })
}

/** Throw a protocol error with a stable code. */
export function fail(code: ProtocolErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new RemoteProtocolError({ code, message, details })
}
