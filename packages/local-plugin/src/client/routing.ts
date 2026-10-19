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

interface StartSessionOptions {
  readonly agentPreset?: string
}

interface WorkspaceService {
  startSession(workspaceId?: unknown, options?: StartSessionOptions): void
}

/** Install the sidebar routing adapter once per client mount. */
export function installNativeWorkspaceRouting(ctx: Context, api: HostsApi): void {
  const workspace = ctx.uiWorkspace as unknown as WorkspaceService | undefined
  if (workspace === undefined || typeof workspace.startSession !== 'function') return
  const original = workspace.startSession.bind(workspace)
  workspace.startSession = (workspaceId, options) => {
    if (workspaceId === undefined) {
      original(workspaceId, options)
      return
    }
    void route(api, String(workspaceId)).then(result => {
      if (result === 'local') {
        original(workspaceId, options)
        return
      }
      if (result === 'blocked') {
        showToast('远端工作区当前不可用，未创建本地会话。请先恢复远端连接。')
      }
    }).catch(error => {
      showToast(`无法在远端工作区创建会话：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

async function route(api: HostsApi, localWorkspaceId: string): Promise<'handled' | 'blocked' | 'local'> {
  const state = await api.state()
  const mirrored = Array.isArray(state.mirroredWorkspaceIds) ? state.mirroredWorkspaceIds : []
  if (!mirrored.includes(localWorkspaceId)) return 'local'
  for (const host of state.hosts) {
    if (host.phase !== 'connected') continue
    let result
    try {
      result = await api.workspaces(host.id)
    } catch {
      continue
    }
    const workspace = result.workspaces.find(item => item.localWorkspaceId === localWorkspaceId)
    if (workspace === undefined) continue
    const created = await api.createSession(host.id, { workspaceId: workspace.workspaceId })
    if (created.localSessionId !== undefined) {
      api.openSession(created.localSessionId)
      return 'handled'
    }
    return 'blocked'
  }
  return 'blocked'
}

function showToast(text: string): void {
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:rgba(30,30,32,.96);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)'
  document.body.append(toast)
  window.setTimeout(() => { toast.remove() }, 6000)
}
