import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  installModelCatalogMerge,
  type DirectoryState,
} from '../src/client/model-catalog-merge.ts'

describe('model catalog merge installation', () => {
  it('installs the remote default through the mirror bridge and withholds local models', async () => {
    const calls: Array<{ localSessionId: string; provider: string; model: string }> = []
    let state: DirectoryState = {
      current: { provider: 'local-provider', model: 'local-model' },
      groups: [{ id: 'local-provider', name: 'Local', models: [{ id: 'local-model', name: 'Local Model' }] }],
      failures: [],
      error: null,
      status: 'ready',
    }
    const listeners = new Set<() => void>()
    let loadCalls = 0
    const directory = {
      marker: 'loaded',
      async load(this: { marker: string }) {
        loadCalls += 1
        return this.marker
      },
      store: {
        getSnapshot: () => state,
        set: (next: DirectoryState) => {
          state = next
          for (const listener of listeners) listener()
        },
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      select: async () => ({ ok: true }),
    }
    const resolver = { directoryFor: (_id: string) => directory }
    const ctx = {
      inject: (_deps: string[], callback: (scope: unknown) => void) => {
        callback({ modelDirectories: resolver })
      },
    }
    const api = {
      sessionMirror: async () => ({ hostId: 'host-1', hostLabel: 'host', remoteSessionId: 'remote-1' }),
      modelCatalog: async () => ({
        default: { provider: 'remote-provider', model: 'remote-model' },
        routableProviders: ['remote-provider'],
        groups: [{ id: 'remote-provider', name: 'Remote', models: [{ id: 'remote-model', name: 'Remote Model' }] }],
        failures: [],
      }),
      setSessionModel: async (input: { localSessionId: string; provider: string; model: string }) => {
        calls.push(input)
        return { accepted: true as const }
      },
    }
    installModelCatalogMerge(ctx as never, api as never)
    const wrapped = resolver.directoryFor('session-1')
    assert.equal(await (wrapped as unknown as { load: () => Promise<string> }).load(), 'loaded')
    assert.equal(loadCalls, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(state.groups.map(group => group.id), ['remote:remote-provider'])
    assert.equal(state.current?.provider, 'remote:remote-provider')
    assert.equal(state.routable, true)
    assert.equal(state.status, 'ready')
    assert.deepEqual(calls, [{ localSessionId: 'session-1', provider: 'remote-provider', model: 'remote-model' }])
    const local = await wrapped.select({ provider: 'local-provider', model: 'local-model' })
    assert.deepEqual(local, { ok: false })
    const remote = await wrapped.select({ provider: 'remote:remote-provider', model: 'remote-model' })
    assert.deepEqual(remote, { ok: true })
    assert.equal(state.routable, true)
    assert.equal(state.status, 'ready')
    assert.equal(state.error, null)
    assert.deepEqual(calls.at(-1), { localSessionId: 'session-1', provider: 'remote-provider', model: 'remote-model' })
  })
})
