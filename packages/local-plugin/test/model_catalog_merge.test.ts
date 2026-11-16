import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeRemoteProvider,
  isRemoteProvider,
  remoteGroups,
  remoteProviderId,
  withRemoteGroups,
  type DirectoryState,
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
    const groups = remoteGroups(catalog(), 'native1')
    assert.equal(groups.length, 1)
    const group = groups[0]!
    assert.equal(group.id, 'remote:deepseek-official')
    assert.deepEqual(group.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('qualifies the group name with a remote marker and its host', () => {
    // A local provider and a remote one are commonly named after the same
    // vendor. The selector renders `name` verbatim, so the host has to be part
    // of it or the two sections are indistinguishable — and it has to say the
    // models are remote, since a bare host name reads as another local section.
    const group = remoteGroups(catalog(), 'native1')[0]!
    assert.equal(group.name, 'Remote · DeepSeek (native1)', 'the name must mark it remote and name the host')

    const other = remoteGroups(catalog(), 'native3')[0]!
    assert.notEqual(group.name, other.name, 'two hosts must not produce the same label')
  })

  it('preserves reasoning metadata for the selector', () => {
    const group = remoteGroups(catalog(), 'native1')[0]!
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
    }, 'native1'), [])
  })

  it('skips a remote group that advertises no models', () => {
    const groups = remoteGroups({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [{ id: 'empty-provider', name: 'Empty', models: [] }],
      failures: [],
    }, 'native1')
    assert.deepEqual(groups, [], 'an empty provider group would render as a blank section')
  })
})

describe('directory snapshot merge', () => {
  /** A snapshot shaped like the one ModelDirectory publishes. */
  function state(overrides: Partial<DirectoryState> = {}): DirectoryState {
    return {
      current: null,
      groups: [{ id: 'local-provider', name: 'Local', models: [{ id: 'local-model', name: 'Local' }] }],
      failures: [],
      error: null,
      status: 'ready',
      ...overrides,
    }
  }

  it('appends remote groups after the local ones', () => {
    const merged = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    assert.deepEqual(merged.groups.map(group => group.id), [
      'local-provider',
      'remote:deepseek-official',
    ])
    assert.equal(merged.status, 'ready', 'unrelated fields must survive')
  })

  it('replaces the previous remote contribution instead of duplicating it', () => {
    const first = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const second = withRemoteGroups(first, [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'Pro' }] },
    ])
    const remote = second.groups.filter(group => group.id.startsWith('remote:'))
    assert.equal(remote.length, 1, 'a refresh must not stack duplicate remote providers')
    assert.deepEqual(remote[0]?.models.map(model => model.id), ['deepseek-v4-pro'])
  })

  it('drops the remote contribution when the catalog reports nothing', () => {
    const withRemote = withRemoteGroups(state(), [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const cleared = withRemoteGroups(withRemote, [])
    assert.deepEqual(cleared.groups.map(group => group.id), ['local-provider'])
  })

  it('keeps a recorded remote pick while the rows are re-applied', () => {
    // The selector matches `current` against the offered rows to build its label,
    // and a Host refresh rebuilds that snapshot, so the recorded pick has to
    // survive re-application or the trigger falls back to "select a model".
    const picked = state({
      current: { provider: 'remote:deepseek-official', model: 'deepseek-v4-pro' },
    })
    const reapplied = withRemoteGroups(picked, [
      { id: 'remote:deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'Pro' }] },
    ])
    assert.deepEqual(reapplied.current, {
      provider: 'remote:deepseek-official',
      model: 'deepseek-v4-pro',
    })
  })
})
