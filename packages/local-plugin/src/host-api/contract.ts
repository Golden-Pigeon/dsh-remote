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
import type { HostInfo, RemoteSessionSummary, RemoteWorkspace, SessionSnapshot } from '@dsh-remote/protocol'

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
  | 'host/workspaces'
  | 'host/sessions'
  | 'host/session'
  | 'host/web-url'

/** Browser-safe state snapshot. */
export interface RemoteHostsState {
  readonly protocolVersion: number
  readonly hosts: readonly HostView[]
}

/** Result of parsing a destination. */
export interface ValidatedTarget {
  readonly canonical: string
  readonly host: string
  readonly user: string | null
  readonly port: number | null
}

/** Result of listing workspaces. */
export interface WorkspacesResult {
  readonly workspaces: readonly RemoteWorkspace[]
}

/** Result of listing sessions. */
export interface SessionsResult {
  readonly sessions: readonly RemoteSessionSummary[]
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
  'host/workspaces': { hostId: string }
  'host/sessions': { hostId: string; workspaceId?: string }
  'host/session': { hostId: string; sessionId: string; limit?: number }
  'host/web-url': { hostId: string }
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
  'host/workspaces': WorkspacesResult
  'host/sessions': SessionsResult
  'host/session': SessionSnapshot
  'host/web-url': WebUrlResult
}

/** Informational type for the Settings page. */
export interface HostSummary extends Pick<HostView, 'id' | 'label' | 'sshTarget' | 'phase'> {
  readonly hostInfo: HostInfo | null
}
