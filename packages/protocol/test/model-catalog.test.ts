import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isModelCatalogResult } from '../src/validation.ts'

describe('remote model catalog validation', () => {
  it('accepts a routable catalog', () => {
    assert.equal(isModelCatalogResult({
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
      failures: [],
    }), true)
  })

  it('rejects malformed groups and defaults', () => {
    assert.equal(isModelCatalogResult({ default: {}, groups: [], failures: [], routableProviders: [] }), false)
    assert.equal(isModelCatalogResult({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [{ id: 'p', name: 'P', models: 'bad' }],
      failures: [],
    }), false)
  })
})
