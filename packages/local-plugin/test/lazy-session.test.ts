import assert from 'node:assert/strict'
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

describe('ephemeral remote drafts', () => {
  it('archives an unsent draft when the plugin is disposed', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const blank = await test.service.startBlankSession('host-test', { localWorkspaceId })
      await test.service.dispose()
      assert.equal(test.archived.includes(blank.localSessionId), true)
    } finally {
      await test.ctx.fiber.dispose()
    }
  })
})

describe('native draft promotion', () => {
  it('promotes the first native prompt into a remote mirror without running a local step', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-draft', { meta: { cwd: anchor } })
      const message = { id: 'native-message', role: 'user', content: [{ type: 'text', text: 'promote me' }] }
      const decision = await test.ctx.waterfall('agent/pre-step' as never, {
        agent: { id: native.id, session: native },
        messages: [message],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
      assert.equal((decision as { kind: string }).kind, 'reject')
      assert.equal(test.remoteCreates.length, 1)
      assert.equal(test.prompts.length, 1)
      assert.equal(test.prompts[0]?.text, 'promote me')
      assert.ok(test.service.takeOpenSessionId())
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
