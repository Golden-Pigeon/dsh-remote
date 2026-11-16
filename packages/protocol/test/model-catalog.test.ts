import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AGENT_ROUTES,
  isModelCatalogResult,
  matchAgentRoute,
} from '../src/index.ts'

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    },
  ],
  failures: [],
}

describe('model catalog route', () => {
  it('routes the catalog path to its own kind', () => {
    assert.equal(AGENT_ROUTES.modelCatalog, '/dsh-remote-agent/api/v1/llm/catalog')
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.modelCatalog), { kind: 'model-catalog' })
  })

  it('accepts a well-formed catalog', () => {
    assert.equal(isModelCatalogResult(catalog), true)
  })

  it('accepts a catalog that reports only failures', () => {
    assert.equal(isModelCatalogResult({
      default: { provider: 'p', model: 'm' },
      routableProviders: [],
      groups: [],
      failures: [{ id: 'p', name: 'P', message: 'unreachable' }],
    }), true)
  })

  it('rejects a malformed catalog instead of rendering a half-empty picker', () => {
    assert.equal(isModelCatalogResult(undefined), false)
    assert.equal(isModelCatalogResult({}), false)
    assert.equal(isModelCatalogResult({ ...catalog, groups: 'nope' }), false)
    assert.equal(isModelCatalogResult({ ...catalog, failures: undefined }), false)
    assert.equal(isModelCatalogResult({ ...catalog, default: { provider: 'p' } }), false)
    assert.equal(isModelCatalogResult({
      ...catalog,
      groups: [{ id: 'p', name: 'P', models: [{ name: 'no id' }] }],
    }), false)
  })
})
