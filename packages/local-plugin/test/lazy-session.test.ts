import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { harness } from './mirror_fixture.ts'

describe('lazy remote Session creation', () => {
  it('keeps the native blank Session and creates the remote Session with its selected preset', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const projection = (session: { snapshotEvents(): Array<{ type: string; data: unknown }> }): unknown => {
        for (const event of [...session.snapshotEvents()].reverse()) {
          if (event.type !== 'agent-preset/selected') continue
          const preset = (event.data as { agentPreset?: unknown }).agentPreset
          if (typeof preset === 'string') return preset
        }
        return undefined
      }
      const modelProjection = (session: { snapshotEvents(): Array<{ type: string; data: unknown }> }): unknown => {
        for (const event of [...session.snapshotEvents()].reverse()) {
          if (event.type !== 'model/selection') continue
          const data = event.data as { provider?: unknown; model?: unknown }
          if (typeof data.provider === 'string' && typeof data.model === 'string') {
            return { lastUsed: { provider: data.provider, model: data.model } }
          }
        }
        return undefined
      }
      test.ctx.provide('sessionProjections', {
        stateOf: (session: never, key: string) => key === 'agentPreset'
          ? projection(session)
          : key === 'modelSelection' ? modelProjection(session) : undefined,
      } as never)
      test.ctx.provide('agentPresets', {
        defaultId: 'standard',
        select: (agent: { session: { append(type: string, data: unknown): void } }, id: string) => {
          agent.session.append('agent-preset/selected', { agentPreset: id })
          return id
        },
      } as never)
      const blank = await test.service.startBlankSession('host-test', {
        localWorkspaceId,
        agentPreset: 'standard',
      })
      const before = JSON.parse(await readFile(join(test.stateDir, 'mirrors.json'), 'utf8'))
      assert.equal(before.pendingBlanks?.[blank.localSessionId]?.localSessionId, blank.localSessionId)
      const lazy = test.liveAgents.get(blank.localSessionId) as unknown as {
        send(message: unknown, target?: unknown, wakeup?: boolean): void
      } & { session: { append(type: string, data: unknown): void } }
      await (test.ctx.get('agentPresets') as unknown as {
        select(agent: unknown, id: string): Promise<string>
      }).select(lazy, 'ptc')
      ;(lazy as unknown as {
        model: { select(selection: { provider: string; model: string }): void }
      }).model.select({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
      lazy.send({ id: 'message-1', role: 'user', content: [{ type: 'text', text: 'hello' }] }, undefined, true)
      for (let attempt = 0; attempt < 100 && test.prompts.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(test.remoteCreates.length, 1)
      assert.equal(test.remoteCreates[0]?.agentPreset, 'ptc')
      assert.equal(test.prompts.length, 1)
      assert.equal(test.prompts[0]?.text, 'hello')
      assert.equal(test.prompts[0]?.selection?.model, 'deepseek-reasoner')
      const state = await test.state()
      const mapped = Object.values(state.sessions).find(session => session.localSessionId === blank.localSessionId)
      assert.ok(mapped)
      assert.ok(test.liveAgents.has(blank.localSessionId))
      const persisted = JSON.parse(await readFile(join(test.stateDir, 'mirrors.json'), 'utf8'))
      assert.equal(persisted.pendingBlanks?.[blank.localSessionId], undefined)
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})

describe('blank remote Session deduplication', () => {
  it('coalesces concurrent blank-session creation for one workspace', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const [first, second] = await Promise.all([
        test.service.startBlankSession('host-test', { localWorkspaceId }),
        test.service.startBlankSession('host-test', { localWorkspaceId }),
      ])
      assert.equal(first.localSessionId, second.localSessionId)
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})

describe('pending blank Session recovery', () => {
  it('restores the lazy Agent after an in-process service restart', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const blank = await test.service.startBlankSession('host-test', { localWorkspaceId, agentPreset: 'ptc' })
      await test.service.dispose()
      assert.equal(test.liveAgents.has(blank.localSessionId), false)
      const restarted = test.newService()
      try {
        await restarted.start()
        assert.equal(test.liveAgents.has(blank.localSessionId), true)
      } finally {
        await restarted.dispose()
      }
    } finally {
      await test.ctx.fiber.dispose()
    }
  })
})
