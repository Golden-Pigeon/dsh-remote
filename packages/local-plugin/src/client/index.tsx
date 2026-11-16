/**
 * dsh-remote-local-plugin browser entry.
 *
 * Registers one Settings section. The component talks only to the injected
 * API closure; the Cordis context stays in `apply`.
 *
 * @module dsh-remote-local/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Pulls the Conversation `SlotMap` merge for the composer model seat. Without
// it `conversation.input.model.options` is an undeclared key, and registering
// into an undeclared slot fails during activation instead of at compile time.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createHostsApi, type HostsApi } from './api.ts'
import { RemoteDevelopmentPanel } from './RemoteDevelopmentPanel.tsx'
import { RemoteModelRows } from './RemoteModelRows.tsx'
import { installNativeWorkspaceRouting } from './routing.ts'
import { installRemoteFiles } from './remote-files.ts'
import { NS, en, zh, type LocaleFace, type Translate } from './locale.ts'
import { installWorkspaceAddMenu } from './workspace-add.ts'
import { installWorkspaceDeleteCopy } from './workspace-delete-copy.ts'

/** The Settings shell's slot registry and the authenticated connection. */
export const inject = ['slots', 'uiWorkspace', 'uiSession', 'locale']

/** Register the 远程开发 page. */
export function apply(ctx: Context): void {
  const api = createHostsApi(ctx)
  const locale = (ctx as unknown as { locale: LocaleFace }).locale
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-remote: locale dictionaries')
  const t = locale.bind(NS)
  ctx.effect(() => {
    const schedule = globalThis.setTimeout
    if (typeof schedule !== 'function') return () => {}
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const currentSessionId = (): string | undefined => {
      const key = ctx.uiSession.adapter.current.getSnapshot().key
      return key === undefined ? undefined : String(key)
    }
    const poll = async (): Promise<void> => {
      if (!active) return
      try {
        // The claim poll doubles as the visibility heartbeat: the host only
        // dispatches approvals while a client shows the mirrored Session.
        const claimed = await api.claimOpenSession(currentSessionId())
        if (active && claimed.localSessionId !== undefined) {
          // Do not steal focus if the user moved on to another Session while
          // the remote Session was being created. uiSession is the public
          // binding; unlike uiWorkspace.mainReference it is not private UI state.
          const current = currentSessionId()
          if (claimed.sourceSessionId === undefined || current === undefined || current === claimed.sourceSessionId) {
            api.openSession(claimed.localSessionId)
          }
        }
      } catch {
        // A later poll retries after the host reconnects.
      }
      if (active) timer = schedule(() => { void poll() }, 500)
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'dsh-remote: reveal promoted draft')
  installNativeWorkspaceRouting(ctx, api, t)
  installWorkspaceAddMenu(ctx, api, t)
  ctx.effect(() => installWorkspaceDeleteCopy(api), 'dsh-remote: mirrored workspace delete copy')
  ctx.inject(['remote.workspaceFiles'], child => {
    installRemoteFiles(child, api)
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-development',
    order: 76,
    label: () => t('settings.title'),
    locale: NS,
    inject: () => ({ api }),
  }, RemoteDevelopmentPanel))
  // Append the remote host's catalog to the composer model menu. The native
  // rows stay untouched; this only adds rows a mirror can actually run.
  installModelMenuGroup(ctx, api, t)
}

/**
 * Contribute the remote model group into the composer model menu.
 *
 * `conversation.input.model.options` is declared by the model-selection plugin
 * from its own `apply`, not by this one, so a registration is only legal once
 * that declaration exists. `slots.inject` is the documented way to wait for it,
 * but it silently does nothing while the key is undeclared and only re-checks on
 * a declaration change — which is easy to miss when the declaring plugin settles
 * before this one boots. Retry a bounded number of times and record the outcome,
 * so a group that never appears can be diagnosed instead of guessed at.
 *
 * @param ctx - client context whose `slots` service owns the registry.
 * @param api - host API used by the rows and by the diagnostics channel.
 * @param t - locale-bound translator for the rows.
 */
function installModelMenuGroup(ctx: Context, api: HostsApi, t: Translate): void {
  const slotName = 'conversation.input.model.options'

  // `slots.inject` re-runs this callback for every declaration lifetime, so each
  // run owns its own registration and must return that run's disposer. Cordis
  // disposes the previous run's effect before starting the next one, and holding
  // the disposer here also guards a leaked registration if a run is replaced
  // without a dispose (which shows up as two entries sharing one id).
  let current: (() => void) | undefined
  ctx.slots.inject(slotName, () => {
    current?.()
    current = undefined
    const dispose = ctx.slots.register({
      name: slotName,
      id: 'dsh-remote',
      locale: NS,
      inject: (sessionId: string) => ({ api, t, sessionId }),
    }, RemoteModelRows)
    current = dispose
    return () => {
      if (current === dispose) current = undefined
      dispose()
    }
  })
}
