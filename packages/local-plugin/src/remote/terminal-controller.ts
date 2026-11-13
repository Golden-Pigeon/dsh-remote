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
    watch: controller.watch.bind(controller),
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
    return isMirror(agent) ? Promise.resolve(terminals.shells(String(agent.id))) : original.shells(agent, signal)
  }
  controller.list = ((sessionId: SessionId): WebTerminalInfo[] | Promise<WebTerminalInfo[]> =>
    isMirrorSession(sessionId) ? terminals.list(String(sessionId)) : original.list(sessionId)) as TerminalController['list']
  controller.create = (agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> =>
    isMirror(agent) ? terminals.create(String(agent.id), request) : original.create(agent, request, signal)
  controller.watch = (sessionId: SessionId, signal: AbortSignal): AsyncIterable<WebTerminalInfo[]> => {
    if (!isMirrorSession(sessionId)) return original.watch(sessionId, signal)
    return watchRemoteTerminals(terminals, String(sessionId), signal,
      message => ctx.logger.warn('dsh-remote-local: remote terminal roster failed: %s', message))
  }
  controller.retain = (sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> => {
    if (!isMirrorSession(sessionId)) return original.retain(sessionId, id, signal)
    return (async function* () {
      signal.throwIfAborted()
      // rc.2 TerminalWindowHold treats an ended retention stream as unavailable.
      yield { type: 'retained' as const }
      await holdUntilAborted(signal)
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
    controller.watch = original.watch
    controller.retain = original.retain
    controller.attach = original.attach
    controller.rename = original.rename
    controller.close = original.close
  }
}

/** Poll interval for a mirrored Session's whole terminal roster. */
const WATCH_POLL_MS = 1_500

/**
 * Stream a mirrored Session's remote terminal roster to the rc.2 client.
 * @param terminals - host-side remote terminal manager.
 * @param sessionId - mirrored Session identity.
 * @param signal - stream cancellation.
 * @param warn - diagnostic sink for poll failures.
 * @returns each whole roster when it changes.
 */
async function* watchRemoteTerminals(
  terminals: RemoteTerminals,
  sessionId: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): AsyncIterable<WebTerminalInfo[]> {
  let previous = ''
  let previousError = ''
  while (!signal.aborted) {
    try {
      const roster = await terminals.list(sessionId)
      const key = JSON.stringify(roster.map(info => [
        info.id, info.title, info.state, info.cols, info.rows, info.exitCode, info.error, info.origin, info.control,
      ]))
      previousError = ''
      if (key !== previous) {
        previous = key
        yield roster
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== previousError) {
        previousError = message
        warn(message)
      }
    }
    await sleep(WATCH_POLL_MS, signal)
  }
}

/** Resolve when the stream is cancelled. */
function holdUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
}

/** Resolve after a delay or when the stream is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
