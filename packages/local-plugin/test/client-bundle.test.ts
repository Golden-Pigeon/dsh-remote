import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { loadClientBundle } from './client_bundle_fixture.ts'

describe('client bundle artifact', () => {
  it('registers the package and a Settings section', async () => {
    const loaded = await loadClientBundle()
    assert.equal(loaded.id, 'dsh-remote-local-plugin')
    const exports = loaded.factory((specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected external: ${specifier}`)
    })
    assert.deepEqual(Array.from(exports.inject as string[]), ['slots', 'uiWorkspace', 'locale'])
    assert.equal(typeof exports.apply, 'function')

    let registration: { name: string; id: string; label: () => string; order: number; locale: string; inject: () => { api: unknown } } | undefined
    let component: unknown
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      on: () => () => undefined,
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
      },
      inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: typeof registration, entry: unknown) => {
          registration = options
          component = entry
          return () => undefined
        },
      },
    }
    ;(exports.apply as (context: unknown) => void)(ctx)
    assert.ok(registration)
    assert.equal(registration.name, 'settings.section')
    assert.equal(registration.id, 'remote-development')
    assert.equal(registration.label(), 'settings.title')
    assert.equal(registration.locale, 'dshRemote')
    assert.equal(registration.order, 76)
    assert.equal(typeof component, 'function')

    const injected = registration.inject() as { api: { state: () => Promise<unknown> } }
    assert.equal(typeof injected.api.state, 'function')
  })
})
