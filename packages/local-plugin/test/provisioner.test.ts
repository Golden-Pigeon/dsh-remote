import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentPackageSpecFor, agentVersionIsOlder, agentVersionMatches, agentVersionTransition } from '../src/remote/provisioner.ts'

describe('agent install target', () => {
  it('uses npm only for stable releases', () => {
    assert.equal(agentPackageSpecFor('0.2.10'), '@goldenpigeon/dsh-remote-agent@0.2.10')
    assert.equal(agentPackageSpecFor('0.2.10-rc.1'), undefined)
    assert.equal(agentPackageSpecFor(undefined), undefined)
  })

  it('requires the installed agent to match the requested version', () => {
    assert.equal(agentVersionMatches('0.2.10', '0.2.10'), true)
    assert.equal(agentVersionMatches('v0.2.10+build.7', '0.2.10'), true)
    assert.equal(agentVersionMatches('0.2.10-rc.1', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', undefined), true)
    assert.equal(agentVersionIsOlder('0.2.9', '0.2.10'), true)
    assert.equal(agentVersionIsOlder('0.2.10', '0.2.10'), false)
    assert.equal(agentVersionIsOlder('0.2.11', '0.2.10'), false)
  })

  it('waits for an old pid but fails on a newly started wrong-version agent', () => {
    assert.equal(agentVersionTransition('0.2.9', 100, '0.2.10', true, 100), 'wait')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, 100), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, undefined), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', false, undefined), 'wait')
    assert.equal(agentVersionTransition('0.2.10', 200, '0.2.10', true, 100), 'ready')
  })
})
