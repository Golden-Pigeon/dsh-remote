import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { TYPERT as RAW } from '../lib/typert.host.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly name: string
  readonly exports: Record<string, { readonly default?: string }>
  readonly files: readonly string[]
}

interface Invocation {
  readonly service: string
  readonly method: string
  readonly mode?: string
}

interface Manifest {
  readonly package: string
  readonly face: string
  readonly invocations: readonly Invocation[]
  readonly model: {
    readonly services: readonly { readonly key: string }[]
  }
}

const TYPERT = RAW as Manifest

describe('terminal-controller host face', () => {
  it('re-owns the stock terminal manifest for the fork package', () => {
    assert.equal(TYPERT.package, 'dsh-remote-terminal-controller')
    assert.equal(TYPERT.face, 'host')
    assert.equal(TYPERT.model.services[0]?.key, 'terminalController')
  })

  it('exports the host face the typert loader discovers', () => {
    assert.equal(packageJson.name, 'dsh-remote-terminal-controller')
    assert.equal(packageJson.exports['./typert']?.default, './lib/typert.host.js')
    assert.equal(TYPERT.package, packageJson.name)
    assert.ok(packageJson.files.includes('lib'))
  })

  it('keeps every gateway terminal endpoint', () => {
    const methods = new Set(TYPERT.invocations.map(invocation => invocation.method))
    for (const method of ['attach', 'close', 'create', 'environment', 'list', 'rename', 'retain', 'shells', 'watch']) {
      assert.ok(methods.has(method), `missing terminal/${method}`)
    }
    assert.ok(TYPERT.invocations.some(invocation => invocation.method === 'attach' && invocation.mode === 'stream'))
    assert.ok(TYPERT.invocations.some(invocation => invocation.method === 'retain' && invocation.mode === 'stream'))
    assert.ok(TYPERT.invocations.some(invocation => invocation.method === 'watch' && invocation.mode === 'stream'))
  })
})
