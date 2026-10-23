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
import { createHostsApi } from './api.ts'
import { RemoteDevelopmentPanel } from './RemoteDevelopmentPanel.tsx'
import { installNativeWorkspaceRouting } from './routing.ts'
import { installRemoteFiles } from './remote-files.ts'
import { NS, en, zh, type LocaleFace } from './locale.ts'
import { installWorkspaceAddMenu } from './workspace-add.ts'

/** The Settings shell's slot registry and the authenticated connection. */
export const inject = ['slots', 'uiWorkspace', 'locale', 'sessions', 'workspaces']

/** Register the 远程开发 page. */
export function apply(ctx: Context): void {
  const api = createHostsApi(ctx)
  const locale = (ctx as unknown as { locale: LocaleFace }).locale
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-remote: locale dictionaries')
  const t = locale.bind(NS)
  installNativeWorkspaceRouting(ctx, api)
  installWorkspaceAddMenu(ctx, api, t)
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
