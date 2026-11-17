import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeRemoteProvider,
  installModelCatalogMerge,
  isRemoteProvider,
  remoteGroups,
  remoteProviderId,
  withRemoteGroups,
  type DirectoryState,
} from '../src/client/model-catalog-merge.ts'
import type { ModelCatalogResult } from '@dsh-remote/protocol'

/** A catalog shaped like the one native1 reports. */
function catalog(): ModelCatalogResult {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-flash' },
    routableProviders: ['deepseek-official'],
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low', description: 'routine tasks' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'stronger' },
      ],
    }],
    failures: [],
  }
}

describe('remote model catalog merge', () => {
  it('round-trips the provider id through its local namespace', () => {
    // The local id keeps remote providers out of the Host's namespace, and the
    // decode step is what the remote receives, so both directions must agree.
    const local = remoteProviderId('deepseek-official')
    assert.equal(local, 'remote:deepseek-official')
    assert.equal(isRemoteProvider(local), true)
    assert.equal(decodeRemoteProvider(local), 'deepseek-official')
  })

  it('treats local provider ids as local', () => {
    assert.equal(isRemoteProvider('deepseek-official'), false)
    assert.equal(isRemoteProvider('remoteish'), false)
    assert.equal(isRemoteProvider(''), false)
  })

  it('keeps one group per remote provider, carrying every model', () => {
    const groups = remoteGroups(catalog())
    assert.equal(groups.length, 1)
    const group = groups[0]!
    assert.equal(group.id, 'remote:deepseek-official')
    assert.deepEqual(group.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('qualifies the group name with a remote marker', () => {
    // A local provider and a remote one are commonly named after the same
    // vendor, and the selector renders `name` verbatim, so the marker is what
    // keeps the two sections distinguishable.
    const group = remoteGroups(catalog())[0]!
    assert.equal(group.name, 'Remote · DeepSeek', 'the name must mark the section remote')
    assert.ok(!group.name.includes('('), 'the host suffix is deliberately omitted')
  })

  it('preserves reasoning metadata for the selector', () => {
    const group = remoteGroups(catalog())[0]!
    const flash = group.models.find(model => model.id === 'deepseek-flash')!
    assert.equal(flash.reasoning?.defaultEffort, 'high')
    assert.deepEqual(flash.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
    assert.equal(flash.reasoning?.efforts[0]?.description, 'routine tasks')
  })

  it('contributes nothing when the remote reports no models', () => {
    // An empty catalog must leave the local list exactly as the Host built it,
    // otherwise a disconnected host would appear as an empty provider group.
    assert.deepEqual(remoteGroups({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [],
      failures: [],
    }), [])
  })

  it('skips a remote group that advertises no models', () => {
    const groups = remoteGroups({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [{ id: 'empty-provider', name: 'Empty', models: [] }],
      failures: [],
    })
    assert.deepEqual(groups, [], 'an empty provider group would render as a blank section')
  })
})

describe('directory snapshot merge', () => {
  /** A snapshot shaped like the one ModelDirectory publishes. */
  function state(overrides: Partial<DirectoryState> = {}): DirectoryState {
    return {
      current: null,
      groups: [{ id: 'local-provider', name: 'Local', models: [{ id: 'local-model', name: 'Local' }] }],
      failures: [],
      error: null,
      status: 'ready',
      ...overrides,
    }
  }

  it('appends remote groups after the local ones', () => {
    const merged = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    assert.deepEqual(merged.groups.map(group => group.id), [
      'local-provider',
      'remote:deepseek-official',
    ])
    assert.equal(merged.status, 'ready', 'unrelated fields must survive')
  })

  it('withholds the local groups when only the remote list is usable', () => {
    // A mirrored Session sends its prompt to the remote Host, so a local provider
    // in the list is a choice that cannot run.
    const merged = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ], true)
    assert.deepEqual(merged.groups.map(group => group.id), ['remote:deepseek-official'])
  })

  it('keeps the local groups when nothing is withheld', () => {
    const merged = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ], false)
    assert.deepEqual(merged.groups.map(group => group.id), [
      'local-provider',
      'remote:deepseek-official',
    ])
  })

  it('replaces the previous remote contribution instead of duplicating it', () => {
    const first = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const second = withRemoteGroups(first, [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'Pro' }] },
    ])
    const remote = second.groups.filter(group => group.id.startsWith('remote:'))
    assert.equal(remote.length, 1, 'a refresh must not stack duplicate remote providers')
    assert.deepEqual(remote[0]?.models.map(model => model.id), ['deepseek-v4-pro'])
  })

  it('drops the remote contribution when the catalog reports nothing', () => {
    const withRemote = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const cleared = withRemoteGroups(withRemote, [])
    assert.deepEqual(cleared.groups.map(group => group.id), ['local-provider'])
  })

  it('keeps a recorded remote pick while the rows are re-applied', () => {
    // The selector matches `current` against the offered rows to build its label,
    // and a Host refresh rebuilds that snapshot, so the recorded pick has to
    // survive re-application or the trigger falls back to "select a model".
    const picked = state({
      current: { provider: 'remote:deepseek-official', model: 'deepseek-v4-pro' },
    })
    const reapplied = withRemoteGroups(picked, [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'Pro' }] },
    ])
    assert.deepEqual(reapplied.current, {
      provider: 'remote:deepseek-official',
      model: 'deepseek-v4-pro',
    })
  })
})

describe('installed merge commit path', () => {
  /**
   * Minimal fake of `ctx.modelDirectories`, enough to exercise the wrapper: a
   * resolver whose directory exposes the store and select the wrapper needs.
   * Returns the *wrapped* resolver so the commit path is what gets called.
   * @param options - `catalogFails` simulates an unreachable remote catalog.
   */
  function harness(options: { catalogFails?: boolean } = {}) {
    let listener: (() => void) | undefined
    const store = {
      state: {
        current: null as { provider: string; model: string } | null,
        groups: [] as readonly { id: string; name: string; models: { id: string; name: string }[] }[],
        failures: [],
        error: null,
        status: 'ready',
      },
      getSnapshot() { return this.state },
      set(next: typeof store.state) { this.state = next; listener?.() },
      subscribe(fn: () => void) { listener = fn; return () => { listener = undefined } },
    }
    const committed: { provider: string; model: string }[] = []
    /** Local providers the Host would publish on its own. */
    const localGroups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }]
    const directory = {
      store,
      async select(selection: { provider: string; model: string }) {
        committed.push(selection)
        // The Host rebuilds the snapshot from its own catalog on a local pick,
        // which is exactly what drops the contributed remote groups.
        store.set({
          ...store.getSnapshot(),
          current: selection,
          groups: localGroups,
        })
        return { ok: true }
      },
    }
    /** Seed the snapshot as the Host would after its first catalog load. */
    store.set({ ...store.getSnapshot(), groups: localGroups })
    const resolver = { directoryFor: () => directory as never }
    const ctx = {
      inject(_keys: string[], callback: (scope: unknown) => void) {
        callback({ modelDirectories: resolver })
      },
    }
    const sent: { provider: string; model: string }[] = []
    const api = {
      sessionMirror: async () => ({ hostId: 'h1', hostLabel: 'native1', remoteSessionId: 'r1' }),
      modelCatalog: async () => {
        if (options.catalogFails === true) throw new Error('host unreachable')
        return catalog()
      },
      setSessionModel: async (input: { provider: string; model: string }) => {
        sent.push({ provider: input.provider, model: input.model })
        return { accepted: true as const }
      },
    }
    return { ctx, api, store, committed, sent, resolver }
  }

  it('forwards a remote pick to the mirror bridge and records it locally', async () => {
    const h = harness()
    installModelCatalogMerge(h.ctx as never, h.api as never)

    // `directoryFor` installs the wrapper and starts the merge; the merge itself
    // resolves the mirror asynchronously before it publishes.
    const wrapped = h.resolver.directoryFor() as unknown as {
      select: (selection: { provider: string; model: string }) => Promise<{ ok: boolean }>
    }
    await new Promise(resolve => { setTimeout(resolve, 50) })

    const groups = h.store.getSnapshot().groups
    assert.ok(groups.some(group => group.id === 'remote:deepseek-official'),
      'the merge must publish the remote group before a pick can be addressed')

    const result = await wrapped.select({ provider: 'remote:deepseek-official', model: 'deepseek-v4-pro' })

    assert.equal(result.ok, true, 'picking a remote row must be accepted')
    assert.deepEqual(h.sent, [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
      'the remote must receive the provider id its own catalog reported')
    assert.deepEqual(h.store.getSnapshot().current, {
      provider: 'remote:deepseek-official',
      model: 'deepseek-v4-pro',
    }, 'the directory must record the pick so the trigger can render it')
    assert.equal(h.committed.length, 0,
      'a remote pick must not reach the Host selectModel, which cannot resolve it')
  })

  it('keeps offering the remote group after a local pick replaces the snapshot', async () => {
    // Reproduction: pick a remote model, then pick a local one. The Host rebuilds
    // the snapshot from its own catalog on the local pick, so the contributed
    // remote group disappears — and a merge that trusts a cached "already
    // applied" flag never puts it back, leaving the user unable to switch back.
    const h = harness()
    installModelCatalogMerge(h.ctx as never, h.api as never)

    const wrapped = h.resolver.directoryFor() as unknown as {
      select: (selection: { provider: string; model: string }) => Promise<{ ok: boolean }>
    }
    await new Promise(resolve => { setTimeout(resolve, 50) })
    const hasRemote = (): boolean =>
      h.store.getSnapshot().groups.some(group => group.id.startsWith('remote:'))
    assert.equal(hasRemote(), true, 'step 1: the remote group is offered')

    await wrapped.select({ provider: 'remote:deepseek-official', model: 'deepseek-v4-pro' })
    assert.equal(hasRemote(), true, 'step 1: picking a remote model keeps the group')

    await wrapped.select({ provider: 'deepseek-official', model: 'deepseek-flash' })
    // The subscription re-runs the merge asynchronously.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    assert.equal(hasRemote(), true,
      'step 2: after a local pick the remote group must still be offered')
  })

  it('lists only the remote groups for a mirrored Session', async () => {
    const h = harness()
    installModelCatalogMerge(h.ctx as never, h.api as never)
    h.resolver.directoryFor()
    await new Promise(resolve => { setTimeout(resolve, 50) })

    const ids = h.store.getSnapshot().groups.map(group => group.id)
    assert.deepEqual(ids, ['remote:deepseek-official'],
      'a mirrored Session must not offer providers the remote cannot route')
  })

  it('defaults a mirrored Session to the remote catalog default', async () => {
    // The Host's own default is a local provider, so a mirrored Session would
    // advertise a model it cannot run until the user picks one.
    const h = harness()
    installModelCatalogMerge(h.ctx as never, h.api as never)
    h.resolver.directoryFor()
    await new Promise(resolve => { setTimeout(resolve, 50) })

    assert.deepEqual(h.store.getSnapshot().current, {
      provider: 'remote:deepseek-official',
      model: 'deepseek-flash',
    }, 'the trigger must start on a model the remote catalog offers')
  })

  it('replaces an unroutable stored selection with the remote default', async () => {
    const h = harness()
    // The Host projects its own default: a local provider the remote cannot run.
    h.store.set({
      ...h.store.getSnapshot(),
      current: { provider: 'tt-switch-local', model: 'deepseek-v4.1-flash' },
      groups: [{ id: 'tt-switch-local', name: 'TT', models: [{ id: 'deepseek-v4.1-flash', name: 'F' }] }],
    })
    installModelCatalogMerge(h.ctx as never, h.api as never)
    h.resolver.directoryFor()
    await new Promise(resolve => { setTimeout(resolve, 50) })

    assert.deepEqual(h.store.getSnapshot().current, {
      provider: 'remote:deepseek-official',
      model: 'deepseek-flash',
    }, 'a selection the remote cannot route must not survive the merge')
  })

  it('stays empty instead of falling back to the Host list', async () => {
    // Falling back would hide the failure behind models the remote cannot run:
    // the menu would look healthy and every pick would silently degrade.
    const h = harness({ catalogFails: true })
    installModelCatalogMerge(h.ctx as never, h.api as never)
    h.resolver.directoryFor()
    await new Promise(resolve => { setTimeout(resolve, 50) })

    assert.deepEqual(h.store.getSnapshot().groups, [],
      'an unreachable remote must leave the list empty, not borrow the Host providers')
    assert.equal(h.store.getSnapshot().current, null,
      'no routable selection can be advertised while the remote is unreachable')
  })

  it('refuses a local pick in a mirrored Session', async () => {
    // The prompt runs on the remote Host, so a local provider is not a real
    // option; accepting it would only move the failure to send time.
    const h = harness()
    installModelCatalogMerge(h.ctx as never, h.api as never)
    const wrapped = h.resolver.directoryFor() as unknown as {
      select: (selection: { provider: string; model: string }) => Promise<{ ok: boolean }>
    }
    await new Promise(resolve => { setTimeout(resolve, 50) })

    const result = await wrapped.select({ provider: 'tt-switch-local', model: 'deepseek-v4.1-flash' })

    assert.equal(result.ok, false, 'a local pick must not be accepted for a mirror')
    assert.equal(h.committed.length, 0, 'it must not reach the Host selectModel either')
    assert.equal(h.sent.length, 0, 'and it must not be forwarded to the remote')
  })
})
