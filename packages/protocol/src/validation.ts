/**
 * Runtime validation for values crossing the HTTP boundary.
 *
 * TypeScript types disappear at runtime, and the local plugin parses JSON
 * produced by a process that may be a different version. These guards are
 * intentionally narrow: they validate exactly the fields the UI consumes and
 * reject malformed envelopes loudly instead of rendering half a host list.
 *
 * @module @dsh-remote/protocol/validation
 */

import type {
  AcceptedResult,
  ApiEnvelope,
  ApiFailure,
  ApiSuccess,
  CreateSessionResult,
  HostInfo,
  ListSessionsResult,
  ListWorkspacesResult,
  RemoteApprovalFrame,
  RemoteApprovalRequest,
  RemoteFailure,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
  SessionSnapshot,
  SessionStreamFrame,
  WebUrlResult,
} from './types.ts'
import type {
  RemoteDirectoryListing,
  RemoteFileBytes,
  RemoteFileEntry,
  RemoteFileListing,
  RemoteFileStat,
  RemoteFileText,
  RemoteFileWatchFrame,
} from './files.ts'
import type {
  RemoteTerminalFrame,
  RemoteTerminalInfo,
  RemoteTerminalListResult,
} from './terminal.ts'

/** True for a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isIsoString(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value))
}

function isHostInfo(value: unknown): value is HostInfo {
  if (!isRecord(value)) return false
  return isString(value.hostId)
    && isString(value.hostname)
    && isString(value.platform)
    && isString(value.arch)
    && isString(value.dshVersion)
    && isString(value.agentVersion)
    && isString(value.home)
    && isIsoString(value.startedAt)
    && typeof value.protocolVersion === 'number'
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isString)
    && typeof value.workspaceCount === 'number'
    && (value.modelBaseUrl === undefined || value.modelBaseUrl === null || isString(value.modelBaseUrl))
    && (value.modelKeyConfigured === undefined || typeof value.modelKeyConfigured === 'boolean')
    && (value.modelKeyFingerprint === undefined || value.modelKeyFingerprint === null || isString(value.modelKeyFingerprint))
}

function isApprovalRequest(value: unknown): value is RemoteApprovalRequest {
  if (!isRecord(value)) return false
  return isString(value.id)
    && isString(value.sessionId)
    && isString(value.toolName)
    && (value.callId === undefined || isString(value.callId))
    && (value.reason === undefined || isString(value.reason))
    && (value.displayReason === undefined
      || (isRecord(value.displayReason) && Object.values(value.displayReason).every(isString)))
}

export function isRemoteApprovalFrame(value: unknown): value is RemoteApprovalFrame {
  if (!isRecord(value)) return false
  if (value.type === 'ready') return true
  return value.type === 'request' && isApprovalRequest(value.request)
}

export function isRemoteWorkspace(value: unknown): value is RemoteWorkspace {
  if (!isRecord(value)) return false
  return isString(value.workspaceId)
    && isString(value.path)
    && isString(value.title)
    && isStringArray(value.sessionIds)
    && isIsoString(value.createdAt)
    && isIsoString(value.updatedAt)
}

function isRemoteSession(value: unknown): value is RemoteSessionSummary {
  if (!isRecord(value)) return false
  return isString(value.sessionId)
    && (value.workspaceId === null || isString(value.workspaceId))
    && (value.cwd === null || isString(value.cwd))
    && isIsoString(value.createdAt)
    && typeof value.live === 'boolean'
    && (value.eventCount === null || typeof value.eventCount === 'number')
    && (value.origin === undefined || value.origin === 'subagent')
    && (value.parentSession === undefined || isString(value.parentSession))
}

function isRemoteEvent(value: unknown): value is RemoteSessionEvent {
  return isRecord(value)
    && typeof value.seq === 'number'
    && isString(value.type)
    && typeof value.time === 'number'
    && 'data' in value
}

/** Structural check for a protocol success envelope. */
export function isApiSuccess<T>(value: unknown, guard?: (data: unknown) => data is T): value is ApiSuccess<T> {
  if (!isRecord(value) || value.ok !== true) return false
  if (typeof value.protocolVersion !== 'number' || !isIsoString(value.serverTime)) return false
  return guard === undefined || guard(value.data)
}

/** Structural check for a protocol failure envelope. */
export function isApiFailure(value: unknown): value is ApiFailure {
  if (!isRecord(value) || value.ok !== false) return false
  const error = value.error
  return typeof value.protocolVersion === 'number'
    && isIsoString(value.serverTime)
    && isRecord(error)
    && isString(error.code)
    && isString(error.message)
    && typeof error.retryable === 'boolean'
}

/** Parse a JSON value as an envelope, returning undefined when unrecognized. */
export function asApiEnvelope<T>(value: unknown, guard?: (data: unknown) => data is T): ApiEnvelope<T> | undefined {
  if (isApiSuccess(value, guard)) return value
  if (isApiFailure(value)) return value
  return undefined
}

/** Convert a wire failure to the local error shape without importing the class. */
export function failureToUnknown(failure: RemoteFailure): RemoteFailure {
  return failure
}

/** Guard used by the client for `health` / `host`. */
export function isHostInfoValue(value: unknown): value is HostInfo {
  return isHostInfo(value)
}

/** Guard for `workspace.list`. */
export function isListWorkspacesResult(value: unknown): value is ListWorkspacesResult {
  return isRecord(value) && Array.isArray(value.workspaces) && value.workspaces.every(isRemoteWorkspace)
}

/** Guard for `session.list`. */
export function isListSessionsResult(value: unknown): value is ListSessionsResult {
  return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isRemoteSession)
}

/** Guard for `session.snapshot`. */
export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false
  return isString(value.hostId)
    && isString(value.sessionId)
    && typeof value.cursor === 'number'
    && typeof value.live === 'boolean'
    && (value.workspaceId === null || isString(value.workspaceId))
    && (value.cwd === null || isString(value.cwd))
    && Array.isArray(value.events)
    && value.events.every(isRemoteEvent)
    && typeof value.truncated === 'boolean'
}

/** Guard for `session.create`. */
export function isCreateSessionResult(value: unknown): value is CreateSessionResult {
  return isRecord(value) && isString(value.sessionId)
    && (value.agentPreset === undefined || isString(value.agentPreset))
}

/** Guard for `session.prompt` / `session.cancel`. */
export function isAcceptedResult(value: unknown): value is AcceptedResult {
  return isRecord(value) && value.accepted === true
}

/** Guard for `web.url`. */
export function isWebUrlResult(value: unknown): value is WebUrlResult {
  return isRecord(value) && isString(value.path) && value.path.startsWith('/')
}

/** Guard for one SSE stream frame. */
export function isSessionStreamFrame(value: unknown): value is SessionStreamFrame {
  if (!isRecord(value)) return false
  if (value.type === 'ready') {
    return isString(value.hostId) && isString(value.sessionId) && typeof value.cursor === 'number'
      && typeof value.live === 'boolean'
  }
  if (value.type === 'event') {
    return typeof value.cursor === 'number' && isRemoteEvent(value.event)
  }
  if (value.type === 'heartbeat') {
    return typeof value.cursor === 'number' && typeof value.time === 'number'
  }
  if (value.type === 'end') {
    return typeof value.cursor === 'number' && isString(value.reason)
  }
  return false
}


/** Guard for one remote file stat. */
export function isRemoteFileStat(value: unknown): value is RemoteFileStat {
  return isRecord(value)
    && isString(value.absolutePath)
    && isString(value.version)
    && (value.bytes === undefined || typeof value.bytes === 'number')
}

/** Guard for one remote text page. */
export function isRemoteFileText(value: unknown): value is RemoteFileText {
  if (!isRemoteFileStat(value)) return false
  const record = value as unknown as Record<string, unknown>
  return typeof record.offset === 'number'
    && typeof record.lines === 'number'
    && isString(record.text)
    && typeof record.eof === 'boolean'
}

/** Guard for one remote byte page. */
export function isRemoteFileBytes(value: unknown): value is RemoteFileBytes {
  if (!isRemoteFileStat(value)) return false
  const record = value as unknown as Record<string, unknown>
  return typeof record.offset === 'number'
    && isString(record.data)
    && typeof record.eof === 'boolean'
}

function isRemoteFileEntry(value: unknown): value is RemoteFileEntry {
  return isRecord(value)
    && isString(value.name)
    && (value.type === 'file' || value.type === 'directory' || value.type === 'other')
    && (value.size === undefined || typeof value.size === 'number')
}

/** Guard for one remote directory listing. */
export function isRemoteFileListing(value: unknown): value is RemoteFileListing {
  return isRecord(value)
    && isString(value.path)
    && Array.isArray(value.entries)
    && value.entries.every(isRemoteFileEntry)
    && typeof value.truncated === 'boolean'
}

/** Guard for the workspace-creation directory picker. */
export function isRemoteDirectoryListing(value: unknown): value is RemoteDirectoryListing {
  return isRecord(value)
    && isString(value.path)
    && isString(value.parent)
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry) && isString(entry.name) && isString(entry.path))
    && typeof value.truncated === 'boolean'
}

/** Guard for one file watch frame. */
export function isRemoteFileWatchFrame(value: unknown): value is RemoteFileWatchFrame {
  if (!isRecord(value)) return false
  if (value.kind === 'ready') return true
  if (value.kind !== 'change' || !isRecord(value.change)) return false
  if (value.change.absent === true) return isString(value.change.absolutePath)
  return isString(value.change.absolutePath) && isString(value.change.version)
}

function isRemoteTerminalShell(value: unknown): boolean {
  return isRecord(value)
    && isString(value.path)
    && isString(value.name)
    && Array.isArray(value.args)
    && value.args.every(isString)
}

/** Guard for one remote terminal state. */
export function isRemoteTerminalInfo(value: unknown): value is RemoteTerminalInfo {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && isRemoteTerminalShell(value.shell)
    && isString(value.cwd)
    && typeof value.cols === 'number'
    && typeof value.rows === 'number'
    && (value.state === 'running' || value.state === 'exited' || value.state === 'failed')
    && (value.exitCode === null || typeof value.exitCode === 'number')
    && (value.error === undefined || isString(value.error))
}

/** Guard for one terminal attachment frame. */
export function isRemoteTerminalFrame(value: unknown): value is RemoteTerminalFrame {
  if (!isRecord(value)) return false
  if (value.type === 'output') return typeof value.sequence === 'number' && isString(value.data)
  if (value.type === 'snapshot') {
    return typeof value.sequence === 'number'
      && isString(value.screen)
      && isRemoteTerminalInfo(value.info)
      && typeof value.writable === 'boolean'
  }
  if (value.type === 'state') {
    return isRemoteTerminalInfo(value.info) && typeof value.writable === 'boolean'
  }
  return false
}

/** Guard for a terminal list result. */
export function isRemoteTerminalListResult(value: unknown): value is RemoteTerminalListResult {
  return isRecord(value)
    && Array.isArray(value.terminals)
    && value.terminals.every(isRemoteTerminalInfo)
}
