/**
 * Host-safe status and error message codes.
 *
 * The host process must not send user-facing prose: the locale lives in the
 * browser client and is selected by the user's DSH settings. Host code emits
 * stable codes; the client owns every translation.
 *
 * @module dsh-remote-local/messages
 */

/** Stable progress/status codes rendered by the Settings page. */
export const HOST_DETAILS = [
  'discovering',
  'installing',
  'connecting',
  'reprovisioning',
  'restarting',
  'dshUpdating',
  'autoProvisioning',
  'retrying',
  'reconnecting',
  'preparing',
  'proxyPreparing',
  'proxy',
  'uploadingAgent',
  'uploaded',
  'nodeDownloading',
  'nodeInstalled',
  'nodeReady',
  'pnpmInstalling',
  'dshInstalling',
  'agentInstalling',
  'webStarting',
  'waitingState',
  'waitingAgent',
  'agentReady',
  'installed',
  'waitingWeb',
  'stillWaiting',
  'readingState',
  'tunnel',
  'checkingAgent',
  'reconcilingModel',
  'connectedProxy',
  'connectedDirect',
  'connectedRemote',
] as const

export type HostDetail = (typeof HOST_DETAILS)[number]

/** User-facing error keys understood by both host and client. */
export const UI_TEXT_KEYS = [
  'error.requestInvalid',
  'error.hostInvalid',
  'error.hostDuplicate',
  'error.hostNotFound',
  'error.hostNotConnected',
  'error.hostConnectFailed',
  'error.sshProbeFailed',
  'error.sshTunnelFailed',
  'error.agentUnavailable',
  'error.agentOutdated',
  'error.agentError',
  'error.directoryUnreadable',
  'error.workspaceRemoved',
  'error.agentVersionMismatch',
  'error.agentStartTimeout',
  'error.agentInstallFailed',
  'error.healthCheckFailed',
  'error.tunnelExited',
  'error.operationFailed',
  'error.unavailable',
  'error.internal',
  'error.unknown',
  'toast.remoteUnavailable',
  'toast.createSessionFailed',
] as const

export type UiTextKey = (typeof UI_TEXT_KEYS)[number]

/** One stable user-facing message reference. */
export interface UiText {
  readonly key: UiTextKey
  readonly params?: Readonly<Record<string, string | number>>
}

/** Map a local error code to its generic localized message. */
export function uiForErrorCode(code: string): UiText {
  switch (code) {
    case 'request/invalid': return { key: 'error.requestInvalid' }
    case 'host/invalid': return { key: 'error.hostInvalid' }
    case 'host/duplicate': return { key: 'error.hostDuplicate' }
    case 'host/not-found': return { key: 'error.hostNotFound' }
    case 'host/not-connected': return { key: 'error.hostNotConnected' }
    case 'host/connect-failed': return { key: 'error.hostConnectFailed' }
    case 'ssh/probe-failed': return { key: 'error.sshProbeFailed' }
    case 'ssh/tunnel-failed': return { key: 'error.sshTunnelFailed' }
    case 'agent/unavailable': return { key: 'error.agentUnavailable' }
    case 'agent/error': return { key: 'error.agentError' }
    case 'directory/unreadable': return { key: 'error.directoryUnreadable' }
    default: return { key: 'error.internal' }
  }
}
