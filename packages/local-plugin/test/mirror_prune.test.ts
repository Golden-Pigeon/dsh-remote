import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { harness, parent, parentSnapshot } from './mirror_fixture.ts'

describe('mirror record pruning', () => {
  it('drops a record whose local Session is gone and whose remote is gone', async () => {
    const test = harness()
    const second = { ...parent, sessionId: 'session-parent-2' }
    test.setRemote([parent, second])
    test.setSnapshot(parent.sessionId, parentSnapshot([]))
    test.setSnapshot(second.sessionId, parentSnapshot([]))
    await test.service.start()
    await test.service.sync()
    try {
      const before = Object.values((await test.state()).sessions)
      assert.equal(before.length, 2, 'both mirrored sessions must register')
      const doomed = before.find(entry => entry.remoteSessionId === second.sessionId)
      assert.ok(doomed !== undefined)

      // The record becomes permanently detached only when the local Session is
      // gone AND the remote no longer reports it; a remote that still lists the
      // Session is legitimately re-mirrored on the next sync.
      test.sessions.delete(doomed.localSessionId)
      test.setRemote([parent])
      await test.service.sync()

      const after = Object.values((await test.state()).sessions)
      assert.equal(after.length, 1, 'the permanently detached record must be dropped')
      assert.equal(
        after[0]?.remoteSessionId,
        parent.sessionId,
        'the surviving Session must keep its record',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('keeps a record whose local Session still exists', async () => {
    const test = harness()
    test.setRemote([parent])
    test.setSnapshot(parent.sessionId, parentSnapshot([]))
    await test.service.start()
    await test.service.sync()
    try {
      const before = Object.values((await test.state()).sessions)
      assert.equal(before.length, 1)

      await test.service.sync()
      const after = Object.values((await test.state()).sessions)
      assert.equal(after.length, 1, 'a live Session must keep its mirror record across syncs')
      assert.equal(after[0]?.localSessionId, before[0]?.localSessionId)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})

describe('mirror lookup', () => {
  it('resolves a mirrored Session and rejects an unknown one', async () => {
    const test = harness()
    test.setRemote([parent])
    test.setSnapshot(parent.sessionId, parentSnapshot([]))
    await test.service.start()
    await test.service.sync()
    try {
      const record = Object.values((await test.state()).sessions)[0]
      assert.ok(record !== undefined)

      const target = test.service.mirrorFor(record.localSessionId)
      assert.ok(target !== undefined, 'a registered Session must resolve')
      assert.equal(target.remoteSessionId, parent.sessionId)
      assert.equal(test.service.mirrorFor('session-not-a-mirror'), undefined)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
