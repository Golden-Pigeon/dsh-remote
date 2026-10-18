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
    void route(api, String(workspaceId)).then(routed => {
      if (!routed) original(workspaceId, options)
    }).catch(() => { original(workspaceId, options) })
  }
}

async function route(api: HostsApi, localWorkspaceId: string): Promise<boolean> {
  const state = await api.state()
  for (const host of state.hosts) {
    if (host.phase !== 'connected') continue
    const result = await api.workspaces(host.id)
    const workspace = result.workspaces.find(item => item.localWorkspaceId === localWorkspaceId)
    if (workspace === undefined) continue
    const created = await api.createSession(host.id, { workspaceId: workspace.workspaceId })
    if (created.localSessionId !== undefined) {
      api.openSession(created.localSessionId)
      return true
    }
  }
  return false
}
