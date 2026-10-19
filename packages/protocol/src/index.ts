/**
 * `@dsh-remote/protocol` public surface.
 *
 * @module @dsh-remote/protocol
 */

export {
  AGENT_API_PREFIX,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_HEARTBEAT_MS,
  HEADER_AGENT_VERSION,
  HEADER_HOST_ID,
  HEADER_PROTOCOL_VERSION,
  HEADER_REQUEST_ID,
  HEADER_SERVER_PROTOCOL_VERSION,
  LOCAL_API_PREFIX,
  MAX_SUPPORTED_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  isProtocolSupported,
  negotiateProtocol,
  parseProtocolHeader,
} from './version.ts'
export type { ProtocolNegotiation } from './version.ts'

export type {
  AgentCapability,
  ApiEnvelope,
  ApiFailure,
  AcceptedResult,
  ApiSuccess,
  CreateSessionRequest,
  CreateSessionResult,
  CreateWorkspaceRequest,
  ApprovalOutcome,
  RemoteApprovalAnswer,
  RemoteApprovalFrame,
  RemoteApprovalRequest,
  RemoteAssistantFrame,
  HostInfo,
  JsonPrimitive,
  JsonValue,
  ListSessionsResult,
  ListWorkspacesResult,
  PromptContentPart,
  PromptDeliveryMode,
  PromptImagePart,
  PromptSessionRequest,
  RemoteSandboxMode,
  SetSandboxModeRequest,
  SelectModelRequest,
  RemoteFailure,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
  SessionSnapshot,
  SessionSnapshotOptions,
  SessionStreamEndReason,
  SessionStreamFrame,
  WebUrlResult,
} from './types.ts'

export {
  DISCOVERY_STATE_VERSION,
  isAgentDiscoveryState,
  isAgentLive,
} from './discovery.ts'
export type { AgentDiscoveryState } from './discovery.ts'

export {
  PROTOCOL_ERROR_CODES,
  RemoteProtocolError,
  asProtocolError,
  fail,
  httpStatusForCode,
  isProtocolErrorCode,
  isRetryableCode,
} from './errors.ts'
export type { ProtocolErrorCode, RemoteProtocolErrorInit } from './errors.ts'
export { isRemoteAssistantFrame } from './types.ts'

export { EventCursor, cursorAfter, isCursor, parseCursorQuery } from './cursor.ts'
export type { CursorAcceptance } from './cursor.ts'

export {
  AGENT_ROUTES,
  matchAgentRoute,
  sessionAssistantEventsPath,
  sessionCancelPath,
  sessionEventsPath,
  sessionModelPath,
  sessionPath,
  sessionPromptPath,
  workspaceSessionsPath,
} from './routes.ts'
export type { AgentRoute } from './routes.ts'

export { parseSseStream } from './sse.ts'
export type { SseMessage } from './sse.ts'

export {
  asApiEnvelope,
  failureToUnknown,
  isAcceptedResult,
  isApiFailure,
  isCreateSessionResult,
  isApiSuccess,
  isHostInfoValue,
  isListSessionsResult,
  isListWorkspacesResult,
  isRecord,
  isRemoteWorkspace,
  isRemoteApprovalFrame,
  isSessionSnapshot,
  isSessionStreamFrame,
  isWebUrlResult,
} from './validation.ts'

export {
  RemoteAgentClient,
  assertLoopbackBaseUrl,
  normalizeBaseUrl,
} from './client.ts'
export type { RemoteAgentClientOptions } from './client.ts'
