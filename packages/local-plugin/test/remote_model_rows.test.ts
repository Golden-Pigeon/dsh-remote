import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { loadClientBundle } from './client_bundle_fixture.ts'

/**
 * Render the real contributed component out of the built bundle.
 *
 * Importing the source directly is not possible: it imports a CSS file, which
 * Node cannot load. Going through the bundle is also closer to what the browser
 * actually runs.
 */
async function component(): Promise<React.ComponentType<Record<string, unknown>>> {
  const loaded = await loadClientBundle({
    HTMLStyleElement: Object,
    // The bundle installs menu styles and listeners at apply time, so the DOM
    // stub must cover lookup, insert, removal, and listener registration even
    // though nothing is asserted about them.
    document: {
      getElementById: () => null,
      createElement: () => ({ dataset: {}, textContent: '', remove: () => undefined }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild: () => undefined, append: () => undefined },
      head: { appendChild: () => undefined, append: () => undefined },
    },
  })
  const exports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected external: ${specifier}`)
  })
  let contributed: React.ComponentType<Record<string, unknown>> | undefined
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => undefined,
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: undefined }) } } },
    inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (options: { name?: string }, entry: React.ComponentType<Record<string, unknown>>) => {
        // The model-menu contribution is the one under test here.
        if (options.name === 'conversation.input.model.options') contributed = entry
        return () => undefined
      },
    },
  }
  ;(exports.apply as (context: unknown) => void)(ctx)
  assert.ok(contributed, 'the bundle must contribute the model-menu group')
  return contributed
}

/** A catalog shaped exactly like the one native1 reports. */
const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [], defaultEffort: 'high' } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [], defaultEffort: 'high' } },
    ],
  }],
  failures: [],
}

const mirror = { hostId: 'h1', hostLabel: 'native1', remoteSessionId: 'r1' }

async function render(props: {
  sessionId?: string
  mirror: typeof mirror | null
  catalog?: unknown
}): Promise<string> {
  const Component = await component()
  const api = {
    sessionMirror: async () => props.mirror,
    modelCatalog: async () => props.catalog ?? catalog,
    setSessionModel: async () => ({ accepted: true }),
    state: async () => ({ hosts: [], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(React.createElement(Component, {
      sessionId: props.sessionId,
      locked: false,
      dismiss: () => undefined,
      reportFailure: () => undefined,
      api,
      t: (key: string) => key,
    }))
  })
  // Let the asynchronous mirror/catalog lookup settle.
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
  return JSON.stringify(renderer.toJSON())
}

describe('remote model rows', () => {
  it('renders the remote models for a mirrored Session', async () => {
    const text = await render({ sessionId: 's1', mirror })
    assert.ok(text.includes('deepseek-v4-pro'), `expected remote rows, got: ${text.slice(0, 400)}`)
    assert.ok(text.includes('deepseek-flash'), 'both catalog models must appear')
    assert.ok(text.includes('native1'), 'the group must name its host')
  })

  it('renders nothing for a Session that is not a mirror', async () => {
    assert.equal(await render({ sessionId: 's2', mirror: null }), 'null')
  })

  it('renders nothing without a Session id', async () => {
    assert.equal(await render({ mirror }), 'null')
  })

  it('surfaces an empty catalog instead of looking absent', async () => {
    const text = await render({
      sessionId: 's1',
      mirror,
      catalog: { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] },
    })
    assert.ok(text.includes('model.emptyCatalog'), `expected the empty-catalog hint, got: ${text.slice(0, 300)}`)
  })
})
