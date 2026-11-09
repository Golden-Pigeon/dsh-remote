import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deferred, removalFixture } from './workspace_removal_fixture.ts'

describe('mirrored approval queue', () => {
  it('holds an approval until the mirror runtime mounts, then dispatches it', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const gate = deferred<void>()
    const snapshotEntered = deferred<void>()
    f.gateSnapshots(gate.promise, () => { snapshotEntered.resolve() })
    let entered = 0
    const off = f.ctx.on('approval/request' as never, (() => {
      entered++
      return Promise.resolve('allowed-once')
    }) as never, { global: true } as never)
    try {
      const start = f.service.start()
      await snapshotEntered.promise
      await f.requestApproval(f.host.id, { id: 'queued-approval', sessionId: 'remote-session', toolName: 'shell' })
      await new Promise(done => setImmediate(done))
      assert.equal(entered, 0)
      assert.deepEqual(f.answers, [])
      gate.resolve()
      await start
      await new Promise(done => setImmediate(done))
      // Mounting the runtime is not enough: the approval waits until a client
      // reports the mirrored Session visible.
      assert.equal(entered, 0)
      assert.deepEqual(f.answers, [])
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      for (let attempt = 0; attempt < 20 && f.answers.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.equal(entered, 1)
      assert.deepEqual(f.answers, [{ hostId: f.host.id, requestId: 'queued-approval', outcome: 'allowed-once' }])
    } finally {
      off()
      await f.close()
    }
  })
  it('dispatches a replayed approval id only once', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const outcome = deferred<string>()
    let entered = 0
    const off = f.ctx.on('approval/request' as never, (() => {
      entered++
      return outcome.promise
    }) as never, { global: true } as never)
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')
      assert.ok(localId)
      f.service.reportVisibleSession(localId)
      const request = { id: 'replayed-approval', sessionId: 'remote-session', toolName: 'shell' }
      await f.requestApproval(f.host.id, request)
      for (let attempt = 0; attempt < 20 && entered === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.equal(entered, 1)
      await f.requestApproval(f.host.id, { ...request })
      await new Promise(done => setImmediate(done))
      assert.equal(entered, 1)
      outcome.resolve('allowed-once')
      for (let attempt = 0; attempt < 20 && f.answers.length === 0; attempt += 1) {
        await new Promise(done => setTimeout(done, 10))
      }
      assert.deepEqual(f.answers, [{ hostId: f.host.id, requestId: 'replayed-approval', outcome: 'allowed-once' }])
    } finally {
      off()
      await f.close()
    }
  })
})
