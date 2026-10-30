/**
 * Host API contract shared by the host handler and the browser Settings page.
 *
 * The route is registered inside DSH Connection's authenticated `/api` fence,
 * so it works through the web HTTP carrier and the desktop IPC carrier without
 * a second authentication scheme.
 *
 * @module dsh-remote-local/host-api/contract
 */

import type { HostView } from '../hosts/types.ts'
import type { UiText } from '../messages.ts'
import type {
  AcceptedResult,
  CreateSessionResult,
  HostInfo,
  PromptDeliveryMode,
  RemoteSessionSummary,
  RemoteWorkspace,
  SessionSnapshot,
} from '@dsh-remote/protocol'

/** Exact authenticated Fetch route owned by the local plugin. */
export const HOST_API_PATH = '/api/dsh-remote'

/** Endpoint names. */
export type HostApiEndpoint =
  | 'state'
  | 'target/validate'
  | 'host/add'
  | 'host/remove'
  | 'host/connect'
  | 'host/disconnect'
  | 'host/refresh'
  | 'host/provision'
  | 'host/upgrade'
  | 'host/restart'
  | 'host/workspaces'
  | 'host/workspace/create'
  | 'host/directory/list'
  | 'local/directory/list'
  | 'local/workspace/create'
  | 'host/sessions'
  | 'host/session'
  | 'host/session/create'
  | 'host/session/prompt'
  | 'host/session/cancel'
  | 'host/web-url'
  | 'host/files/list'
  | 'host/files/read'
  | 'host/files/stat'
  | 'host/files/bytes'

/** One active mirrored workspace, exposed for UI copy decisions. */
export interface MirroredWorkspace {
  readonly id: string
  readonly title: string
}

/** Browser-safe state snapshot. */
export interface RemoteHostsState {
  readonly protocolVersion: number
  readonly hosts: readonly HostView[]
  /** Local workspace ids whose Session creation is owned by a remote host. */
  readonly mirroredWorkspaceIds: readonly string[]
  /** Titles of active mirrored workspaces, used to scope workspace-delete copy. */
  readonly mirroredWorkspaces: readonly MirroredWorkspace[]
}

/** Result of parsing a destination. */
export interface ValidatedTarget {
  readonly canonical: string
  readonly host: string
  readonly user: string | null
  readonly port: number | null
}

/** Result of listing workspaces. */
export interface HostWorkspace extends RemoteWorkspace {
  /** Local mirror workspace id, when it has been synced. */
  readonly localWorkspaceId?: string
}

export interface WorkspacesResult {
  readonly workspaces: readonly HostWorkspace[]
}

/** Result of listing sessions. */
export interface SessionsResult {
  readonly sessions: readonly RemoteSessionSummary[]
}

export interface HostCreateSessionResult extends CreateSessionResult {
  /** Local mirror session that opens in the ordinary Conversation UI. */
  readonly localSessionId?: string
}

export interface MirrorFileResult {
  readonly mirrored: boolean
  readonly value?: unknown
}

/** Result of resolving the remote Web UI. */
export interface WebUrlResult {
  readonly url: string
}

/** One request body. */
export interface HostApiRequest {
  readonly endpoint: HostApiEndpoint
  readonly payload?: unknown
}

/** Success/failure result returned by the route. */
export type HostApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message: string
      readonly details: Record<string, unknown>
      readonly ui?: UiText
    }
  }

/** Payloads accepted by each endpoint. */
export interface HostApiPayloads {
  state: undefined
  'target/validate': { sshTarget: string }
  'host/add': {
    sshTarget: string
    label?: string
    token?: string
    remoteAgentPort?: number
    autoConnect?: boolean
  }
  'host/remove': { hostId: string }
  'host/connect': { hostId: string }
  'host/disconnect': { hostId: string }
  'host/refresh': { hostId: string }
  'host/provision': { hostId: string }
  'host/upgrade': { hostId: string }
  'host/restart': { hostId: string }
  'host/workspaces': { hostId: string }
  'host/workspace/create': { hostId: string; path: string; title?: string }
  'host/directory/list': { hostId: string; path?: string }
  'local/directory/list': { path?: string }
  'local/workspace/create': { path: string; title?: string }
  'host/sessions': { hostId: string; workspaceId?: string }
  'host/session': { hostId: string; sessionId: string; limit?: number }
  'host/session/create': { hostId: string; workspaceId?: string; cwd?: string; agentPreset?: string }
  'host/session/prompt': {
    hostId: string
    sessionId: string
    text: string
    mode?: PromptDeliveryMode
    provider?: string
    model?: string
    reasoningEffort?: string
  }
  'host/session/cancel': { hostId: string; sessionId: string }
  'host/web-url': { hostId: string }
  'host/files/list': { sessionId: string; path: string }
  'host/files/read': { sessionId: string; path: string; offset?: number; limit?: number }
  'host/files/stat': { sessionId: string; path: string }
  'host/files/bytes': { sessionId: string; path: string; offset?: number; length?: number }
}

/** Values returned by each endpoint. */
export interface HostApiValues {
  state: RemoteHostsState
  'target/validate': ValidatedTarget
  'host/add': HostView
  'host/remove': { removed: true }
  'host/connect': HostView
  'host/disconnect': HostView
  'host/refresh': HostView
  'host/provision': HostView
  'host/upgrade': HostView
  'host/restart': HostView
  'host/workspaces': WorkspacesResult
  'host/workspace/create': RemoteWorkspace
  'host/directory/list': { path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }
  'local/directory/list': { path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }
  'local/workspace/create': { workspaceId: string }
  'host/sessions': SessionsResult
  'host/session': SessionSnapshot
  'host/session/create': HostCreateSessionResult
  'host/session/prompt': AcceptedResult
  'host/session/cancel': AcceptedResult
  'host/web-url': WebUrlResult
  'host/files/list': MirrorFileResult
  'host/files/read': MirrorFileResult
  'host/files/stat': MirrorFileResult
  'host/files/bytes': MirrorFileResult
}

/** Informational type for the Settings page. */
export interface HostSummary extends Pick<HostView, 'id' | 'label' | 'sshTarget' | 'phase'> {
  readonly hostInfo: HostInfo | null
}
