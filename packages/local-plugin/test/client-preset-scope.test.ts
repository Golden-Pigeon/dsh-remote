import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installRemotePresetScope } from '../src/client/preset-scope.ts'

const roster = {
  presets: [
    { id: 'ops-ptc', name: 'Ops PTC', isDefault: true },
    { id: 'standard', name: 'Standard mode', isDefault: false },
    { id: 'ptc', name: 'PTC mode', isDefault: false, broken: 'missing plugin' },
  ],
}

/** A namespace stub shaped like the generated Client Remote service. */
function namespaceWith(list: () => Promise<unknown>): Record<string, unknown> {
  return { list, select: async () => ({ ok: true, value: 'standard' }) }
}

function contextWith(namespace: Record<string, unknown>): never {
  return { get: (name: string) => name === 'remote.agentPresets' ? namespace : undefined } as never
}

const remoteScope = { scoped: true, remote: [{ id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false }] }

describe('client preset scope adapter', () => {
  it('narrows the native roster to the presets the remote declares', async () => {
    const namespace = namespaceWith(async () => ({ ok: true, value: roster }))
    const ctx = contextWith(namespace)
    installRemotePresetScope(ctx, { presetScope: async () => remoteScope } as never, () => 'blank-1')
    const result = await (namespace.list as () => Promise<{ value: { presets: { id: string; isDefault: boolean }[] } }>)()
    assert.deepEqual(result.value.presets.map(row => row.id), ['standard', 'ptc'])
    assert.equal(result.value.presets[0]?.isDefault, true)
  })

  it('reuses the native method when the adapter is installed twice', async () => {
    let nativeCalls = 0
    const namespace = namespaceWith(async () => {
      nativeCalls += 1
      return { ok: true, value: roster }
    })
    const api = { presetScope: async () => remoteScope } as never
    installRemotePresetScope(contextWith(namespace), api, () => 'blank-1')
    installRemotePresetScope(contextWith(namespace), api, () => 'blank-1')
    const result = await (namespace.list as () => Promise<{ value: { presets: { id: string }[] } }>)()
    assert.equal(nativeCalls, 1)
    assert.deepEqual(result.value.presets.map(row => row.id), ['standard', 'ptc'])
  })

  it('keeps the native roster for local Sessions and unusable subsets', async () => {
    for (const presetScope of [
      async () => ({ scoped: false, remote: [] }),
      async () => ({ scoped: true, remote: [] }),
      async () => ({ scoped: true, remote: [{ id: 'remote-only', isDefault: true }] }),
      async () => { throw new Error('host unavailable') },
    ]) {
      const namespace = namespaceWith(async () => ({ ok: true, value: roster }))
      const ctx = contextWith(namespace)
      installRemotePresetScope(ctx, { presetScope } as never, () => 'blank-1')
      const list = namespace.list as () => Promise<{ value: { presets: readonly unknown[] } }>
      assert.deepEqual(await list(), { ok: true, value: roster })
    }
    const namespace = namespaceWith(async () => ({ ok: true, value: roster }))
    installRemotePresetScope(contextWith(namespace), { presetScope: async () => remoteScope } as never, () => undefined)
    const list = namespace.list as () => Promise<{ value: { presets: readonly unknown[] } }>
    assert.deepEqual(await list(), { ok: true, value: roster })
  })
})
