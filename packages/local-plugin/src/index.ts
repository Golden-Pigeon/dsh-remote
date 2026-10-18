/**
 * dsh-remote-local-plugin host entry.
 *
 * Owns the host registry, SSH tunnels, the authenticated Connection RPC
 * channel used by the Settings page, and the model-facing remote tools.
 *
 * @module dsh-remote-local
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Config, resolveConfig, type Config as LocalConfig } from './config.ts'
import { registerHostApi } from './host-api/handler.ts'
import { RemoteMirrorService } from './mirror/service.ts'
import { installRemoteWorkspaceFiles } from './remote/files.ts'
import { RemoteTerminals } from './remote/terminal.ts'
import { registerTerminalApi } from './host-api/terminal.ts'
import { RemoteHostsService } from './service.ts'
import { registerRemoteTools } from './tools.ts'

export const name = 'dsh-remote-local'

/** Connection owns the authenticated `/api` carrier; credentials stay local. */
export const inject = ['connection', 'credentials']

export { Config }
export type { LocalConfig }
export { RemoteHostsService } from './service.ts'
export { HOST_API_PATH } from './host-api/contract.ts'

/** Mount the host registry and its extension points. */
export async function apply(ctx: Context, config: LocalConfig = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const service = new RemoteHostsService(ctx, resolved, {
    resolveModelKey: async () => {
      try {
        const resolvedKey = await ctx.credentials.resolve(credentialRef(resolved.modelCredentialRef))
        return resolvedKey?.value
      } catch (error) {
        ctx.logger.warn('dsh-remote-local: could not resolve %s: %s', resolved.modelCredentialRef, String(error))
        return undefined
      }
    },
  })
  await service.start()
  const mirrors = new RemoteMirrorService(ctx, service, resolved)
  await mirrors.start()
  const terminals = new RemoteTerminals(ctx, service, mirrors)
  ctx.effect(() => registerTerminalApi(ctx, terminals), 'dsh-remote-local: remote terminal route')
  ctx.inject(['workspaceFiles'], child => {
    installRemoteWorkspaceFiles(child, mirrors, service)
  })

  ctx.effect(
    () => {
      const dispose = registerHostApi(ctx, service, mirrors)
      return () => { void dispose() }
    },
    'dsh-remote-local: authenticated host API',
  )

  ctx.inject(['tools'], child => {
    registerRemoteTools(child, service, mirrors)
  })

  ctx.effect(
    () => () => {
      terminals.dispose()
      void mirrors.dispose()
      void service.dispose()
    },
    'dsh-remote-local: tunnel and mirror lifecycle',
  )

  ctx.logger.info(
    'dsh-remote-local: %d host(s), state in %s',
    service.list().length,
    resolved.stateDir,
  )
}
