/**
 * Keep the native hero chip's preset roster honest about a mirrored Session.
 *
 * DSH offers the deployment's own presets there, but a mirrored Session runs on
 * the remote host: choosing a preset that host does not declare fails the whole
 * Session creation on the first prompt. This adapter narrows the native menu's
 * rows to the presets both sides declare, for the Sessions a remote host owns.
 *
 * Only the remote roster comes from the host; the local rows stay exactly as
 * the native read produced them, and every failure falls through untouched so
 * the chip keeps rendering as it does without this plugin.
 *
 * @module dsh-remote-local/client/preset-scope
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'

/** How long a roster read waits for the host before keeping the native rows. */
const SCOPE_TIMEOUT_MS = 1_500

/** Marks an adapter wrapper and carries the native method it replaced. */
const ADAPTER = Symbol.for('dsh-remote.preset-scope')

/** Namespaces already carrying an adapter in this page. */
const scopedNamespaces = new WeakSet<object>()

/** The native roster rows this adapter reads. */
interface RosterRow {
  readonly id: string
  readonly isDefault: boolean
}

/** A successful native roster result. */
interface RosterResult {
  readonly ok: true
  readonly value: { readonly presets: readonly RosterRow[] }
}

/** A method wrapped by this adapter. */
interface AdaptedList {
  (...args: unknown[]): Promise<unknown>
  readonly [ADAPTER]?: (...args: unknown[]) => Promise<unknown>
}

/**
 * Narrow a native roster result without assuming a private DSH type.
 * @param result - the method's resolved value.
 * @returns whether it carries a preset list.
 */
function isRosterResult(result: unknown): result is RosterResult {
  if (typeof result !== 'object' || result === null) return false
  if (Reflect.get(result, 'ok') !== true) return false
  const value = Reflect.get(result, 'value')
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray(Reflect.get(value, 'presets'))
}

/**
 * Read the main-view Session id without failing the native roster read.
 * @param read - the main-view Session id reader.
 * @returns the Session id, when one is bound.
 */
function sessionIdOf(read: () => string | undefined): string | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * The presets the Session's remote host declares, or undefined to keep the
 * native rows.
 * @param api - host API client.
 * @param sessionId - the Session the chip is drafting into.
 * @returns remote presets, when the Session is a scoped remote one.
 */
async function remotePresets(
  api: HostsApi,
  sessionId: string,
): Promise<Awaited<ReturnType<HostsApi['presetScope']>>['remote'] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const scope = await Promise.race([
      api.presetScope({ sessionId }),
      new Promise<undefined>(resolve => {
        timer = globalThis.setTimeout(() => { resolve(undefined) }, SCOPE_TIMEOUT_MS)
      }),
    ])
    if (scope === undefined || !scope.scoped || scope.remote.length === 0) return undefined
    return scope.remote
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer)
  }
}

/**
 * Install the roster adapter once per client mount.
 *
 * A reload re-runs this module, so the wrapper carries the native method it
 * replaced: installing again reuses that method instead of stacking a second
 * adapter on top of the previous mount's.
 *
 * @param ctx - client plugin context.
 * @param api - host API client.
 * @param currentSessionId - the main-view Session id.
 */
export function installRemotePresetScope(
  ctx: Context,
  api: HostsApi,
  currentSessionId: () => string | undefined,
): void {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const namespace = typeof get === 'function' ? get.call(ctx, 'remote.agentPresets') : undefined
  if (typeof namespace !== 'object' || namespace === null) return
  const target = namespace as Record<string, unknown>
  if (scopedNamespaces.has(target)) return
  const current = Reflect.get(target, 'list')
  if (typeof current !== 'function') return
  const original = (current as AdaptedList)[ADAPTER] ?? current
  scopedNamespaces.add(target)
  const scoped: AdaptedList = async (...args: unknown[]): Promise<unknown> => {
    const result: unknown = await (original as (...values: unknown[]) => Promise<unknown>).apply(target, args)
    if (!isRosterResult(result)) return result
    const sessionId = sessionIdOf(currentSessionId)
    if (sessionId === undefined) return result
    const remote = await remotePresets(api, sessionId)
    if (remote === undefined) return result
    const available = new Set(remote.map(preset => preset.id))
    const presets = result.value.presets.filter(row => available.has(row.id))
    // An empty subset would render no chip at all; keep the native roster.
    if (presets.length === 0) return result
    const defaultId = remote.find(preset => preset.isDefault)?.id
    return {
      ...result,
      value: {
        ...result.value,
        presets: presets.map(row => ({ ...row, isDefault: row.id === defaultId })),
      },
    }
  }
  Object.defineProperty(scoped, ADAPTER, { value: original })
  Object.defineProperty(target, 'list', {
    configurable: true,
    enumerable: true,
    value: scoped,
  })
}
