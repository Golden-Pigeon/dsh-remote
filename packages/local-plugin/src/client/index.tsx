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
import { createHostsApi } from './api.ts'
import { RemoteDevelopmentPanel } from './RemoteDevelopmentPanel.tsx'
import { installNativeWorkspaceRouting } from './routing.ts'
import { installRemoteFiles } from './remote-files.ts'
import { NS, en, zh, type LocaleFace } from './locale.ts'
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
        const claimed = await api.claimOpenSession()
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
}
