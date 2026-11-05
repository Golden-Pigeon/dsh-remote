/**
 * Route ordinary sidebar "new session" actions for mirrored workspaces to the
 * remote agent instead of creating a local Agent in the mirror anchor.
 *
 * The Settings page has its own `+ 新会话` flow. This adapter covers the
 * standard workspace-row action so the native sidebar behaves the same way.
 *
 * @module dsh-remote-local/client/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'
import { localizedError } from './errors.ts'
import type { Translate } from './locale.ts'

interface StartSessionOptions {
  readonly agentPreset?: string
}

interface WorkspaceService {
  startSession(workspaceId?: unknown, options?: StartSessionOptions): void
  readonly mainReference?: { readonly sessionId?: string }
  readonly workspaces?: {
    readonly list?: {
      getSnapshot?: () => {
        readonly items?: readonly {
          readonly workspaceId: string
          readonly sessionIds: readonly string[]
        }[]
      }
    }
  }
}

/** Install the sidebar routing adapter once per client mount. */
export function installNativeWorkspaceRouting(ctx: Context, api: HostsApi, t: Translate): void {
  const workspace = ctx.uiWorkspace as unknown as WorkspaceService | undefined
  if (workspace === undefined || typeof workspace.startSession !== 'function') return
  const original = workspace.startSession.bind(workspace)
  workspace.startSession = (workspaceId, options) => {
    const target = workspaceId ?? currentWorkspaceId(workspace)
    if (target === undefined) {
      original(workspaceId, options)
      return
    }
    void route(api, String(target), options).then(result => {
      if (result === 'local') {
        original(target, options)
        return
      }
      if (result === 'blocked') {
        showToast(t('toast.remoteUnavailable'))
      }
    }).catch(error => {
      showToast(localizedError(t, error, t('toast.createSessionFailed')))
    })
  }
}

async function route(
  api: HostsApi,
  localWorkspaceId: string,
  options?: StartSessionOptions,
): Promise<'handled' | 'blocked' | 'local'> {
  const state = await api.state()
  const mirrored = state.mirroredWorkspaces.find(workspace => workspace.id === localWorkspaceId)
  if (mirrored === undefined) return 'local'
  const host = state.hosts.find(item => item.id === mirrored.hostId)
  if (host === undefined || host.phase !== 'connected') return 'blocked'
  // Keep the native new-task surface: create only a blank local Session here.
  // Its selected Agent preset is forwarded when the first prompt creates the
  // remote Session.
  const created = await api.startBlankSession(host.id, {
    localWorkspaceId,
    ...options?.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
  })
  api.openSession(created.localSessionId)
  return 'handled'
}

function currentWorkspaceId(workspace: WorkspaceService): string | undefined {
  const sessionId = workspace.mainReference?.sessionId
  if (sessionId === undefined) return undefined
  const items = workspace.workspaces?.list?.getSnapshot?.().items
  return items?.find(item => item.sessionIds.includes(sessionId))?.workspaceId
}

function showToast(text: string): void {
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:rgba(30,30,32,.96);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)'
  document.body.append(toast)
  window.setTimeout(() => { toast.remove() }, 6000)
}
