/**
 * dsh-remote-agent plugin entry.
 *
 * Installed into a remote DSH Web profile. It publishes a loopback-only,
 * bearer-authenticated read API for host identity, workspaces, sessions, and
 * live session events. It never executes tools or mutates sessions.
 *
 * @module dsh-remote-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { Config, type Config as RemoteAgentConfig } from './config.ts'
import { registerAgentRoutes } from './http.ts'
import { RemoteAgentService } from './service.ts'

export const name = '@goldenpigeon/dsh-remote-agent'

/** Services that must be active before the agent can answer anything. */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'sessionController', 'agents']

export { Config }
export type { RemoteAgentConfig }
export { AGENT_VERSION } from './version.ts'

/**
 * Mount the agent. The service opens the private state file before the route
 * is registered, so a discovery read taken immediately after startup always
 * sees a complete token/port pair.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const service = await RemoteAgentService.create(ctx, config)
  ctx.effect(
    () => registerAgentRoutes(ctx, service),
    'dsh-remote-agent: loopback HTTP/SSE surface',
  )
  ctx.effect(
    () => () => { void service.dispose() },
    'dsh-remote-agent: private state lifecycle',
  )
}
