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
    slots: { inject: (_key: string, callback: () => unknown) => callback(), register: (_options: unknown, entry: typeof component) => { component = entry; return () => {} } },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return component
}

async function harness(options: { holdCopy?: boolean } = {}) {
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
  const host = {
    id: 'fixture-host',
    label: 'Fixture host',
    sshTarget: 'example-host',
    phase: 'connected',
    dshUpdate: null,
    retry: null,
    detail: null,
    error: null,
    modelSource: 'direct',
    modelSourceOverride: null,
    copyModelKey: true,
    copyModelKeyOverride: null,
  }
  const modelCalls: unknown[][] = []
  let releaseCopy: (() => void) | undefined
  const api = {
    sshHosts: async () => ({ hosts: ['fixture-host'], error: null }),
    createWorkspace: async () => ({}),
    setCredentialProxy: async (value: boolean) => {
      modelCalls.push(['global-proxy', value])
      return { credentialProxy: value }
    },
    setCopyModelKey: async (value: boolean) => {
      modelCalls.push(['global-copy', value])
      if (options.holdCopy === true) {
        await new Promise<void>(resolve => { releaseCopy = resolve })
      }
      return { copyModelKey: value }
    },
    setHostModelSource: async (hostId: string, source: 'proxy' | 'direct' | null) => {
      modelCalls.push(['host-source', hostId, source])
      return host as never
    },
    setHostCopyModelKey: async (hostId: string, value: boolean | null) => {
      modelCalls.push(['host-copy', hostId, value])
      return host as never
    },
    state: async () => ({
      hosts: [{ ...host }],
      mirroredWorkspaceIds: [],
      mirroredWorkspaces: [],
      settings: { copyModelKey: true, credentialProxy: false },
    }),
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
  return {
    calls: () => calls,
    click,
    async addWorkspace() {
      await act(async () => { renderer.root.findAllByType('input').find(input => input.props.placeholder === 'settings.workspacePathPlaceholder')!.props.onChange({ target: { value: '/srv/another-project' } }) })
      await click('settings.addWorkspace')
    },
    async poll() { await act(async () => { intervals.forEach(callback => callback()); focus.forEach(callback => callback()) }) },
    async setChecked(index: number, checked: boolean) {
      await act(async () => {
        renderer.root.findAllByType('input')
          .filter(input => input.props.type === 'checkbox')[index]!
          .props.onChange({ target: { checked } })
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    },
    hostCardSummary: () => renderer.root.findAll(node => node.props.className === 'dshr-host-summary')[0],
    hostCardBodyCount: () => renderer.root.findAll(node => node.props.className === 'dshr-host-body').length,
    hasButton: (label: string) => renderer.root.findAllByType('button')
      .some(button => button.children.includes(label)),
    async toggleHostCard() {
      await act(async () => {
        renderer.root.findAll(node => node.props.className === 'dshr-host-summary')[0]!
          .props.onClick()
      })
    },
    modelCalls: () => modelCalls,
    releaseCopy: () => { releaseCopy?.(); releaseCopy = undefined },
    checkboxStates: () => renderer.root.findAllByType('input')
      .filter(input => input.props.type === 'checkbox')
      .map(input => ({ checked: input.props.checked === true, disabled: input.props.disabled === true })),
    sshOptions: () => renderer.root.findAll(node => node.props.className === 'dshr-ssh-option')
      .map(node => node.children.map(child => typeof child === 'string' ? child : '').join('')),
    sshTargetInput: () => renderer.root.findAllByType('input')
      .find(input => input.props.id === 'dshr-ssh-target-input'),
    async focusSshTarget() {
      await act(async () => {
        renderer.root.findAllByType('input')
          .find(input => input.props.id === 'dshr-ssh-target-input')!
          .props.onFocus()
      })
    },
    async setSshTarget(value: string) {
      await act(async () => {
        renderer.root.findAllByType('input')
          .find(input => input.props.id === 'dshr-ssh-target-input')!
          .props.onChange({ target: { value } })
      })
    },
    async pressSshEscape() {
      const calls = { prevented: false, stopped: false }
      await act(async () => {
        renderer.root.findAllByType('input')
          .find(input => input.props.id === 'dshr-ssh-target-input')!
          .props.onKeyDown({
            key: 'Escape',
            preventDefault: () => { calls.prevented = true },
            stopPropagation: () => { calls.stopped = true },
          })
      })
      return calls
    },
    async settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) },
    async succeed() { await act(async () => { resolve({ workspaces: [] }) }) },
    async fail() { await act(async () => { reject(new Error('fixture request failed')) }) },
    async dispose() {
      await act(async () => { renderer.unmount() })
    },
  }
}

describe('workspace loading in the real React panel', () => {
  it('suggests concrete SSH config aliases below the focused input while accepting free-form commands', async () => {
    const test = await harness()
    try {
      await test.settle()
      assert.equal(test.sshTargetInput()?.props.role, 'combobox')
      await test.focusSshTarget()
      await test.settle()
      assert.deepEqual(test.sshOptions(), ['fixture-host'])
      await test.setSshTarget('fix')
      await test.settle()
      assert.deepEqual(test.sshOptions(), ['fixture-host'])
      const escape = await test.pressSshEscape()
      assert.deepEqual(escape, { prevented: true, stopped: true })
      assert.deepEqual(test.sshOptions(), [])
      await test.setSshTarget('ssh -p 2222 -i ~/.ssh/key example-host')
      assert.equal(test.sshTargetInput()?.props.value, 'ssh -p 2222 -i ~/.ssh/key example-host')
      assert.deepEqual(test.sshOptions(), [])
    } finally { await test.dispose() }
  })

  it('starts host cards compact and expands/collapses on the header', async () => {
    const test = await harness()
    try {
      assert.equal(test.hostCardBodyCount(), 0)
      assert.equal(test.hostCardSummary()?.props['aria-expanded'], false)
      assert.equal(test.hasButton('settings.rediscover'), true)
      assert.equal(test.hasButton('settings.remove'), true)
      await test.toggleHostCard()
      assert.equal(test.hostCardBodyCount(), 1)
      assert.equal(test.hostCardSummary()?.props['aria-expanded'], true)
      await test.toggleHostCard()
      assert.equal(test.hostCardBodyCount(), 0)
      assert.equal(test.hostCardSummary()?.props['aria-expanded'], false)
    } finally { await test.dispose() }
  })

  it('does not disable controls while a model save is in flight', async () => {
    const test = await harness({ holdCopy: true })
    try {
      await test.toggleHostCard()
      await test.setChecked(1, false)
      assert.deepEqual(test.checkboxStates().map(box => box.disabled), [false, false, false, false])
      test.releaseCopy()
      await test.settle()
    } finally {
      test.releaseCopy()
      await test.dispose()
    }
  })

  it('edits global defaults and per-host model overrides', async () => {
    const test = await harness()
    try {
      await test.toggleHostCard()
      await test.setChecked(3, false)
      await test.setChecked(1, false)
      await test.setChecked(0, true)
      await test.setChecked(2, true)
      assert.deepEqual(test.modelCalls(), [
        ['host-copy', 'fixture-host', false],
        ['global-copy', false],
        ['global-proxy', true],
        ['host-source', 'fixture-host', 'proxy'],
      ])
    } finally { await test.dispose() }
  })

  it('keeps one request in flight across effect rerenders and host polling', async () => {
    const test = await harness()
    try {
      await test.toggleHostCard()
      await test.click('settings.expandWorkspaces')
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
      await test.toggleHostCard()
      await test.click('settings.expandWorkspaces')
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
      await test.toggleHostCard()
      await test.click('settings.expandWorkspaces')
      await test.fail()
      await test.poll()
      assert.equal(test.calls(), 1)
      await test.click('settings.collapseWorkspaces')
      await test.click('settings.expandWorkspaces')
      assert.equal(test.calls(), 2)
      await test.succeed()
      await test.click('settings.collapseWorkspaces')
      await test.click('settings.expandWorkspaces')
      assert.equal(test.calls(), 3)
      await test.succeed()
    } finally { await test.dispose() }
  })
})
