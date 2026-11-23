import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ModelCatalogResult } from '@dsh-remote/protocol'
import {
  decodeRemoteProvider,
  remoteGroups,
  remoteProviderId,
  withRemoteGroups,
  type DirectoryState,
} from '../src/client/model-catalog-merge.ts'

const catalog: ModelCatalogResult = {
  default: { provider: 'remote-provider', model: 'remote-model' },
  routableProviders: ['remote-provider'],
  groups: [{
    id: 'remote-provider',
    name: 'Remote Provider',
    models: [{ id: 'remote-model', name: 'Remote Model' }],
  }],
  failures: [],
}

const localState: DirectoryState = {
  current: null,
  groups: [{ id: 'local-provider', name: 'Local', models: [{ id: 'local-model', name: 'Local Model' }] }],
  failures: [],
  error: null,
  status: 'ready',
}

describe('remote-only model directory', () => {
  it('prefixes remote provider ids and names', () => {
    const groups = remoteGroups(catalog)
    assert.equal(groups[0]?.id, 'remote:remote-provider')
    assert.equal(groups[0]?.name, 'Remote · Remote Provider')
    assert.equal(remoteProviderId('remote-provider'), 'remote:remote-provider')
    assert.equal(decodeRemoteProvider('remote:remote-provider'), 'remote-provider')
  })

  it('withholds every local provider for a mirrored Session', () => {
    const next = withRemoteGroups(localState, remoteGroups(catalog), true)
    assert.deepEqual(next.groups.map(group => group.id), ['remote:remote-provider'])
    assert.equal(next.groups.some(group => group.id === 'local-provider'), false)
  })

  it('offers no local fallback when the remote catalog is empty', () => {
    const next = withRemoteGroups(localState, [], true)
    assert.deepEqual(next.groups, [])
  })
})
