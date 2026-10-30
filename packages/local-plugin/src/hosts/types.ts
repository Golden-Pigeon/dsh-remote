/**
 * Host records, runtime state, and browser-safe projections.
 *
 * The token is part of the durable record because the local plugin must
 * reconnect after a restart without prompting. It never crosses the RPC
 * boundary: {@link HostView} carries only `hasToken`.
 *
 * @module dsh-remote-local/hosts/types
 */

import type { HostInfo } from '@dsh-remote/protocol'
import type { HostDetail, UiText } from '../messages.ts'

/** Lifecycle phase shown by the Settings page. */
export type HostPhase =
  | 'idle'
  | 'discovering'
  | 'installing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

/** Durable host record (mode 0600 state file). */
export interface HostRecord {
  readonly id: string
  readonly label: string
  /** Canonical SSH destination exactly as typed by the user. */
  readonly sshTarget: string
  /** Explicit SSH port, or null when the destination uses SSH config/default 22. */
  readonly sshPort: number | null
  /** Cached remote agent port discovered over SSH. */
  readonly remoteAgentPort: number | null
  /** Bearer token issued by the remote agent. Secret. */
  readonly token: string | null
  /** Per-host placeholder accepted by the local credential proxy. Secret. */
  readonly proxyToken?: string | null
  readonly autoConnect: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** Remote DSH runtime version older than the local one. */
export interface DshUpdate {
  readonly remoteVersion: string
  readonly localVersion: string
}

/** Pending automatic reconnect, exposed so Settings can show attempt and countdown. */
export interface HostRetry {
  readonly attempt: number
  readonly delayMs: number
  readonly at: number
}

/** Ephemeral runtime state for one host. */
export interface HostRuntime {
  readonly phase: HostPhase
  readonly localPort: number | null
  readonly localUrl: string | null
  readonly hostInfo: HostInfo | null
  readonly workspaceCount: number | null
  readonly error: string | null
  readonly errorCode: string | null
  readonly connectedAt: string | null
  /** Stable progress detail code rendered by the client locale. */
  readonly detail: HostDetail | null
  /** Localized form of {@link error}; raw error text stays in `error`. */
  readonly errorUi: UiText | null
  /** Whether the connected agent is too old for agent-backed file/terminal APIs. */
  readonly agentOutdated: boolean
  /** Whether the local model credential proxy is active for this host. */
  readonly modelProxy: boolean
  /** Whether the resolved local model key was copied into the remote environment. */
  readonly modelDirect: boolean
  /** Set when the remote DSH runtime is older than the local one. */
  readonly dshUpdate: DshUpdate | null
  /** Set while an automatic reconnect is scheduled. */
  readonly retry: HostRetry | null
}

/** Browser/tool-safe host projection. */
export interface HostView {
  readonly id: string
  readonly label: string
  readonly sshTarget: string
  readonly sshPort: number | null
  readonly remoteAgentPort: number | null
  readonly autoConnect: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly hasToken: boolean
  readonly phase: HostPhase
  readonly localPort: number | null
  readonly localUrl: string | null
  readonly hostInfo: HostInfo | null
  readonly workspaceCount: number | null
  readonly error: string | null
  readonly errorCode: string | null
  readonly connectedAt: string | null
  /** Stable progress detail code rendered by the client locale. */
  readonly detail: HostDetail | null
  /** Localized form of {@link error}; raw error text stays in `error`. */
  readonly errorUi: UiText | null
  /** Whether the connected agent is too old for agent-backed file/terminal APIs. */
  readonly agentOutdated: boolean
  /** Whether the local model credential proxy is active for this host. */
  readonly modelProxy: boolean
  /** Whether the resolved local model key was copied into the remote environment. */
  readonly modelDirect: boolean
  /** Set when the remote DSH runtime is older than the local one. */
  readonly dshUpdate: DshUpdate | null
  /** Set while an automatic reconnect is scheduled. */
  readonly retry: HostRetry | null
}

/** Input accepted by `host/add`. */
export interface AddHostInput {
  readonly label?: string
  readonly sshTarget: string
  readonly token?: string
  readonly remoteAgentPort?: number
  readonly autoConnect?: boolean
}

/** Create an idle runtime state. */
export function idleRuntime(): HostRuntime {
  return {
    phase: 'idle',
    localPort: null,
    localUrl: null,
    hostInfo: null,
    workspaceCount: null,
    error: null,
    errorCode: null,
    connectedAt: null,
    detail: null,
    errorUi: null,
    agentOutdated: false,
    modelProxy: false,
    modelDirect: false,
    dshUpdate: null,
    retry: null,
  }
}

/** Project one record + runtime into the browser-safe view. */
export function toHostView(record: HostRecord, runtime: HostRuntime): HostView {
  return {
    id: record.id,
    label: record.label,
    sshTarget: record.sshTarget,
    sshPort: record.sshPort,
    remoteAgentPort: record.remoteAgentPort,
    autoConnect: record.autoConnect,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasToken: record.token !== null,
    phase: runtime.phase,
    localPort: runtime.localPort,
    localUrl: runtime.localUrl,
    hostInfo: runtime.hostInfo,
    workspaceCount: runtime.workspaceCount,
    error: runtime.error,
    errorCode: runtime.errorCode,
    connectedAt: runtime.connectedAt,
    detail: runtime.detail,
    errorUi: runtime.errorUi,
    agentOutdated: runtime.agentOutdated,
    modelProxy: runtime.modelProxy,
    modelDirect: runtime.modelDirect,
    dshUpdate: runtime.dshUpdate,
    retry: runtime.retry,
  }
}
