import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { loadClientBundle } from './client_bundle_fixture.ts'

interface Registration {
  name: string
  id?: string
  label?: () => string
  order?: number
  locale?: string
  inject: () => unknown
}

describe('client bundle artifact', () => {
  it('registers the package, a Settings section, and the model-menu group', async () => {
    const loaded = await loadClientBundle()
    assert.equal(loaded.id, 'dsh-remote-local-plugin')
    const exports = loaded.factory((specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected external: ${specifier}`)
    })
    assert.deepEqual(Array.from(exports.inject as string[]), ['slots', 'uiWorkspace', 'uiSession', 'locale'])
    assert.equal(typeof exports.apply, 'function')

    const registrations: Registration[] = []
    const components = new Map<string, unknown>()
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      on: () => () => undefined,
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
      },
      uiSession: {
        adapter: { current: { getSnapshot: () => ({ key: undefined }) } },
      },
      inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: Registration, entry: unknown) => {
          registrations.push(options)
          components.set(options.name, entry)
          return () => undefined
        },
      },
    }
    ;(exports.apply as (context: unknown) => void)(ctx)

    const section = registrations.find(entry => entry.name === 'settings.section')
    assert.ok(section, 'the Settings section must be registered')
    assert.equal(section.id, 'remote-development')
    assert.equal(section.label?.(), 'settings.title')
    assert.equal(section.locale, 'dshRemote')
    assert.equal(section.order, 76)
    assert.equal(typeof components.get('settings.section'), 'function')

    const injected = section.inject() as { api: { state: () => Promise<unknown> } }
    assert.equal(typeof injected.api.state, 'function')

    // The composer model menu gets a second contribution for remote models.
    const models = registrations.find(entry => entry.name === 'conversation.input.model.options')
    assert.ok(models, 'the remote model group must be registered')
    assert.equal(models.id, 'dsh-remote')
    assert.equal(typeof components.get('conversation.input.model.options'), 'function')

    // `scope: 'session'` means the framework passes the Session id to `inject`.
    // Losing it made the group silently render nothing, because every lookup ran
    // with `undefined`; assert the contribution forwards what it receives.
    const modelInjected = models.inject('session-abc') as { sessionId?: string }
    assert.equal(modelInjected.sessionId, 'session-abc',
      'the model-menu contribution must forward the Session id')
  })
})
