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
        alias: 'container_os4_host1_bob',
        aliases: ['native1'],
        canonical: 'container_os4_host1_bob',
        hostname: '192.0.2.16',
        user: 'bob',
        port: 36000,
        source: '/home/u/.ssh/config',
        proxyJump: false,
        registeredHostId: 'native1-51c053f7',
      },
      {
        alias: 'cloud32',
        aliases: [],
        canonical: 'cloud32',
        hostname: '198.51.100.137',
        user: 'alice',
        port: 36000,
        source: '/home/u/.ssh/config',
        proxyJump: false,
        registeredHostId: null,
      },
      {
        alias: 'bastion-route',
        aliases: [],
        canonical: 'bastion-route',
        hostname: '10.1.1.1',
        user: null,
        port: null,
        source: '/home/u/.ssh/extra',
        proxyJump: true,
        registeredHostId: null,
      },
    ],
    skipped: [{ alias: '*.corp.example.com', reason: 'wildcard' }],
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
    assert.ok(text.includes('alice@198.51.100.137:36000'), `endpoint missing: ${text.slice(0, 600)}`)
  })

  it('marks registered hosts and offers connect only for the rest', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.added'))
    const connect = buttons(renderer).filter(button =>
      button.children.some(child => String(child) === 'settings.discovered.connect'))
    assert.equal(connect.length, 2, 'only the two unregistered hosts offer connect')
  })

  it('flags a jump-host route without listing skipped wildcards', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('settings.discovered.proxy'), 'a ProxyJump host must be badged')
    // Wildcard entries are skipped by the scanner but no longer reported: the
    // list is only meant to show hosts you can actually connect to.
    assert.equal(text.includes('*.corp.example.com'), false,
      'skipped wildcards must not be surfaced')
    assert.equal(text.includes('settings.discovered.skipped'), false,
      'the skipped-entries hint was removed from the panel')
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

  it('renders a sibling alias as a tag beside the primary name', async () => {
    const { renderer } = await render({})
    const tags = renderer.root
      .findAllByProps({ className: 'dshr-alias-tag' })
      .map(node => node.children.map(child => String(child)).join(''))
    assert.deepEqual(tags, ['native1'], 'only the secondary alias becomes a tag')
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('container_os4_host1_bob'), 'the primary alias is the visible name')
  })

  it('shows the endpoint for the primary alias', async () => {
    const { renderer } = await render({})
    const endpoints = renderer.root
      .findAllByProps({ className: 'dshr-discovered-endpoint' })
      .map(node => node.children.map(child => String(child)).join(''))
    assert.ok(endpoints.includes('bob@192.0.2.16:36000'))
  })

  it('puts the row actions on the summary row and nowhere else', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-row', label: 'Native', sshTarget: 'native',
          sshPort: null, remoteAgentPort: 1, autoConnect: true,
          createdAt: 'now', updatedAt: 'now', hasToken: true,
          phase: 'connected', localPort: 2, localUrl: 'http://127.0.0.1:2',
          hostInfo: null, workspaceCount: 1, error: null, errorCode: null,
          connectedAt: 'now', detail: null, errorUi: null, agentOutdated: false,
          modelProxy: true, modelDirect: false, modelSource: 'proxy',
          dshUpdate: null, retry: null,
        }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    // Each of these is reachable exactly once, from the row itself.
    for (const label of ['settings.disconnect', 'settings.openWebUi']) {
      const matches = renderer.root.findAllByType('button')
        .filter(entry => entry.props['aria-label'] === label)
      assert.equal(matches.length, 1, `${label} must appear exactly once, got ${matches.length}`)
    }
    // The menu trigger carries a per-host label, so match on the popup role.
    const menus = renderer.root.findAllByType('button')
      .filter(entry => entry.props['aria-haspopup'] === 'menu')
    assert.equal(menus.length, 1, 'exactly one overflow menu per host')

    // The old inline block is gone: no button text duplicates the row actions.
    const texts = renderer.root.findAllByType('button')
      .map(entry => entry.children.map(child => typeof child === 'string' ? child : '').join(''))
    assert.equal(texts.includes('settings.workspaces'), false,
      'the redundant "workspaces" button was removed')
    assert.equal(texts.includes('settings.rediscover'), false,
      'rediscover moved into the menu')
  })

  it('offers no global refresh button and shows no scan time', async () => {
    const { renderer } = await render({})
    const text = JSON.stringify(renderer.toJSON())
    // The rescan action on the discovered list covers manual refresh, so a
    // second button in the header was redundant.
    assert.equal(text.includes('settings.refresh'), false,
      'the header refresh button was removed')
    // The scan timestamp is noise; the list itself is the useful information.
    assert.equal(text.includes('settings.discovered.lastScanned'), false,
      'the scan-time line was removed')
    // The rescan control must remain: it is now the only manual refresh path.
    assert.ok(text.includes('settings.discovered.rescan'))
  })

  it('does not repeat the name when the label equals the SSH target', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-dup', label: 'native2', sshTarget: 'native2',
          sshPort: null, remoteAgentPort: 1, autoConnect: true,
          createdAt: 'now', updatedAt: 'now', hasToken: true,
          phase: 'connected', localPort: 2, localUrl: 'http://127.0.0.1:2',
          hostInfo: null, workspaceCount: 0, error: null, errorCode: null,
          connectedAt: 'now', detail: null, errorUi: null, agentOutdated: false,
          modelProxy: false, modelDirect: true, modelSource: 'direct',
          dshUpdate: null, retry: null,
        }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
    })
    await settle(renderer, text => text.includes('dshr-host-row'))
    // The title holds nested elements, so collect text recursively rather than
    // stringifying the children.
    const collect = (node: unknown): string => {
      if (node === null || node === undefined) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(collect).join('')
      const candidate = node as { children?: unknown[] }
      return Array.isArray(candidate.children) ? candidate.children.map(collect).join('') : ''
    }
    const shown = renderer.root
      .findAllByProps({ className: 'dshr-host-title' })
      .map(node => collect(node.children))
    assert.equal(shown.length, 1)
    // `native2` appears once as the label; the endpoint is suppressed because it
    // would say exactly the same thing.
    assert.equal((shown[0]?.match(/native2/g) ?? []).length, 1,
      `the name must not be printed twice, got: ${shown[0]}`)
  })

  it('shows the endpoint when it differs from the label', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-diff', label: 'Native two', sshTarget: 'native2',
          sshPort: null, remoteAgentPort: 1, autoConnect: true,
          createdAt: 'now', updatedAt: 'now', hasToken: true,
          phase: 'connected', localPort: 2, localUrl: 'http://127.0.0.1:2',
          hostInfo: null, workspaceCount: 0, error: null, errorCode: null,
          connectedAt: 'now', detail: null, errorUi: null, agentOutdated: false,
          modelProxy: false, modelDirect: true, modelSource: 'direct',
          dshUpdate: null, retry: null,
        }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
    })
    await settle(renderer, text => text.includes('dshr-host-row'))
    const text = JSON.stringify(renderer.toJSON())
    assert.ok(text.includes('Native two'))
    assert.ok(text.includes('native2'), 'a distinct endpoint must still be shown')
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
