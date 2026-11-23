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
  /** Whether the selector can resolve current against groups. */
  readonly routable?: boolean | null
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
 * Build the snapshot a mirrored Session should offer.
 *
 * With `remoteOnly`, the Host's own providers are withheld so the menu lists
 * exactly what the remote can run: a mirrored Session sends its prompt to the
 * remote Host, and picking a local model there only costs a rejected round trip
 * or a silent fallback to the remote default. Without it the remote groups are
 * simply appended, which is what an ordinary Session and a host with no catalog
 * still need.
 *
 * A recorded selection whose provider is no longer offered is kept in `current`:
 * the selector matches `current` against `groups` to label its trigger, and
 * dropping it would blank the label. It renders as the session's last choice
 * until the user picks a listed model.
 * @param state - the directory snapshot to extend.
 * @param groups - remote groups to contribute.
 * @param remoteOnly - whether to withhold the Host's own providers.
 * @returns the snapshot to publish.
 */
export function withRemoteGroups(
  state: DirectoryState,
  groups: readonly ProviderGroup[],
  remoteOnly = false,
): DirectoryState {
  const local = state.groups.filter(group => !isRemoteProvider(group.id))
  const base = remoteOnly ? [] : local
  if (groups.length === 0) return { ...state, groups: base }
  return { ...state, groups: [...base, ...groups] }
}

/**
 * Keep a selection only when the offered groups can still resolve it.
 *
 * A mirrored Session's stored selection usually names a local provider, which a
 * remote-only list no longer offers; keeping it would leave the trigger matching
 * nothing and rendering as if no model were chosen.
 * @param current - the selection the directory currently holds.
 * @param groups - the groups about to be offered.
 * @returns the selection when it is still listable, otherwise null.
 */
function pickStillOffered(
  current: DirectoryState['current'],
  groups: readonly ProviderGroup[],
): DirectoryState['current'] {
  if (current === null) return null
  const group = groups.find(item =>
    (item.id === current.provider || item.id === remoteProviderId(current.provider))
    && item.models.some(model => model.id === current.model))
  if (group === undefined) return null
  // The selector's rows always carry the namespaced id, even when the durable
  // projection stores the remote's raw provider id. Preserve object identity
  // when it is already namespaced; returning a fresh object every merge would
  // make the store's change guard fire forever.
  if (current.provider === group.id) return current
  return { ...current, provider: group.id }
}

/** Whether a durable selection names a model the remote catalog offers. */
function isOfferedByRemote(
  current: DirectoryState['current'],
  groups: readonly ProviderGroup[],
): boolean {
  return pickStillOffered(current, groups) !== null
}

/**
 * The remote's own default selection, expressed as a local listable id.
 * @param groups - the contributed groups.
 * @param catalog - the catalog they came from.
 * @returns the default selection, or null when it is not among the groups.
 */
function remoteDefault(
  groups: readonly ProviderGroup[],
  catalog: ModelCatalogResult,
): DirectoryState['current'] {
  const provider = remoteProviderId(catalog.default.provider)
  const group = groups.find(item => item.id === provider)
  if (group === undefined) return null
  if (!group.models.some(model => model.id === catalog.default.model)) return null
  return { provider, model: catalog.default.model }
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
        let target: MirrorTarget | null
        try {
          target = await api.sessionMirror(id)
        } catch {
          // The mirror lookup itself failed; the Session's own list is unknown,
          // so leave the snapshot alone rather than emptying it on a transient
          // error.
          return
        }
        if (target === null) return
        let catalog: ModelCatalogResult | null
        try {
          catalog = await api.modelCatalog(target.hostId)
        } catch {
          // A mirrored Session never falls back to the Host's providers: a local
          // model cannot run there, so offering one would hide the failure behind
          // a choice that silently degrades. An empty list states the problem.
          catalog = null
        }
        const groups = catalog === null ? [] : remoteGroups(catalog)
        const remembered = pickStillOffered(remoteCurrent.get(id) ?? null, groups)
        // Remember which host this Session's rows came from, so a pick can be
        // installed through the right mirror.
        hostOf.set(id, target.hostId)
        const current = directory.store.getSnapshot()
        // A mirrored Session lists exactly what the remote can run. Empty is a
        // truthful answer when the host is unreachable or advertises nothing;
        // the Host's providers are never substituted in.
        const next = catalog === null
          ? { ...withRemoteGroups(current, groups, true), error: 'Remote model catalog is unavailable; reconnect or update the remote agent.' }
          : { ...withRemoteGroups(current, groups, true), error: null }
        // The Session's stored selection comes from the Host's own projection, so
        // a mirrored Session starts out pointing at a local provider — one the
        // remote cannot route. Prefer, in order: the model the user picked here,
        // then a selection the remote catalog still offers, then the remote's own
        // default. Without this the trigger advertises a model that cannot run.
        const intended = remembered
          ?? pickStillOffered(next.current, groups)
          ?? (catalog === null ? null : remoteDefault(groups, catalog))
        // A mirrored Session's durable selection starts as the Host's local
        // model. Installing the remote default (or a remembered remote pick)
        // only in the directory would leave the mirror's prompt path on that
        // local model, so write the choice through the same mirror bridge a user
        // pick uses. A selection already naming a remote-offered model needs no
        // write and is simply normalized to the namespaced id for the menu.
        let choice = intended
        let catalogError: string | null = catalog === null
          ? 'Remote model catalog is unavailable; reconnect or update the remote agent.'
          : null
        if (
          choice !== null
          && !isOfferedByRemote(next.current, groups)
          && !(choice.provider === next.current?.provider && choice.model === next.current.model)
        ) {
          try {
            await api.setSessionModel({
              localSessionId: id,
              provider: decodeRemoteProvider(choice.provider),
              model: choice.model,
              ...choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort },
            })
          } catch (error) {
            choice = null
            catalogError = error instanceof Error ? error.message : String(error)
          }
        }
        const withChoice = {
          ...next,
          ...choice === null ? {} : { current: choice },
          routable: choice !== null,
          status: catalog === null ? 'error' : 'ready',
          error: catalogError,
        }
        // Compare against what the store holds *now*, not against what this
        // function produced last time. The Host rewrites the snapshot whenever a
        // local model is picked, dropping the remote groups; a cached "already
        // applied" flag would then skip the re-application and the remote section
        // would stay missing for the rest of the Session.
        if (sameGroups(withChoice.groups, current.groups)
          && withChoice.current === current.current
          && withChoice.routable === current.routable
          && withChoice.status === current.status
          && withChoice.error === current.error) return
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
      const selectRemote = async (selection: { provider: string; model: string; reasoningEffort?: string }): Promise<{ readonly ok: boolean }> => {
        if (!isRemoteProvider(selection.provider)) {
          // A mirrored Session has no local route: the prompt runs on the
          // remote Host. Refuse rather than hand the Host a provider it cannot
          // resolve, which would only surface later as a failed send.
          if (hostOf.has(id)) return { ok: false }
          return select(selection)
        }
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
        directory.store.set({ ...snapshot, current: decided, routable: true, status: 'ready', error: null })
        // Report success so the selector commits its own pending state; the
        // remote records the choice when the next prompt is sent.
        return { ok: true }
      }
      // Preserve the real directory's other methods (notably load()) while
      // overriding only select. Without forwarding, the selector's first
      // directory.load() call throws TypeError.
      const proxy = new Proxy(directory, {
        get(target, property) {
          if (property === 'select') return selectRemote
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Directory
      wrapped.set(directory, proxy)
      // Re-apply whenever the directory recomputes from the Host catalog, which
      // is what a refresh or a Host reconnect triggers.
      directory.store.subscribe(() => { merge(sessionId, proxy) })
      merge(sessionId, proxy)
      return proxy
    }
  })
}
