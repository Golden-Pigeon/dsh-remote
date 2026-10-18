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

/** The Settings shell's slot registry and the authenticated connection. */
export const inject = ['slots', 'uiWorkspace']

/** Register the 远程开发 page. */
export function apply(ctx: Context): void {
  const api = createHostsApi(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-development',
    order: 76,
    label: '远程开发',
    inject: () => ({ api }),
  }, RemoteDevelopmentPanel))
}
