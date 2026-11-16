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

/**
 * Where this host's model requests get their credentials.
 *
 * `proxy` routes them back to this machine over the SSH tunnel so the local key
 * never lands on the remote; `direct` lets the remote call the provider with its
 * own key.
 */
export type ModelSource = 'proxy' | 'direct'

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
  /**
   * Explicit model-credential source for this host.
   *
   * Absent means "follow the profile default", which keeps records written by
   * older builds behaving exactly as they did.
   */
  readonly modelSource?: ModelSource | null
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
  /**
   * Effective credential source for this host.
   *
   * Resolves the host's explicit choice against the profile default, so the
   * Settings page renders one value without knowing the fallback rules.
   */
  readonly modelSource: ModelSource
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

/** One host found in the local SSH client configuration. */
export interface DiscoveredSshHost {
  /**
   * Primary `Host` alias, which is what `host/add` registers.
   *
   * One `Host` line can declare several aliases for the same machine
   * (`Host devcloud_64g_weyoungli cloud64`). They are merged into one entry so
   * the list does not repeat a machine; the longest alias is the primary one
   * because it is the descriptive one.
   */
  readonly alias: string
  /** The other aliases declared alongside {@link alias}, shortest first. */
  readonly aliases: readonly string[]
  /** Equals {@link alias}; kept so `host/add` keeps receiving a single target. */
  readonly canonical: string
  /** Effective host name or address, resolved through `ssh -G`. */
  readonly hostname: string
  readonly user: string | null
  /** Effective port; null means the SSH default. */
  readonly port: number | null
  /** Config file that declared the alias. */
  readonly source: string
  /** Whether reaching it requires a jump host or proxy command. */
  readonly proxyJump: boolean
  /**
   * Registry entry for any alias in this group, or null when none is
   * registered. Matching only the primary alias would offer to add a machine
   * the user already added under a sibling alias.
   */
  readonly registeredHostId: string | null
}

/** `Host` patterns that cannot become hosts, with the reason. */
export interface SkippedSshHost {
  readonly alias: string
  readonly reason: 'wildcard' | 'unsupported'
}

/** Result of scanning the local SSH configuration. */
export interface SshDiscoveryResult {
  readonly scannedAt: string
  /** Every config file that contributed an alias. */
  readonly configFiles: readonly string[]
  readonly hosts: readonly DiscoveredSshHost[]
  readonly skipped: readonly SkippedSshHost[]
  /** Root-config read failure; an absent config file is not an error. */
  readonly error: string | null
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
export function toHostView(record: HostRecord, runtime: HostRuntime, defaultSource: ModelSource): HostView {
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
    modelSource: record.modelSource ?? defaultSource,
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
