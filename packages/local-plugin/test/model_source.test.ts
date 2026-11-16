import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { idleRuntime, toHostView, type HostRecord } from '../src/hosts/types.ts'
import { isHostRecord } from '../src/hosts/store.ts'

function record(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-fixture',
    label: 'Fixture',
    sshTarget: 'example-host',
    sshPort: null,
    remoteAgentPort: null,
    token: null,
    autoConnect: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('model credential source', () => {
  it('uses the profile default when a record never chose', () => {
    // Records written before the field existed must keep the old behaviour.
    assert.equal(toHostView(record(), idleRuntime(), 'proxy').modelSource, 'proxy')
    assert.equal(toHostView(record(), idleRuntime(), 'direct').modelSource, 'direct')
  })

  it('lets an explicit host choice win over the profile default', () => {
    assert.equal(toHostView(record({ modelSource: 'proxy' }), idleRuntime(), 'direct').modelSource, 'proxy')
    assert.equal(toHostView(record({ modelSource: 'direct' }), idleRuntime(), 'proxy').modelSource, 'direct')
  })

  it('treats an explicit null as "follow the default"', () => {
    assert.equal(toHostView(record({ modelSource: null }), idleRuntime(), 'proxy').modelSource, 'proxy')
  })

  it('round-trips a chosen source through the registry validator', () => {
    // Persisted records are revalidated on load; a chosen source must survive.
    assert.equal(isHostRecord(record({ modelSource: 'proxy' })), true)
    assert.equal(isHostRecord(record({ modelSource: 'direct' })), true)
    assert.equal(isHostRecord(record()), true, 'absent must stay valid for old records')
    assert.equal(isHostRecord(record({ modelSource: null })), true)
    // A hand-edited registry must not introduce a third state.
    assert.equal(isHostRecord({ ...record(), modelSource: 'bogus' }), false)
  })

  it('derives the profile default from credentialProxy', () => {
    // credentialProxy remains the default for hosts that never chose.
    const proxied = resolveConfig({ credentialProxy: true })
    const direct = resolveConfig({ credentialProxy: false })
    assert.equal(proxied.credentialProxy, true)
    assert.equal(direct.credentialProxy, false)
  })
})
