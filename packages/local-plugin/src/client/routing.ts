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

interface SessionListSnapshot {
  readonly byId?: Record<string, unknown>
}

interface WorkspaceListSnapshot {
  readonly items?: readonly { readonly sessionIds: readonly string[] }[]
}

interface ClientStores {
  readonly sessions?: { readonly list?: { getSnapshot?: () => SessionListSnapshot } }
  readonly workspaces?: { readonly list?: { getSnapshot?: () => WorkspaceListSnapshot } }
}

/** Whether the client stores have published the new local Session. */
function localSessionKnown(ctx: Context, sessionId: string): boolean {
  try {
    const stores = ctx as unknown as ClientStores
    const sessions = stores.sessions?.list?.getSnapshot?.()
    if (sessions?.byId?.[sessionId] !== undefined) return true
    const workspaces = stores.workspaces?.list?.getSnapshot?.()
    return workspaces?.items?.some(item => item.sessionIds.includes(sessionId)) === true
  } catch {
    return false
  }
}

/**
 * Wait for the workspace/session feed to publish the new local Session.
 *
 * The host API attaches the mirror before it returns, but the client stores are
 * fed asynchronously. Opening the Session before its summary is known leaves
 * the main view bound to a Session the conversation controller cannot
 * subscribe to; switching away and back is the manual workaround.
 */
async function waitForLocalSession(ctx: Context, sessionId: string, timeoutMs = 2000): Promise<void> {
  const stores = ctx as unknown as ClientStores
  if (stores.sessions?.list?.getSnapshot === undefined && stores.workspaces?.list?.getSnapshot === undefined) {
    await new Promise(resolve => setTimeout(resolve, 300))
    return
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (localSessionKnown(ctx, sessionId)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Install the sidebar routing adapter once per client mount. */
export function installNativeWorkspaceRouting(ctx: Context, api: HostsApi): void {
  const workspace = ctx.uiWorkspace as unknown as WorkspaceService | undefined
  if (workspace === undefined || typeof workspace.startSession !== 'function') return
  const original = workspace.startSession.bind(workspace)
  const creating = new Map<string, Promise<void>>()
  workspace.startSession = (workspaceId, options) => {
    if (workspaceId === undefined) {
      original(workspaceId, options)
      return
    }
    const key = String(workspaceId)
    if (creating.has(key)) {
      showToast('正在创建远端会话，请稍候…（已忽略重复点击）')
      return
    }
    let task: Promise<void>
    task = route(ctx, api, key).then(result => {
      if (result === 'local') {
        original(workspaceId, options)
        return
      }
      if (result === 'blocked') {
        showToast('远端工作区当前不可用，未创建本地会话。请先恢复远端连接。')
      }
    }).catch(error => {
      showToast(`无法在远端工作区创建会话：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      if (creating.get(key) === task) creating.delete(key)
    })
    creating.set(key, task)
  }
}

async function route(ctx: Context, api: HostsApi, localWorkspaceId: string): Promise<'handled' | 'blocked' | 'local'> {
  const state = await api.state()
  const mirrored = Array.isArray(state.mirroredWorkspaceIds) ? state.mirroredWorkspaceIds : []
  if (!mirrored.includes(localWorkspaceId)) return 'local'
  let lastError: unknown
  for (const host of state.hosts) {
    if (host.phase !== 'connected') continue
    try {
      // The host API resolves the local workspace through its mirror state, so
      // this path does not need the slow remote `workspaces` listing first.
      const created = await api.createSession(host.id, { localWorkspaceId })
      const localSessionId = created.localSessionId
      if (localSessionId !== undefined) {
        await waitForLocalSession(ctx, localSessionId)
        try {
          api.openSession(localSessionId)
        } catch {
          // The workspace feed can lag the create response by one tick; retry
          // opening without misreporting the create as a failure.
          setTimeout(() => {
            try {
              api.openSession(localSessionId)
            } catch {
              showToast('远端会话已创建，但本地会话尚未出现在侧边栏。请刷新页面后打开它。')
            }
          }, 300)
        }
        return 'handled'
      }
      lastError = new Error('远端会话已创建，但本地镜像尚未就绪。')
    } catch (error) {
      lastError = error
    }
  }
  if (lastError !== undefined) throw lastError
  return 'blocked'
}

function showToast(text: string): void {
  const toast = document.createElement('div')
  toast.textContent = text
  toast.style.cssText = 'position:fixed;z-index:9999;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:rgba(30,30,32,.96);color:#fff;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)'
  document.body.append(toast)
  window.setTimeout(() => { toast.remove() }, 6000)
}
