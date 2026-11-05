import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
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

  it('retries a failed promotion against the same remote Session', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'retry-message', role: 'user', content: [{ type: 'text', text: 'retry me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setFailPrompt(false)
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['retry me'])
        assert.ok(test.service.takeOpenSessionId())
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('retries after an early host-disconnected promotion failure', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-host-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'host-retry-message', role: 'user', content: [{ type: 'text', text: 'host retry' }] }
        test.setHostPhase('disconnected')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 0)
        test.setHostPhase('connected')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['host retry'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not fall back to local when a promotion retry loses its workspace', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-lost-target', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'lost-target', role: 'user', content: [{ type: 'text', text: 'stay remote' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        native.header.cwd = '/tmp/not-a-mirror'
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not reuse a remote Session after a preset mismatch and can recover after the preset is correct', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; agentPreset: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-preset', { meta: { cwd: anchor, agentPreset: 'ptc' } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'preset-message', role: 'user', content: [{ type: 'text', text: 'use ptc' }] }
        test.setCreatedPreset('standard')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setCreatedPreset('ptc')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 2)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['use ptc'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('archives an unfinished promoted native draft when the plugin releases it', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-release', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'release-message', role: 'user', content: [{ type: 'text', text: 'release me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        await test.service.dispose()
        assert.ok(test.archived.includes(native.id))
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.ctx.fiber.dispose()
    }
  })

  it('forwards every claimed user prompt and ignores injected user-role context', async () => {
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
      const native = sessions.create('native-multi', { meta: { cwd: anchor } })
      const nativeAgent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, nativeAgent)
      nativeAgent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, nativeAgent as never)
        const messages = [
          { id: 'context', role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] },
          { id: 'first', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
          { id: 'second', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] },
        ]
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages,
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['first', 'second'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not promote a subagent first prompt', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; parentSession: string } }): { id: string; header: { cwd: string } }
      }
      const child = sessions.create('native-child', { meta: { cwd: anchor, parentSession: 'parent' } })
      const agent = { id: child.id, session: child, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'child-message', role: 'user', content: [{ type: 'text', text: 'child work' }] }
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'enter')
        assert.equal(test.remoteCreates.length, 0)
        assert.equal(test.prompts.length, 0)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('cleans up a blank Session when its Agent cannot be registered', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const before = new Set(test.sessions.keys())
      test.setFailEnter(true)
      await assert.rejects(test.service.startBlankSession('host-test', { localWorkspaceId }))
      const created = [...test.sessions.keys()].find(id => !before.has(id))
      assert.ok(created)
      assert.ok(test.archived.includes(created))
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps the native prompt when the remote prompt is rejected', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-failure', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        test.setFailPrompt(true)
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'failure-message', role: 'user', content: [{ type: 'text', text: 'do not lose me' }] }
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.archived.includes(native.id), false)
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
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

  it('retries a failed promotion against the same remote Session', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'retry-message', role: 'user', content: [{ type: 'text', text: 'retry me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setFailPrompt(false)
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['retry me'])
        assert.ok(test.service.takeOpenSessionId())
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('retries after an early host-disconnected promotion failure', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-host-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'host-retry-message', role: 'user', content: [{ type: 'text', text: 'host retry' }] }
        test.setHostPhase('disconnected')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 0)
        test.setHostPhase('connected')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['host retry'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not fall back to local when a promotion retry loses its workspace', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-lost-target', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'lost-target', role: 'user', content: [{ type: 'text', text: 'stay remote' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        native.header.cwd = '/tmp/not-a-mirror'
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not reuse a remote Session after a preset mismatch and can recover after the preset is correct', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; agentPreset: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-preset', { meta: { cwd: anchor, agentPreset: 'ptc' } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'preset-message', role: 'user', content: [{ type: 'text', text: 'use ptc' }] }
        test.setCreatedPreset('standard')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setCreatedPreset('ptc')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 2)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['use ptc'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('archives an unfinished promoted native draft when the plugin releases it', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-release', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'release-message', role: 'user', content: [{ type: 'text', text: 'release me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        await test.service.dispose()
        assert.ok(test.archived.includes(native.id))
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.ctx.fiber.dispose()
    }
  })

  it('forwards every claimed user prompt and ignores injected user-role context', async () => {
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
      const native = sessions.create('native-multi', { meta: { cwd: anchor } })
      const nativeAgent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, nativeAgent)
      nativeAgent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, nativeAgent as never)
        const messages = [
          { id: 'context', role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] },
          { id: 'first', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
          { id: 'second', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] },
        ]
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages,
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['first', 'second'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not promote a subagent first prompt', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; parentSession: string } }): { id: string; header: { cwd: string } }
      }
      const child = sessions.create('native-child', { meta: { cwd: anchor, parentSession: 'parent' } })
      const agent = { id: child.id, session: child, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'child-message', role: 'user', content: [{ type: 'text', text: 'child work' }] }
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'enter')
        assert.equal(test.remoteCreates.length, 0)
        assert.equal(test.prompts.length, 0)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('cleans up a blank Session when its Agent cannot be registered', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const before = new Set(test.sessions.keys())
      test.setFailEnter(true)
      await assert.rejects(test.service.startBlankSession('host-test', { localWorkspaceId }))
      const created = [...test.sessions.keys()].find(id => !before.has(id))
      assert.ok(created)
      assert.ok(test.archived.includes(created))
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps the native prompt when the remote prompt is rejected', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-failure', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        test.setFailPrompt(true)
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'failure-message', role: 'user', content: [{ type: 'text', text: 'do not lose me' }] }
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.archived.includes(native.id), false)
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
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

describe('blank Session reuse', () => {
  it('reuses an existing unsent blank for the same workspace', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const first = await test.service.startBlankSession('host-test', { localWorkspaceId })
      const second = await test.service.startBlankSession('host-test', { localWorkspaceId })
      assert.equal(second.localSessionId, first.localSessionId)
      assert.equal(test.remoteCreates.length, 0)
      const differentPreset = await test.service.startBlankSession('host-test', {
        localWorkspaceId,
        agentPreset: 'ptc',
      })
      assert.notEqual(differentPreset.localSessionId, first.localSessionId)
    } finally {
      await test.service.dispose()
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
      const nativeAgent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, nativeAgent)
      nativeAgent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, nativeAgent as never)
        const message = { id: 'native-message', role: 'user', content: [{ type: 'text', text: 'promote me' }] }
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
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
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('retries a failed promotion against the same remote Session', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'retry-message', role: 'user', content: [{ type: 'text', text: 'retry me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setFailPrompt(false)
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['retry me'])
        assert.ok(test.service.takeOpenSessionId())
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('retries after an early host-disconnected promotion failure', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-host-retry', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'host-retry-message', role: 'user', content: [{ type: 'text', text: 'host retry' }] }
        test.setHostPhase('disconnected')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 0)
        test.setHostPhase('connected')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 1)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['host retry'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not fall back to local when a promotion retry loses its workspace', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-lost-target', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'lost-target', role: 'user', content: [{ type: 'text', text: 'stay remote' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        native.header.cwd = '/tmp/not-a-mirror'
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not reuse a remote Session after a preset mismatch and can recover after the preset is correct', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; agentPreset: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-preset', { meta: { cwd: anchor, agentPreset: 'ptc' } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'preset-message', role: 'user', content: [{ type: 'text', text: 'use ptc' }] }
        test.setCreatedPreset('standard')
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.remoteCreates.length, 1)
        assert.equal(test.prompts.length, 0)

        test.setCreatedPreset('ptc')
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 2, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.equal(test.remoteCreates.length, 2)
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['use ptc'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('archives an unfinished promoted native draft when the plugin releases it', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-release', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'release-message', role: 'user', content: [{ type: 'text', text: 'release me' }] }
        test.setFailPrompt(true)
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        await test.service.dispose()
        assert.ok(test.archived.includes(native.id))
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.ctx.fiber.dispose()
    }
  })

  it('forwards every claimed user prompt and ignores injected user-role context', async () => {
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
      const native = sessions.create('native-multi', { meta: { cwd: anchor } })
      const nativeAgent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, nativeAgent)
      nativeAgent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, nativeAgent as never)
        const messages = [
          { id: 'context', role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] },
          { id: 'first', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
          { id: 'second', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] },
        ]
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages,
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages }) as never)
        assert.equal((decision as { kind: string }).kind, 'reject')
        assert.deepEqual(test.prompts.map(prompt => prompt.text), ['first', 'second'])
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('does not promote a subagent first prompt', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string; parentSession: string } }): { id: string; header: { cwd: string } }
      }
      const child = sessions.create('native-child', { meta: { cwd: anchor, parentSession: 'parent' } })
      const agent = { id: child.id, session: child, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'child-message', role: 'user', content: [{ type: 'text', text: 'child work' }] }
        const decision = await dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never)
        assert.equal((decision as { kind: string }).kind, 'enter')
        assert.equal(test.remoteCreates.length, 0)
        assert.equal(test.prompts.length, 0)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('cleans up a blank Session when its Agent cannot be registered', async () => {
    const test = harness()
    try {
      await test.service.start()
      const localWorkspaceId = test.service.localWorkspaceIds()[0]
      assert.ok(localWorkspaceId)
      const before = new Set(test.sessions.keys())
      test.setFailEnter(true)
      await assert.rejects(test.service.startBlankSession('host-test', { localWorkspaceId }))
      const created = [...test.sessions.keys()].find(id => !before.has(id))
      assert.ok(created)
      assert.ok(test.archived.includes(created))
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps the native prompt when the remote prompt is rejected', async () => {
    const test = harness()
    try {
      await test.service.start()
      const state = await test.state() as { workspaces: Record<string, { anchor: string }> }
      const anchor = Object.values(state.workspaces)[0]?.anchor
      assert.ok(anchor)
      const sessions = test.ctx.get('sessions') as unknown as {
        create(id: string, options: { meta: { cwd: string } }): { id: string; header: { cwd: string } }
      }
      const native = sessions.create('native-failure', { meta: { cwd: anchor } })
      const agent = { id: native.id, session: native, ctx: test.ctx }
      const agentScope = createScope(test.ctx, agent)
      agent.ctx = agentScope.ctx
      try {
        test.setFailPrompt(true)
        const dispatch = agentEvents(test.ctx, agent as never)
        const message = { id: 'failure-message', role: 'user', content: [{ type: 'text', text: 'do not lose me' }] }
        await assert.rejects(dispatch.waterfall('agent/pre-step' as never, {
          messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
        } as never, async () => ({ kind: 'enter', messages: [message] }) as never))
        assert.equal(test.archived.includes(native.id), false)
        assert.equal(test.prompts.length, 0)
        assert.equal(test.service.takeOpenSessionId(), undefined)
      } finally {
        await agentScope.dispose()
      }
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
