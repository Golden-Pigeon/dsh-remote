import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { harness, parent, child, grandchild, parentSnapshot, descriptorSnapshot } from './mirror_fixture.ts'

describe('mirror subagent sessions', () => {
  it('mirrors remote subagent children under their local parent, including nested children', async () => {
    const test = harness()
    test.setRemote([parent, child, grandchild])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', descriptorSnapshot())
    test.setSnapshot('child-1-1', descriptorSnapshot())

    try {
      await test.service.sync()
      const state = await test.state()
      const records = Object.values(state.sessions)
      const parentRecord = records.find(record => record.remoteSessionId === 'session-parent')
      const childRecord = records.find(record => record.remoteSessionId === 'child-1')
      const grandchildRecord = records.find(record => record.remoteSessionId === 'child-1-1')

      assert.ok(parentRecord !== undefined)
      assert.ok(childRecord !== undefined)
      assert.ok(grandchildRecord !== undefined)
      assert.equal(childRecord.parentSessionId, parentRecord.localSessionId)
      assert.equal(grandchildRecord.parentSessionId, childRecord.localSessionId)

      const mirroredChild = test.sessions.get('child-1')
      assert.ok(mirroredChild !== undefined)
      assert.equal(mirroredChild.header.origin, 'subagent')
      assert.equal(mirroredChild.header.parentSession, parentRecord.localSessionId)
      assert.equal(mirroredChild.header.cwd, parentRecord.anchor)
      assert.ok(mirroredChild.snapshotEvents().some(event => event.type === 'subagent/descriptor'))

      assert.ok(test.attached.includes(parentRecord.localSessionId), 'parent attaches to the workspace row')
      assert.equal(test.attached.includes('child-1'), false, 'child is not a workspace row')

      const created = test.sessions.size
      await test.service.sync()
      assert.equal(test.sessions.size, created, 'second sync reuses every mirror session')
      assert.equal(Object.keys((await test.state()).sessions).length, records.length)
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('prunes only children the remote no longer reports', async () => {
    const test = harness()
    test.setRemote([parent, child])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', descriptorSnapshot())

    try {
      await test.service.sync()
      assert.ok(test.sessions.has('child-1'))

      test.setRemote([parent])
      await test.service.sync()
      const records = Object.values((await test.state()).sessions)
      assert.equal(records.some(record => record.remoteSessionId === 'child-1'), false)
      assert.ok(test.archived.includes('child-1'))
      // The parent mirror itself is never pruned by the subagent cleanup.
      assert.ok(records.some(record => record.remoteSessionId === 'session-parent'))
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })

  it('leaves a child unmirrored when its window lost the descriptor', async () => {
    const test = harness()
    test.setRemote([parent, child])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', {
      cursor: 3_000,
      live: true,
      truncated: true,
      events: [
        { seq: 2_500, type: 'turn/start', data: { turn: 9 } },
        { seq: 2_501, type: 'user/message', data: { id: 'u9', role: 'user', content: [] } },
      ],
    })

    try {
      await test.service.sync()
      assert.equal(test.sessions.has('child-1'), false)
      assert.ok(test.warnings.some(line => line.includes('has no descriptor')))
      assert.equal(
        Object.values((await test.state()).sessions).some(record => record.remoteSessionId === 'child-1'),
        false,
      )
    } finally {
      await test.service.dispose()
      await test.ctx.fiber.dispose()
    }
  })
})
