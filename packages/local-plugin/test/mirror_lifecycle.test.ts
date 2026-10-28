import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { apply } from '../src/index.ts'
import { harness, parent, child, parentSnapshot, descriptorSnapshot } from './mirror_fixture.ts'

async function mounted(children = false) {
  const test = harness()
  test.setRemote(children ? [parent, child] : [parent])
  test.setSnapshot(parent.sessionId, parentSnapshot(children ? [child.sessionId] : []))
  if (children) test.setSnapshot(child.sessionId, descriptorSnapshot())
  await test.service.start()
  const record = Object.values((await test.state()).sessions).find(record => record.remoteSessionId === parent.sessionId)!
  return { ...test, agent: test.liveAgents.get(record.localSessionId)! }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('mirror Agent integration', () => {
  it('records and forwards model choices without importing the unreleased AgentModel class', async () => {
    const test = await mounted()
    try {
      const choice = { provider: 'fixture', model: 'model', reasoningEffort: 'high' }
      test.agent.model.select(choice)
      choice.model = 'mutated-by-caller'
      assert.deepEqual(test.agent.model.current(), { provider: 'fixture', model: 'model', reasoningEffort: 'high' })
      test.agent.model.select({ provider: 'fixture', model: 'model', reasoningEffort: 'high' })
      assert.equal(test.selections.length, 1)
      test.agent.model.select({ provider: 'fixture', model: 'model' })
      assert.equal(test.selections.length, 2)
      assert.equal(test.agent.model.current().reasoningEffort, undefined)
      const read = test.agent.model.current()
      read.model = 'mutated-read'
      assert.equal(test.agent.model.current().model, 'model')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('persists an explicit choice matching initial options and prefers recorded model state', async () => {
    const test = await mounted()
    try {
      const initial = test.agent.model.current()
      test.agent.model.select(initial)
      assert.equal(test.selections.length, 1)
      const recorded = { provider: 'remote-provider', model: 'remote-model' }
      test.ctx.provide('sessionProjections', { stateOf: () => ({ pending: null, lastUsed: recorded }) } as never)
      assert.deepEqual(test.agent.model.current(), recorded)
      test.agent.model.current().model = 'mutated-read'
      assert.equal(recorded.model, 'remote-model')
      test.agent.model.select(initial)
      assert.equal(test.selections.length, 2, 'an older log choice must not hide a different recorded model')
      await test.ctx.serial('agent/created' as never, { agent: test.agent } as never)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('owns a real Agent scope and waits for asynchronous scope teardown', async () => {
    const test = await mounted()
    const gate = deferred()
    let disposing = false
    let finished = false
    try {
      assert.equal(scopeOf(test.agent.ctx), test.agent)
      test.agent.ctx.effect(() => async () => { disposing = true; await gate.promise; finished = true })
      let disposed = false
      const job = test.service.dispose().then(() => { disposed = true })
      await new Promise(setImmediate)
      assert.equal(disposing, true)
      assert.equal(disposed, false)
      gate.resolve()
      await job
      assert.equal(finished, true)
      assert.equal(test.liveAgents.size, 0)
    } finally { gate.resolve(); await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('awaits child scope teardown before archiving and forgetting a remote subagent', async () => {
    const test = await mounted(true)
    const gate = deferred()
    const disposing = deferred()
    try {
      test.liveAgents.get(child.sessionId).ctx.effect(() => async () => { disposing.resolve(); await gate.promise })
      test.setRemote([parent])
      const job = test.service.sync()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child teardown did not start')), 2_000)
        void disposing.promise.then(() => { clearTimeout(timer); resolve() })
      })
      assert.equal(test.archived.includes(child.sessionId), false)
      gate.resolve()
      await job
      assert.equal(test.archived.includes(child.sessionId), true)
      assert.equal(test.liveAgents.has(child.sessionId), false)
    } finally { gate.resolve(); await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('installs persisted-mirror ownership before the plugin entry awaits host startup', async () => {
    const test = harness()
    test.ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
    test.ctx.provide('credentials', { resolve: async () => undefined } as never)
    await writeFile(join(test.stateDir, 'mirrors.json'), JSON.stringify({ version: 1, sessions: {
      'host:remote': { hostId: 'host', remoteSessionId: 'remote', localSessionId: 'persisted-mirror' },
    }, workspaces: {}, testHidden: [] }))
    const starting = apply(test.ctx, { stateDir: test.stateDir, mirrorSessions: false, autoProvision: false, copyModelKey: false })
    try {
      await assert.rejects(test.ctx.serial('agent/created' as never, { agent: { id: 'persisted-mirror' } } as never), /remote mirror/i)
      await starting
    } finally { await starting; await test.ctx.fiber.dispose() }
  })

  it('blocks native resume for a persisted mirror from the beginning of startup', async () => {
    const test = harness()
    await writeFile(join(test.stateDir, 'mirrors.json'), JSON.stringify({ version: 1, sessions: {
      'host:remote': { hostId: 'host', remoteSessionId: 'remote', localSessionId: 'persisted-mirror' },
    }, workspaces: {}, testHidden: [] }))
    const starting = test.service.start()
    try {
      await assert.rejects(test.ctx.serial('agent/created' as never, { agent: { id: 'persisted-mirror' } } as never), /remote mirror/i)
      await starting
      await test.ctx.serial('agent/created' as never, { agent: { id: 'ordinary-local' } } as never)
    } finally { await starting; await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
