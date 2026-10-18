/**
 * Browser-side API wrapper around the host's authenticated Fetch route.
 * Components never see `ctx`.
 *
 * @module dsh-remote-local/client/api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AcceptedResult, PromptDeliveryMode, RemoteWorkspace, SessionSnapshot } from '@dsh-remote/protocol'
import type { HostCreateSessionResult, MirrorFileResult } from '../host-api/contract.ts'
import {
  HOST_API_PATH,
  type HostApiPayloads,
  type HostApiValues,
  type RemoteHostsState,
  type SessionsResult,
  type ValidatedTarget,
  type WebUrlResult,
  type WorkspacesResult,
} from '../host-api/contract.ts'
import type { HostView } from '../hosts/types.ts'

/** Error surfaced by one host call. */
export class RemoteUiError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RemoteUiError'
    this.code = code
    this.details = details
  }
}

/** API surface injected into the Settings component. */
export interface HostsApi {
  readonly state: () => Promise<RemoteHostsState>
  readonly validateTarget: (sshTarget: string) => Promise<ValidatedTarget>
  readonly addHost: (input: HostApiPayloads['host/add']) => Promise<HostView>
  readonly removeHost: (hostId: string) => Promise<void>
  readonly connect: (hostId: string) => Promise<HostView>
  readonly disconnect: (hostId: string) => Promise<HostView>
  readonly refresh: (hostId: string) => Promise<HostView>
  readonly provision: (hostId: string) => Promise<HostView>
  readonly workspaces: (hostId: string) => Promise<WorkspacesResult>
  readonly listDirectories: (hostId: string, path?: string) => Promise<{ path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }>
  readonly listLocalDirectories: (path?: string) => Promise<{ path: string; parent: string; entries: readonly { name: string; path: string }[]; truncated: boolean }>
  readonly createLocalWorkspace: (input: { path: string; title?: string }) => Promise<{ workspaceId: string }>
  readonly createWorkspace: (hostId: string, input: { path: string; title?: string }) => Promise<RemoteWorkspace>
  readonly sessions: (hostId: string, workspaceId?: string) => Promise<SessionsResult>
  readonly webUrl: (hostId: string) => Promise<WebUrlResult>
  readonly snapshot: (hostId: string, sessionId: string, limit?: number) => Promise<SessionSnapshot>
  readonly createSession: (hostId: string, input: { workspaceId?: string; cwd?: string; agentPreset?: string }) => Promise<HostCreateSessionResult>
  readonly openSession: (sessionId: string) => void
  readonly fileList: (sessionId: string, path: string) => Promise<MirrorFileResult>
  readonly fileRead: (sessionId: string, path: string, offset?: number, limit?: number) => Promise<MirrorFileResult>
  readonly fileStat: (sessionId: string, path: string) => Promise<MirrorFileResult>
  readonly fileBytes: (sessionId: string, path: string, offset?: number, length?: number) => Promise<MirrorFileResult>
  readonly prompt: (hostId: string, sessionId: string, text: string, mode?: PromptDeliveryMode, selection?: { provider: string; model: string; reasoningEffort?: string }) => Promise<AcceptedResult>
  readonly cancel: (hostId: string, sessionId: string) => Promise<AcceptedResult>
}

/** Build the API closure once per plugin mount. */
export function createHostsApi(ctx: Context): HostsApi {
  return {
    state: () => call('state', undefined),
    validateTarget: sshTarget => call('target/validate', { sshTarget }),
    addHost: input => call('host/add', input),
    removeHost: async hostId => { await call('host/remove', { hostId }) },
    connect: hostId => call('host/connect', { hostId }),
    disconnect: hostId => call('host/disconnect', { hostId }),
    refresh: hostId => call('host/refresh', { hostId }),
    provision: hostId => call('host/provision', { hostId }),
    workspaces: hostId => call('host/workspaces', { hostId }),
    listDirectories: (hostId, path) => call('host/directory/list', { hostId, ...path === undefined ? {} : { path } }),
    listLocalDirectories: path => call('local/directory/list', { ...path === undefined ? {} : { path } }),
    createLocalWorkspace: input => call('local/workspace/create', input),
    createWorkspace: (hostId, input) => call('host/workspace/create', { hostId, ...input }),
    sessions: (hostId, workspaceId) => call('host/sessions', {
      hostId,
      ...workspaceId === undefined ? {} : { workspaceId },
    }),
    webUrl: hostId => call('host/web-url', { hostId }),
    snapshot: (hostId, sessionId, limit) => call('host/session', {
      hostId,
      sessionId,
      ...limit === undefined ? {} : { limit },
    }),
    createSession: (hostId, input) => call('host/session/create', { hostId, ...input }),
    openSession: sessionId => { ctx.uiWorkspace.openSession(sessionId as never) },
    fileList: (sessionId, path) => call('host/files/list', { sessionId, path }),
    fileRead: (sessionId, path, offset, limit) => call('host/files/read', {
      sessionId,
      path,
      ...offset === undefined ? {} : { offset },
      ...limit === undefined ? {} : { limit },
    }),
    fileStat: (sessionId, path) => call('host/files/stat', { sessionId, path }),
    fileBytes: (sessionId, path, offset, length) => call('host/files/bytes', {
      sessionId,
      path,
      ...offset === undefined ? {} : { offset },
      ...length === undefined ? {} : { length },
    }),
    prompt: (hostId, sessionId, text, mode, selection) => call('host/session/prompt', {
      hostId,
      sessionId,
      text,
      ...mode === undefined ? {} : { mode },
      ...selection === undefined ? {} : selection,
    }),
    cancel: (hostId, sessionId) => call('host/session/cancel', { hostId, sessionId }),
  }
}

async function call<K extends keyof HostApiPayloads & string>(
  endpoint: K,
  payload: HostApiPayloads[K],
): Promise<HostApiValues[K]> {
  const response = await fetch(HOST_API_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload === undefined ? { endpoint } : { endpoint, payload }),
  })
  if (!response.ok) {
    throw new RemoteUiError('request/invalid', `host API returned HTTP ${response.status}`)
  }
  const result = await response.json() as
    | { ok: true; value: HostApiValues[K] }
    | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
  if (!result.ok) {
    throw new RemoteUiError(result.error.code, result.error.message, result.error.details ?? {})
  }
  return result.value
}
