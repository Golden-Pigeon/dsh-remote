import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { loadClientBundle } from './client_bundle_fixture.ts'

async function panel(surfaces: Record<string, unknown>) {
  const loaded = await loadClientBundle(surfaces)
  const exports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected external: ${specifier}`)
  })
  let component!: React.ComponentType<{ api: object; t(key: string): string }>
  const ctx = {
    effect: (callback: () => unknown) => callback(), on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      // Keep only the Settings section: the plugin also contributes a composer
      // model-menu group, and this fixture wants the panel component alone.
      register: (options: { name?: string }, entry: typeof component) => {
        if (options.name === 'settings.section') component = entry
        return () => {}
      },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return component
}

async function harness() {
  const focus: Array<() => void> = []
  const intervals: Array<() => void> = []
  const component = await panel({
    HTMLStyleElement: Object,
    window: {
      setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length },
      clearInterval() {}, addEventListener: (event: string, callback: () => void) => { if (event === 'focus') focus.push(callback) }, removeEventListener() {},
    },
    document: {
      getElementById: () => ({}), addEventListener() {}, removeEventListener() {},
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }), head: { appendChild() {} },
    },
  })
  let resolve!: (value: { workspaces: object[] }) => void
  let reject!: (error: Error) => void
  let calls = 0
  const host = { id: 'fixture-host', label: 'Fixture host', sshTarget: 'example-host', phase: 'connected', dshUpdate: null, retry: null, detail: null, error: null }
  const api = {
    createWorkspace: async () => ({}),
    state: async () => ({ hosts: [{ ...host }], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
    workspaces: () => {
      calls++
      // Bound a regression's render loop so a failed test cannot hang the suite.
      if (calls > 8) throw new Error('workspace request loop')
      return new Promise<{ workspaces: object[] }>((done, fail) => { resolve = done; reject = fail })
    },
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(component, { api, t: key => key })) })
  const click = async (label: string) => {
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children.includes(label))!.props.onClick() })
  }
  /** Open or close the host summary row; its detail region holds the actions. */
  const toggleRow = async () => {
    // Re-query each time: the row's handler closes over the current expansion
    // state, so a stale node would keep toggling the same way.
    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { row?.props.onClick({ preventDefault() {} }) })
  }
  return {
    calls: () => calls,
    click,
    toggleRow,
    async addWorkspace() {
      await act(async () => { renderer.root.findAllByType('input').find(input => input.props.placeholder === 'settings.workspacePathPlaceholder')!.props.onChange({ target: { value: '/srv/another-project' } }) })
      await click('settings.addWorkspace')
    },
    async poll() { await act(async () => { intervals.forEach(callback => callback()); focus.forEach(callback => callback()) }) },
    async succeed() { await act(async () => { resolve({ workspaces: [] }) }) },
    async fail() { await act(async () => { reject(new Error('fixture request failed')) }) },
    async dispose() {
      await act(async () => { renderer.unmount() })
    },
  }
}

describe('workspace loading in the real React panel', () => {
  it('keeps one request in flight across effect rerenders and host polling', async () => {
    const test = await harness()
    try {
      await test.toggleRow()
      assert.equal(test.calls(), 1)
      await test.poll()
      assert.equal(test.calls(), 1)
      await test.succeed()
      await test.poll()
      assert.equal(test.calls(), 1)
    } finally { await test.dispose() }
  })

  it('refreshes after adding a workspace even when an older listing is still pending', async () => {
    const test = await harness()
    try {
      await test.toggleRow()
      await test.addWorkspace()
      assert.equal(test.calls(), 1)
      await test.succeed()
      assert.equal(test.calls(), 2, 'workspace creation must request a fresh listing after the older one completes')
      await test.succeed()
    } finally { await test.dispose() }
  })

  it('allows a new request after completion or failure when reopening a host', async () => {
    const test = await harness()
    try {
      await test.toggleRow()
      await test.fail()
      await test.poll()
      assert.equal(test.calls(), 1)
      await test.toggleRow()
      await test.toggleRow()
      assert.equal(test.calls(), 2)
      await test.succeed()
      await test.toggleRow()
      await test.toggleRow()
      assert.equal(test.calls(), 3)
      await test.succeed()
    } finally { await test.dispose() }
  })
})
