/**
 * dsh-remote-local-plugin host entry.
 *
 * Owns the host registry, SSH tunnels, the authenticated Connection RPC
 * channel used by the Settings page, and the model-facing remote tools.
 *
 * @module dsh-remote-local
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Config, resolveConfig, type Config as LocalConfig } from './config.ts'
import { registerHostApi } from './host-api/handler.ts'
import { RemoteHostsService } from './service.ts'
import { registerRemoteTools } from './tools.ts'

export const name = 'dsh-remote-local'

/** Connection owns the authenticated `/api` carrier. */
export const inject = ['connection']

export { Config }
export type { LocalConfig }
export { RemoteHostsService } from './service.ts'
export { HOST_API_PATH } from './host-api/contract.ts'

/** Mount the host registry and its extension points. */
export async function apply(ctx: Context, config: LocalConfig = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const service = new RemoteHostsService(ctx, resolved)
  await service.start()

  ctx.effect(
    () => {
      const dispose = registerHostApi(ctx, service)
      return () => { void dispose() }
    },
    'dsh-remote-local: authenticated host API',
  )

  ctx.inject(['tools'], child => {
    registerRemoteTools(child, service)
  })

  ctx.effect(
    () => () => { void service.dispose() },
    'dsh-remote-local: tunnel lifecycle',
  )

  ctx.logger.info(
    'dsh-remote-local: %d host(s), state in %s',
    service.list().length,
    resolved.stateDir,
  )
}
