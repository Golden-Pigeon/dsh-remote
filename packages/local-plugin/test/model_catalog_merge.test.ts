import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeRemoteProvider,
  isRemoteProvider,
  remoteGroups,
  remoteProviderId,
} from '../src/client/model-catalog-merge.ts'
import type { ModelCatalogResult } from '@dsh-remote/protocol'

/** A catalog shaped like the one native1 reports. */
function catalog(): ModelCatalogResult {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-flash' },
    routableProviders: ['deepseek-official'],
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low', description: 'routine tasks' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'stronger' },
      ],
    }],
    failures: [],
  }
}

describe('remote model catalog merge', () => {
  it('round-trips the provider id through its local namespace', () => {
    // The local id keeps remote providers out of the Host's namespace, and the
    // decode step is what the remote receives, so both directions must agree.
    const local = remoteProviderId('deepseek-official')
    assert.equal(local, 'remote:deepseek-official')
    assert.equal(isRemoteProvider(local), true)
    assert.equal(decodeRemoteProvider(local), 'deepseek-official')
  })

  it('treats local provider ids as local', () => {
    assert.equal(isRemoteProvider('deepseek-official'), false)
    assert.equal(isRemoteProvider('remoteish'), false)
    assert.equal(isRemoteProvider(''), false)
  })

  it('keeps one group per remote provider, carrying every model', () => {
    const groups = remoteGroups(catalog())
    assert.equal(groups.length, 1)
    const group = groups[0]!
    assert.equal(group.id, 'remote:deepseek-official')
    assert.equal(group.name, 'DeepSeek', 'the remote display name is preserved')
    assert.deepEqual(group.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('preserves reasoning metadata for the selector', () => {
    const group = remoteGroups(catalog())[0]!
    const flash = group.models.find(model => model.id === 'deepseek-flash')!
    assert.equal(flash.reasoning?.defaultEffort, 'high')
    assert.deepEqual(flash.reasoning?.efforts.map(effort => effort.id), ['low', 'high'])
    assert.equal(flash.reasoning?.efforts[0]?.description, 'routine tasks')
  })

  it('contributes nothing when the remote reports no models', () => {
    // An empty catalog must leave the local list exactly as the Host built it,
    // otherwise a disconnected host would appear as an empty provider group.
    assert.deepEqual(remoteGroups({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [],
      failures: [],
    }), [])
  })

  it('skips a remote group that advertises no models', () => {
    const groups = remoteGroups({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [{ id: 'empty-provider', name: 'Empty', models: [] }],
      failures: [],
    })
    assert.deepEqual(groups, [], 'an empty provider group would render as a blank section')
  })
})
