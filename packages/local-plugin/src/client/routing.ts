/**
 * Route ordinary sidebar and global "new session" actions for mirrored
 * workspaces to the remote agent instead of creating a local Agent in the
 * mirror anchor.
 *
 * The native workspace service resolves the current/recent workspace inside
 * `startSession` and then calls `openWorkspace`. Wrapping `startSession` alone
 * cannot see that resolution and can fall back to a native local blank. This
 * adapter marks only the synchronous `startSession` window and routes the
 * `openWorkspace` it reaches; ordinary workspace opens keep the native path.
 *
 * @module dsh-remote-local/client/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'
import { localizedError } from './errors.ts'
import type { Translate } from './locale.ts'

interface StartSessionOptions {
  readonly agentPreset?: string
  readonly prompt?: unknown
  readonly whenDraftExists?: unknown
  readonly clearPreviousDraft?: boolean
}

type BeforeOpen = (sessionId: string) => void
type ArchiveSession = (sessionId: string) => Promise<void>

interface WorkspaceService {
  startSession(workspaceId?: unknown, options?: StartSessionOptions): void
  openWorkspace?(workspaceId: unknown, beforeOpen?: BeforeOpen, options?: StartSessionOptions): Promise<unknown>
  archiveSession?(sessionId: unknown, options?: { readonly stopActivity?: boolean }): Promise<void>
}

/** Install the sidebar routing adapter once per client mount. */
export function installNativeWorkspaceRouting(ctx: Context, api: HostsApi, t: Translate): void {
  const workspace = ctx.uiWorkspace as unknown as WorkspaceService | undefined
  if (workspace === undefined || typeof workspace.startSession !== 'function') return
  const originalStart = workspace.startSession.bind(workspace)
  const originalOpen = typeof workspace.openWorkspace === 'function'
    ? workspace.openWorkspace.bind(workspace)
    : undefined
  if (originalOpen === undefined) return
  const archiveSession: ArchiveSession = async sessionId => {
    await workspace.archiveSession?.(sessionId, { stopActivity: true })
  }
  let newSessionInFlight = false

  workspace.startSession = (workspaceId, options) => {
    // The workspace-row + button passes only an explicit workspace id (and
    // possibly a preset). Route that directly so a workspace plus never takes
    // the native blank path.
    const hasDraftOptions = options !== undefined
      && Object.keys(options).some(key => key !== 'agentPreset')
    if (workspaceId !== undefined && !hasDraftOptions) {
      void route(api, String(workspaceId), undefined, options, archiveSession)
        .then(result => {
          if (result === 'local') originalStart(workspaceId, options)
        })
        .catch(error => {
          showToast(localizedError(t, error, t('toast.createSessionFailed')))
        })
      return
    }
    // Global New Session, and explicit startSession calls carrying draft
    // options, need the native resolver/preparation callback. The native
    // `startSession` synchronously calls `openWorkspace`; route only that call.
    newSessionInFlight = true
    try {
      originalStart(workspaceId, options)
    } finally {
      newSessionInFlight = false
    }
  }

  workspace.openWorkspace = (workspaceId, beforeOpen, options) => {
    if (!newSessionInFlight || workspaceId === undefined) {
      return originalOpen(workspaceId, beforeOpen, options)
    }
    return route(api, String(workspaceId), beforeOpen, options, archiveSession).then(result => {
      if (result === 'local') {
        return originalOpen(workspaceId, beforeOpen, options)
      }
      return undefined
    }).catch(error => {
      showToast(localizedError(t, error, t('toast.createSessionFailed')))
      throw error
    })
  }
}

async function route(
  api: HostsApi,
  localWorkspaceId: string,
  beforeOpen: BeforeOpen | undefined,
  options: StartSessionOptions | undefined,
  archiveSession: ArchiveSession,
): Promise<'handled' | 'local'> {
  const state = await api.state()
  const mirrored = state.mirroredWorkspaces.find(workspace => workspace.id === localWorkspaceId)
  if (mirrored === undefined) return 'local'
  const host = state.hosts.find(item => item.id === mirrored.hostId)
  if (host === undefined || host.phase !== 'connected') {
    throw new Error('remote host is not connected')
  }
  const created = await api.startBlankSession(host.id, {
    localWorkspaceId,
    ...options?.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
  })
  try {
    // The native draft callback prepares prompt/attachments; it must run
    // before navigation so the blank is ready when the conversation mounts.
    beforeOpen?.(created.localSessionId)
    api.openSession(created.localSessionId)
  } catch (error) {
    await archiveSession(created.localSessionId).catch(() => {})
    throw error
  }
  return 'handled'
}

function showToast(text: string): void {
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:rgba(30,30,32,.96);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)'
  document.body.append(toast)
  window.setTimeout(() => { toast.remove() }, 6000)
}
