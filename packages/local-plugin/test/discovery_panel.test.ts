import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SshDiscoveryResult } from '../src/hosts/types.ts'
import { loadClientBundle } from './client_bundle_fixture.ts'

/** Minimal browser surface the panel touches while rendering. */
function surfaces(): Record<string, unknown> {
  return {
    HTMLStyleElement: Object,
    document: {
      getElementById: () => ({}),
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild() {} },
      dispatchEvent() {},
    },
    window: {
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      addEventListener() {},
      removeEventListener() {},
    },
  }
}

async function panel() {
  const loaded = await loadClientBundle(surfaces())
  const exports = loaded.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected external: ${specifier}`)
  })
  let component!: React.ComponentType<{ api: object; t(key: string): string }>
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    inject: (_keys: string[], callback: (ctx: unknown) => void) => callback(ctx),
    slots: {
      inject: (_key: string, callback: () => unknown) => callback(),
      // The plugin contributes more than one slot; this fixture wants the
      // Settings panel component alone.
      register: (options: { name?: string }, entry: typeof component) => {
        if (options.name === 'settings.section') component = entry
        return () => {}
      },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return component
}

function discovery(overrides: Partial<SshDiscoveryResult> = {}): SshDiscoveryResult {
  return {
    scannedAt: '2026-11-16T12:00:00.000Z',
    configFiles: ['/home/u/.ssh/config'],
    hosts: [
      {
        alias: 'native1',
        canonical: 'native1',
        hostname: '21.91.16.78',
        user: 'user00',
        port: 36000,
        source: '/home/u/.ssh/config',
        proxyJump: false,
        registeredHostId: 'native1-51c053f7',
      },
      {
        alias: 'cloud32',
        canonical: 'cloud32',
        hostname: '9.135.225.137',
        user: 'weyoungli',
        port: 36000,
        source: '/home/u/.ssh/config',
        proxyJump: false,
        registeredHostId: null,
      },
      {
        alias: 'bastion-route',
        canonical: 'bastion-route',
        hostname: '10.1.1.1',
        user: null,
        port: null,
        source: '/home/u/.ssh/extra',
        proxyJump: true,
        registeredHostId: null,
      },
    ],
    skipped: [{ alias: '*.devcloud.woa.com', reason: 'wildcard' }],
    error: null,
    ...overrides,
  }
}

/** Render the Settings panel against a stubbed API and settle initial effects. */
async function render(api: Record<string, unknown>) {
  const component = await panel()
  const full = {
    state: async () => ({ hosts: [], mirroredWorkspaceIds: [], mirroredWorkspaces: [] }),
    discover: async () => discovery(),
    workspaces: async () => ({ workspaces: [] }),
    ...api,
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(component, { api: full, t: (key: string) => key })) })
  await act(async () => {})
  return { renderer, api: full }
}

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button')
}

function buttonByText(renderer: ReactTestRenderer, text: string) {
  return buttons(renderer).find(button => button.children.some(child => String(child) === text))
}

describe('SSH config discovery in the Settings panel', () => {
  it('replaces the manual SSH target form with the scanned list', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    // The whole point of the change: no free-text destination entry remains.
    assert.equal(text.includes('settings.sshPlaceholder'), false,
      'the form placeholder must be gone')
    assert.equal(text.includes('settings.sshTarget'), false,
      'the SSH target field label must be gone')
    assert.ok(text.includes('settings.discovered.title'), 'the scanned section must render')
    assert.ok(text.includes('native1'))
    assert.ok(text.includes('cloud32'))
    // The resolved endpoint is what tells the user which machine an alias means.
    assert.ok(text.includes('weyoungli@9.135.225.137:36000'), `endpoint missing: ${text.slice(0, 600)}`)
  })

  it('marks registered hosts and offers connect only for the rest', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.added'))
    const connect = buttons(renderer).filter(button =>
      button.children.some(child => String(child) === 'settings.discovered.connect'))
    assert.equal(connect.length, 2, 'only the two unregistered hosts offer connect')
  })

  it('flags a jump-host route and reports skipped wildcards', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.proxy'), 'a ProxyJump host must be badged')
    assert.ok(text.includes('*.devcloud.woa.com'), 'skipped patterns are reported by alias')
  })

  it('registers the alias, then asks for a fresh scan', async () => {
    const added: unknown[] = []
    const scans: Array<boolean | undefined> = []
    const { renderer } = await render({
      discover: async (refresh?: boolean) => {
        scans.push(refresh)
        return discovery()
      },
      addHost: async (input: unknown) => {
        added.push(input)
        return { id: 'cloud32-abcdef12', label: 'cloud32', sshTarget: 'cloud32', phase: 'discovering', dshUpdate: null, retry: null, detail: null, error: null }
      },
    })
    const connect = buttons(renderer).find(button =>
      button.children.some(child => String(child) === 'settings.discovered.connect'))!
    await act(async () => { await connect.props.onClick() })

    assert.equal(added.length, 1)
    // The registry must receive the alias, never the resolved address: only the
    // alias carries IdentityFile, ProxyJump and the Include that made it work.
    assert.deepEqual(added[0], { sshTarget: 'cloud32', autoConnect: true })
    assert.deepEqual(scans, [false, true], 'the list must be rescanned after registering')
  })

  it('shows the empty state without inventing a host', async () => {
    const { renderer } = await render({
      discover: async () => discovery({ hosts: [], skipped: [] }),
    })
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.empty'))
    assert.equal(buttonByText(renderer, 'settings.discovered.connect'), undefined)
  })

  it('surfaces a scan failure instead of an empty-looking success', async () => {
    const { renderer } = await render({
      discover: async () => { throw new Error('ssh config unreadable') },
    })
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.failed'), `failure must reach the UI: ${text.slice(0, 400)}`)
  })

  it('rescans on demand from the section action', async () => {
    const scans: Array<boolean | undefined> = []
    const { renderer } = await render({
      discover: async (refresh?: boolean) => {
        scans.push(refresh)
        return discovery()
      },
    })
    const rescan = buttonByText(renderer, 'settings.discovered.rescan')
    assert.ok(rescan, 'the section must offer a rescan action')
    await act(async () => { await rescan!.props.onClick() })
    assert.deepEqual(scans, [false, true])
  })
})
