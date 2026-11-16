import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../src/index.ts'
import { harness, parent, parentSnapshot } from './mirror_fixture.ts'

async function mounted() {
  const test = harness()
  test.setRemote([parent])
  test.setSnapshot(parent.sessionId, parentSnapshot([]))
  await test.service.start()
  const record = Object.values((await test.state()).sessions)
    .find(entry => entry.remoteSessionId === parent.sessionId)!
  const agent = test.liveAgents.get(record.localSessionId)!
  return { ...test, agent, record }
}

function userMessage(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('remote model-selection fallback', () => {
  it('resends the prompt without a selection the remote rejects, and delivers it once', async () => {
    const test = await mounted()
    const unavailable = { provider: 'local-only', model: 'not-on-remote' }
    test.setRejectSelection(unavailable)
    try {
      test.agent.model.select(unavailable)
      test.agent.send(userMessage('first message'))
      await test.service.sync()
      await new Promise(resolve => setTimeout(resolve, 50))

      // The remote refused the selection once, then accepted the retry.
      assert.equal(test.rejectedPrompts.length, 1, 'the selection must be tried first')
      assert.equal(test.rejectedPrompts[0]!.text, 'first message')
      assert.equal(test.prompts.length, 1, 'the prompt must be delivered exactly once')
      assert.equal(test.prompts[0]!.selection, undefined, 'the retry must drop the unusable selection')
      assert.equal(test.prompts[0]!.text, 'first message')
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('stops reporting a selection the remote already refused', async () => {
    const test = await mounted()
    const unavailable = { provider: 'local-only', model: 'not-on-remote' }
    test.setRejectSelection(unavailable)
    try {
      test.agent.model.select(unavailable)
      assert.deepEqual(test.agent.model.current(), unavailable)

      test.agent.send(userMessage('first'))
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(test.rejectedPrompts.length, 1)
      assert.equal(test.prompts.length, 1)

      // Once refused, the mirror must stop advertising the selection, so the
      // next prompt falls back instead of repeating the rejected round trip.
      // (The turn stays open because this fixture does not drive the remote
      // event stream that would close it.)
      assert.equal(test.agent.model.current(), undefined)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('falls back for an older agent that collapses the rejection into internal', async () => {
    const test = await mounted()
    const unavailable = { provider: 'local-only', model: 'not-on-remote' }
    test.setRejectSelection(unavailable)
    test.setLegacyRejection(true)
    try {
      test.agent.model.select(unavailable)
      test.agent.send(userMessage('legacy'))
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(test.prompts.length, 1)
      assert.equal(test.prompts[0]!.selection, undefined)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('honours an explicit re-selection of a previously rejected model', async () => {
    const test = await mounted()
    const unavailable = { provider: 'local-only', model: 'not-on-remote' }
    test.setRejectSelection(unavailable)
    try {
      test.agent.model.select(unavailable)
      test.agent.send(userMessage('first'))
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(test.rejectedPrompts.length, 1)
      assert.equal(test.agent.model.current(), undefined)

      // The user picks the same model again (say, after installing it on the
      // host). That intent must win over the recorded rejection.
      test.agent.model.select(unavailable)
      assert.deepEqual(test.agent.model.current(), unavailable)
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })

  it('does not resend when the remote fails for a reason other than the selection', async () => {
    const test = await mounted()
    try {
      test.agent.model.select({ provider: 'fixture', model: 'model' })
      test.setFailPrompt(true)
      test.agent.send(userMessage('transport failure'))
      await new Promise(resolve => setTimeout(resolve, 50))

      // A genuine failure must not be retried: resending would risk delivering
      // the same prompt twice once the transport recovers.
      assert.equal(test.prompts.length, 0)
      assert.equal(test.rejectedPrompts.length, 0)
      assert.ok(
        test.warnings.some(line => line.includes('remote prompt failed')),
        'the failure must still be reported',
      )
    } finally { await test.service.dispose(); await test.ctx.fiber.dispose() }
  })
})
