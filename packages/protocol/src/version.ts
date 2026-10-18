/**
 * Version and transport constants shared by both sides of the remote link.
 *
 * The protocol is deliberately small and versioned independently from DSH:
 * a client and an agent may be installed months apart. Negotiation happens
 * before any business call and a mismatch is a hard failure — the design doc
 * explicitly forbids silent downgrade.
 *
 * @module @dsh-remote/protocol/version
 */

/** The protocol revision implemented by this package. */
export const PROTOCOL_VERSION = 1

/** Oldest protocol revision this client/agent can speak. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1

/** Newest protocol revision this client/agent can speak. */
export const MAX_SUPPORTED_PROTOCOL_VERSION = 1

/** Base path of the API served by `dsh-remote-agent` on the remote DSH host. */
export const AGENT_API_PREFIX = '/dsh-remote-agent/api/v1'

/** Base path of the browser-facing API served by `dsh-remote-local-plugin`. */
export const LOCAL_API_PREFIX = '/dsh-remote/api'

/** Request header carrying the caller's protocol revision. */
export const HEADER_PROTOCOL_VERSION = 'x-dsh-remote-protocol'

/** Response header carrying the agent's protocol revision. */
export const HEADER_SERVER_PROTOCOL_VERSION = 'x-dsh-remote-server-protocol'

/** Request/response header carrying the logical host identity. */
export const HEADER_HOST_ID = 'x-dsh-remote-host-id'

/** Response header carrying the remote agent package version. */
export const HEADER_AGENT_VERSION = 'x-dsh-remote-agent-version'

/** Correlation id echoed by both sides, useful in logs and audit records. */
export const HEADER_REQUEST_ID = 'x-dsh-remote-request-id'

/** Default per-request timeout for non-streaming agent calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Default interval between SSE heartbeats. */
export const DEFAULT_STREAM_HEARTBEAT_MS = 15_000

/** Maximum accepted JSON request body for the local management API. */
export const MAX_CONTROL_BODY_BYTES = 64 * 1024

/** Whether a peer protocol revision can be served by this implementation. */
export function isProtocolSupported(version: number): boolean {
  return Number.isInteger(version)
    && version >= MIN_SUPPORTED_PROTOCOL_VERSION
    && version <= MAX_SUPPORTED_PROTOCOL_VERSION
}

/** Result of comparing two protocol revisions. */
export type ProtocolNegotiation =
  | { readonly ok: true; readonly version: number }
  | {
    readonly ok: false
    readonly reason: 'missing' | 'invalid' | 'unsupported'
    readonly clientVersion: number | undefined
    readonly serverVersion: number
    readonly supported: readonly number[]
  }

/**
 * Compare the peer revision with the local one.
 *
 * For the first release there is exactly one revision, so any different
 * value is unsupported. The shape is kept general because the design doc
 * requires version negotiation to be explicit from day one.
 */
export function negotiateProtocol(clientVersion: number | undefined): ProtocolNegotiation {
  const supported = [PROTOCOL_VERSION]
  if (clientVersion === undefined) {
    return { ok: false, reason: 'missing', clientVersion, serverVersion: PROTOCOL_VERSION, supported }
  }
  if (!Number.isInteger(clientVersion) || clientVersion < MIN_SUPPORTED_PROTOCOL_VERSION) {
    return { ok: false, reason: 'invalid', clientVersion, serverVersion: PROTOCOL_VERSION, supported }
  }
  if (!isProtocolSupported(clientVersion)) {
    return { ok: false, reason: 'unsupported', clientVersion, serverVersion: PROTOCOL_VERSION, supported }
  }
  return { ok: true, version: PROTOCOL_VERSION }
}

/** Parse a protocol header value without throwing. */
export function parseProtocolHeader(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null || value.trim() === '') return undefined
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) ? parsed : undefined
}
