/**
 * Merge a mirrored Session's remote models into the shared model catalog.
 *
 * Every model selector in the client — the native composer seat and any skin
 * that renders its own menu — reads the same per-Session directory:
 *
 * ```
 * ctx.remote.session.modelCatalog()          Host catalog (local providers only)
 *   → ModelCatalogDirectory.store
 *     → ModelDirectory.store.groups          read by every selector
 * ```
 *
 * A skin that replaces the native seat therefore ignores contributions made
 * through slot registration, because it never renders those slots. Injecting at
 * the directory instead reaches both renderers, and is the only seam that does.
 *
 * Two things have to move together: the offered `groups`, and the commit path.
 * The directory commits a pick through the Host's own `session.selectModel`,
 * which cannot resolve a remote-only provider, so a remote row must be routed to
 * the mirror bridge that installs the selection on the remote Session.
 *
 * @module dsh-remote-local/model-catalog-merge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'
import type { MirrorTarget } from '../host-api/contract.ts'
import type { ModelCatalogResult, RemoteModel } from '@dsh-remote/protocol'

/** Prefix that keeps remote provider ids out of the Host's provider namespace. */
export const REMOTE_PROVIDER_PREFIX = 'remote:'

/** One provider group as the selectors expect it. */
interface ProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly SelectorModel[]
}

/** One model as the selectors expect it. */
interface SelectorModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
    readonly defaultEffort?: string
  }
}

/**
 * The slice of a directory store this module reads and writes.
 *
 * `current` is what the selector matches a row against to decide its label, so a
 * pick has to be recorded here as well as forwarded to the remote. Leaving it
 * alone makes the trigger fall back to "select a model" even though the remote
 * accepted the choice.
 */
export interface DirectoryState {
  readonly current: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null
  readonly groups: readonly ProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  readonly error: string | null
  readonly status: string
}

/** The slice of a per-Session directory this module wraps. */
interface Directory {
  readonly store: {
    getSnapshot: () => DirectoryState
    set: (next: DirectoryState) => void
    subscribe: (listener: () => void) => () => void
  }
  select: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<
    { readonly ok: boolean }
  >
}

/** The slice of the root resolver this module wraps. */
interface DirectoryResolver {
  directoryFor: (sessionId: string) => Directory
}

/** Whether a provider id names a model that only exists on a mirrored host. */
export function isRemoteProvider(provider: string): boolean {
  return provider.startsWith(REMOTE_PROVIDER_PREFIX)
}

/** Local id offered to the selector for one remote provider. */
export function remoteProviderId(providerId: string): string {
  return `${REMOTE_PROVIDER_PREFIX}${providerId}`
}

/**
 * Build the provider groups a mirrored host contributes.
 *
 * One provider per remote catalog group, not one per host: a selection is a
 * `provider/model` pair the remote resolves itself, so the provider id it
 * receives has to be the id its own catalog reports. The local face of that id
 * is namespaced instead, and {@link decodeRemoteProvider} recovers the pair.
 *
 * The group name is qualified because the selector renders `name` verbatim and a
 * remote provider is usually named after the same vendor as a local one — two
 * unlabelled "DeepSeek" sections give no way to tell which list a mirrored
 * Session can actually run.
 * @param catalog - the catalog the remote reported.
 * @returns groups ready to append to a directory's `groups`.
 */
export function remoteGroups(catalog: ModelCatalogResult): ProviderGroup[] {
  const groups: ProviderGroup[] = []
  for (const group of catalog.groups) {
    const models = group.models.map(toSelectorModel)
    if (models.length === 0) continue
    groups.push({
      id: remoteProviderId(group.id),
      name: remoteGroupName(group.name),
      models,
    })
  }
  return groups
}

/**
 * Qualify a remote provider name so it reads as remote, not as another vendor row.
 *
 * The selector renders this string verbatim, and several renderers ignore
 * styling hooks, so the distinction has to live in the text itself. `Remote` is
 * a fixed marker rather than a translated word: the provider name came from the
 * remote's own catalog and is not localized here either, and mixing a translated
 * marker with an untranslated name reads worse than a plain one.
 *
 * The host name is deliberately omitted: it lengthens every row and the mirror a
 * Session belongs to is already the Session's own context, so the marker alone
 * carries the information a pick depends on.
 * @param groupName - provider name as the remote catalog reported it.
 * @returns the label to show for that remote provider.
 */
export function remoteGroupName(groupName: string): string {
  return `Remote · ${groupName}`
}

/**
 * Recover the remote provider id from a namespaced local one.
 * @param local - a provider id as offered to the selector.
 * @returns the provider id the remote catalog reported.
 */
export function decodeRemoteProvider(local: string): string {
  return local.slice(REMOTE_PROVIDER_PREFIX.length)
}

/** Project a remotely reported model into the selector's model shape. */
function toSelectorModel(model: RemoteModel): SelectorModel {
  const reasoning = model.reasoning === undefined
    ? undefined
    : {
      efforts: model.reasoning.efforts.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
      ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
    }
  return {
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * Append the remote groups to one directory snapshot, replacing any previous
 * contribution from the same host so a refresh cannot duplicate rows.
 * @param state - the directory snapshot to extend.
 * @param groups - remote groups to contribute.
 * @returns the extended snapshot.
 */
export function withRemoteGroups(state: DirectoryState, groups: readonly ProviderGroup[]): DirectoryState {
  const local = state.groups.filter(group => !isRemoteProvider(group.id))
  if (groups.length === 0) return { ...state, groups: local }
  return { ...state, groups: [...local, ...groups] }
}

/**
 * Whether two group lists would render the same sections.
 *
 * Compared by value, not identity: `withRemoteGroups` always builds a fresh
 * array, so an identity check would report a change on every pass and the store
 * subscription would re-enter the merge forever.
 * @param left - one group list.
 * @param right - the other.
 * @returns whether they offer the same sections.
 */
function sameGroups(left: readonly ProviderGroup[], right: readonly ProviderGroup[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.id !== b.id || a.name !== b.name || a.models.length !== b.models.length) return false
    for (let model = 0; model < a.models.length; model += 1) {
      if (a.models[model]?.id !== b.models[model]?.id) return false
    }
  }
  return true
}

/**
 * Install the catalog merge for every mirrored Session.
 *
 * Wraps the root resolver once: each `directoryFor` call is memoized by the
 * resolver itself, so wrapping the returned directory is idempotent per Session
 * and the wrapper survives for the Session's lifetime.
 * @param ctx - client context carrying `modelDirectories` and the session scope.
 * @param api - host API used for the remote catalog and the mirror bridge.
 */
export function installModelCatalogMerge(ctx: Context, api: HostsApi): void {
  ctx.inject(['modelDirectories'], scope => {
    const resolver = (scope as unknown as { modelDirectories?: DirectoryResolver }).modelDirectories
    if (resolver === undefined || typeof resolver.directoryFor !== 'function') return
    const original = resolver.directoryFor.bind(resolver)
    const wrapped = new WeakMap<object, Directory>()
    /**
     * Host that contributed a Session's rows, which a pick must be sent to.
     *
     * Keyed by the Session id, not by the directory object: `merge()` runs
     * against the wrapper while `select()` closes over the original, so an
     * object key set on one side is never visible from the other.
     */
    const hostOf = new Map<string, string>()
    /**
     * The remote pick made for a Session.
     *
     * A Host refresh rebuilds `current` from the local projection, which knows
     * nothing about a remote provider, so the pick would be dropped from the
     * trigger. Re-applying it here keeps the label stable across refreshes; the
     * remote is the authority for what actually runs, and this only mirrors it.
     * Keyed by Session id so the commit path and the merge path agree.
     */
    const remoteCurrent = new Map<string, DirectoryState['current']>()

    const merge = (sessionId: string, directory: Directory): void => {
      const id = String(sessionId)
      void (async () => {
        let target: MirrorTarget
        try {
          target = await api.sessionMirror(id)
        } catch {
          return
        }
        if (target === null) return
        let catalog: ModelCatalogResult
        try {
          catalog = await api.modelCatalog(target.hostId)
        } catch {
          return
        }
        const groups = remoteGroups(catalog)
        const remembered = remoteCurrent.get(id) ?? null
        // Remember which host this Session's rows came from, so a pick can be
        // installed through the right mirror.
        hostOf.set(id, target.hostId)
        const current = directory.store.getSnapshot()
        const next = withRemoteGroups(current, groups)
        const withChoice = remembered === null || remembered === next.current
          ? next
          : { ...next, current: remembered }
        // Compare against what the store holds *now*, not against what this
        // function produced last time. The Host rewrites the snapshot whenever a
        // local model is picked, dropping the remote groups; a cached "already
        // applied" flag would then skip the re-application and the remote section
        // would stay missing for the rest of the Session.
        if (sameGroups(withChoice.groups, current.groups) && withChoice.current === current.current) return
        directory.store.set(withChoice)
      })()
    }

    resolver.directoryFor = (sessionId: string): Directory => {
      const directory = original(sessionId)
      // The commit path and the merge must key their bookkeeping identically;
      // `merge` normalizes to a string, so this does too.
      const id = String(sessionId)
      const cached = wrapped.get(directory)
      if (cached !== undefined) {
        merge(sessionId, cached)
        return cached
      }
      // Commit path: a remote row is installed through the mirror bridge instead
      // of the Host's own selectModel, which cannot resolve a remote provider.
      const select = directory.select.bind(directory)
      const proxy: Directory = {
        store: directory.store,
        select: async selection => {
          if (!isRemoteProvider(selection.provider)) return select(selection)
          if (hostOf.get(id) === undefined) {
            // Until the catalog contributed rows there is nothing to address; a
            // pick here would install a selection the remote cannot route.
            return { ok: false }
          }
          await api.setSessionModel({
            localSessionId: id,
            // The remote resolves `provider/model` against its own catalog, so it
            // must receive the id its catalog reported, not the local alias.
            provider: decodeRemoteProvider(selection.provider),
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          })
          // Record the pick in the same shape a local selection takes. The
          // selector derives its trigger label by matching `current` against the
          // offered rows, so forwarding the choice without recording it leaves the
          // trigger reading "select a model" after a successful pick.
          const decided: NonNullable<DirectoryState['current']> = {
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
          }
          remoteCurrent.set(id, decided)
          const snapshot = directory.store.getSnapshot()
          directory.store.set({ ...snapshot, current: decided })
          // Report success so the selector commits its own pending state; the
          // remote records the choice when the next prompt is sent.
          return { ok: true }
        },
      }
      wrapped.set(directory, proxy)
      // Re-apply whenever the directory recomputes from the Host catalog, which
      // is what a refresh or a Host reconnect triggers.
      directory.store.subscribe(() => { merge(sessionId, proxy) })
      merge(sessionId, proxy)
      return proxy
    }
  })
}
