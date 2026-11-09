/**
 * Route gateway terminal calls by Session.
 *
 * The fork replaces the stock terminal-controller row, but its host half is the
 * stock implementation. Gateway clients call the stock Remote methods directly,
 * so a mirrored Session would otherwise get a local shell. Patch the service for
 * mirrored Sessions and keep the stock implementation for local Sessions.
 *
 * @module dsh-remote-local/remote/terminal-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TerminalController,
  TerminalCreateRequest,
  TerminalEnvironment,
  TerminalFrame,
  TerminalInput,
  TerminalRetentionFrame,
  TerminalShell,
  WebTerminalId,
  WebTerminalInfo,
} from '@deepseek-ai/dsh-api-terminal-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteTerminals } from './terminal.ts'

/** The gateway invocation fields the stock attach path uses. */
interface Invocation {
  uplink?<T>(): AsyncIterable<T>
}

/** Install the mirrored-Session gateway routing; returns its restorer. */
export function installRemoteTerminalController(
  ctx: Context,
  controller: TerminalController,
  terminals: RemoteTerminals,
): () => void {
  const original = {
    environment: controller.environment.bind(controller),
    shells: controller.shells.bind(controller),
    list: controller.list.bind(controller),
    create: controller.create.bind(controller),
    retain: controller.retain.bind(controller),
    attach: controller.attach.bind(controller),
    rename: controller.rename.bind(controller),
    close: controller.close.bind(controller),
  }
  const isMirror = (agent: Agent): boolean => terminals.isMirrored(String(agent.id))
  const isMirrorSession = (sessionId: SessionId): boolean => terminals.isMirrored(String(sessionId))

  controller.environment = (agent: Agent, signal: AbortSignal): TerminalEnvironment => {
    signal.throwIfAborted()
    return isMirror(agent) ? terminals.environment(String(agent.id)) : original.environment(agent, signal)
  }
  controller.shells = (agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> => {
    signal.throwIfAborted()
    return isMirror(agent) ? Promise.resolve(terminals.shells()) : original.shells(agent, signal)
  }
  controller.list = ((sessionId: SessionId): WebTerminalInfo[] | Promise<WebTerminalInfo[]> =>
    isMirrorSession(sessionId) ? terminals.list(String(sessionId)) : original.list(sessionId)) as TerminalController['list']
  controller.create = (agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> =>
    isMirror(agent) ? terminals.create(String(agent.id), request) : original.create(agent, request, signal)
  controller.retain = (sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> => {
    if (!isMirrorSession(sessionId)) return original.retain(sessionId, id, signal)
    return (async function* () {
      signal.throwIfAborted()
      yield { type: 'retained' as const }
    })()
  }
  controller.attach = function (this: TerminalController, agent: Agent, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    if (!isMirror(agent)) return original.attach(agent, id, signal)
    const invocation = (this as unknown as { ctx?: { invocation?: Invocation } }).ctx?.invocation
    if (invocation === undefined || invocation.uplink === undefined) throw new Error('Terminal attachment requires a Remote invocation')
    const uplink = <T>(): AsyncIterable<T> => invocation.uplink!<T>()
    void (async () => {
      try {
        for await (const input of uplink<TerminalInput>()) {
          await terminals.input(String(id), input)
        }
      } catch (error) {
        ctx.logger.warn('dsh-remote-local: remote terminal uplink failed: %s', String(error))
      }
    })()
    return terminals.attach(String(id), signal)
  }
  controller.rename = ((agent: Agent, id: WebTerminalId, title: string): void | Promise<void> =>
    isMirror(agent) ? terminals.rename(String(id), title) : original.rename(agent, id, title)) as TerminalController['rename']
  controller.close = ((agent: Agent, id: WebTerminalId): Promise<void> =>
    isMirror(agent) ? terminals.close(String(id)) : original.close(agent, id)) as TerminalController['close']

  return () => {
    controller.environment = original.environment
    controller.shells = original.shells
    controller.list = original.list
    controller.create = original.create
    controller.retain = original.retain
    controller.attach = original.attach
    controller.rename = original.rename
    controller.close = original.close
  }
}
