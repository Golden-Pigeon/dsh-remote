import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { harness } from './mirror_fixture.ts'

const remoteRoster = [
  { id: 'standard', name: 'Standard mode', isDefault: true },
  { id: 'ptc', name: 'PTC mode', isDefault: false },
]
const localPresets = [
  { id: 'ops-ptc', name: 'Ops PTC' },
  { id: 'standard', name: 'Standard mode' },
  { id: 'ptc', name: 'PTC mode', broken: 'missing plugin' },
]

async function waitFor(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    if (read()) return
    if (Date.now() > deadline) throw new Error('timed out waiting for the remote Session')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('remote agent preset scoping', () => {
  it('starts the mirrored blank on the remote default instead of the local default', async () => {
    const test = harness()
    try {
      await test.service.start()
      test.ctx.provide('agentPresets', { defaultId: 'ops-ptc', list: async () => localPresets } as never)
      test.setRemotePresets(remoteRoster)
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const blank = await test.service.startBlankSession('host-test', { localWorkspaceId })
      const lazy = test.liveAgents.get(blank.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }
      lazy.send({ id: 'preset-default', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await waitFor(() => test.remoteCreates.length > 0)
      assert.equal(test.remoteCreates[0]?.agentPreset, 'standard')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('drops a preset the remote host does not supply and keeps the one it does', async () => {
    const test = harness()
    try {
      await test.service.start()
      test.ctx.provide('agentPresets', { defaultId: 'ops-ptc', list: async () => localPresets } as never)
      test.setRemotePresets(remoteRoster)
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const dropped = await test.service.startBlankSession('host-test', {
        localWorkspaceId,
        agentPreset: 'ops-ptc',
      })
      const lazy = test.liveAgents.get(dropped.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }
      lazy.send({ id: 'preset-dropped', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await waitFor(() => test.remoteCreates.length > 0)
      assert.equal(test.remoteCreates[0]?.agentPreset, 'standard')
      assert.ok(test.warnings.some(warning =>
        warning.includes('does not supply agent preset') && warning.includes('ops-ptc')))

      const kept = await test.service.startBlankSession('host-test', {
        localWorkspaceId,
        agentPreset: 'standard',
      })
      const keptLazy = test.liveAgents.get(kept.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }
      keptLazy.send({ id: 'preset-kept', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await waitFor(() => test.remoteCreates.length > 1)
      assert.equal(test.remoteCreates[1]?.agentPreset, 'standard')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('answers the remote roster for a mirrored Session and nothing for a local one', async () => {
    const test = harness()
    try {
      await test.service.start()
      test.ctx.provide('agentPresets', { defaultId: 'ops-ptc', list: async () => localPresets } as never)
      test.setRemotePresets(remoteRoster)
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const blank = await test.service.startBlankSession('host-test', { localWorkspaceId })
      assert.deepEqual(await test.service.remotePresetsForSession(blank.localSessionId), {
        scoped: true,
        remote: remoteRoster,
      })
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): unknown
      }
      sessions.create('local-session', { meta: { cwd: '/tmp/dsh-remote-local' } })
      // Materializing keeps the same Session scoped through the mirror runtime.
      const lazy = test.liveAgents.get(blank.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }
      lazy.send({ id: 'runtime-scope', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await waitFor(() => test.remoteCreates.length > 0)
      assert.deepEqual(await test.service.remotePresetsForSession(blank.localSessionId), {
        scoped: true,
        remote: remoteRoster,
      })
      assert.deepEqual(await test.service.remotePresetsForSession('local-session'), { scoped: false, remote: [] })
      assert.deepEqual(await test.service.remotePresetsForSession(undefined), { scoped: false, remote: [] })
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('forwards the requested preset when the remote roster cannot be read', async () => {
    const test = harness()
    try {
      await test.service.start()
      test.ctx.provide('agentPresets', { defaultId: 'ops-ptc', list: async () => localPresets } as never)
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      // No setRemotePresets: the roster read fails, as an older agent would.
      const blank = await test.service.startBlankSession('host-test', {
        localWorkspaceId,
        agentPreset: 'ptc',
      })
      const lazy = test.liveAgents.get(blank.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      }
      lazy.send({ id: 'legacy-preset', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      await waitFor(() => test.remoteCreates.length > 0)
      assert.equal(test.remoteCreates[0]?.agentPreset, 'ptc')
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('answers unscoped when the remote roster cannot be read or is empty', async () => {
    const test = harness()
    try {
      await test.service.start()
      test.ctx.provide('agentPresets', { defaultId: 'ops-ptc', list: async () => localPresets } as never)
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const unreadable = await test.service.startBlankSession('host-test', { localWorkspaceId })
      // setRemotePresets is not called: the fixture's roster read fails.
      assert.deepEqual(await test.service.remotePresetsForSession(unreadable.localSessionId), { scoped: false, remote: [] })
      test.setRemotePresets([])
      const empty = await test.service.startBlankSession('host-test', { localWorkspaceId })
      assert.deepEqual(await test.service.remotePresetsForSession(empty.localSessionId), { scoped: false, remote: [] })
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
