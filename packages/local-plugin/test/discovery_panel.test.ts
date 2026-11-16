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
  // The mount effect fires `scan()` without awaiting it, so a single empty act
  // returns before discovery lands. Drain microtasks until the list is painted.
  await settle(renderer, text => text.includes('dshr-discovered'))
  return { renderer, api: full }
}

/** Pump the event loop until the rendered tree satisfies `done`. */
async function settle(
  renderer: ReactTestRenderer,
  done: (text: string) => boolean,
  attempts = 50,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    if (done(JSON.stringify(renderer.toJSON() ?? ''))) return
  }
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
    // React splits one endpoint into several text children, so join them before
    // comparing rather than expecting one contiguous substring in the JSON.
    const endpoints = renderer.root
      .findAllByProps({ className: 'dshr-discovered-endpoint' })
      .map(node => node.children.map(child => String(child)).join(""))
    assert.ok(endpoints.includes('alice@198.51.100.137:36000'), `endpoint missing: ${endpoints.join(' | ')}`)
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
    // Compare fields rather than the object identity: the panel builds its
    // payload inside the loaded client bundle, so its prototype is not this
    // realm's Object.prototype and deepEqual would reject an equal value.
    const payload = added[0] as Record<string, unknown>
    assert.equal(payload.sshTarget, 'cloud32')
    assert.equal(payload.autoConnect, true)
    assert.deepEqual(Object.keys(payload).sort(), ['autoConnect', 'sshTarget'])
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

  it('lists registered hosts before the scanned ones', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-first', label: 'Registered', sshTarget: 'registered',
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
    const headings = renderer.root
      .findAllByType('h3')
      .map(node => node.children.map(child => String(child)).join(''))
    // The hosts you keep come first; the scanned list is setup, not routine.
    assert.deepEqual(headings, ['settings.hosts', 'settings.discovered.title'])
  })

  it('draws the row icons as SVG rather than font glyphs', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-icons', label: 'Icons', sshTarget: 'icons',
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

    // Two actions on the row, both rendered as vector art.
    const svgs = renderer.root.findAllByType('svg' as never)
    assert.ok(svgs.length >= 2, `the row actions must be SVG, found ${svgs.length}`)

    // Glyph fonts render these two at mismatched sizes, which is what made the
    // connect icon look smaller than its neighbours.
    const text = JSON.stringify(renderer.toJSON())
    assert.equal(text.includes('\u23FB'), false, 'the power glyph must be gone')
    assert.equal(text.includes('\u23F5'), false, 'the play glyph must be gone')
  })

  it('does not restate the connection state that the dot already shows', async () => {
    const hostFor = (phase: string) => ({
      id: `host-${phase}`, label: `Hosted ${phase}`, sshTarget: `hosted-${phase}`,
      sshPort: null, remoteAgentPort: null, autoConnect: true,
      createdAt: 'now', updatedAt: 'now', hasToken: true,
      phase, localPort: null, localUrl: null,
      hostInfo: null, workspaceCount: null, error: null, errorCode: null,
      connectedAt: null, detail: null, errorUi: null, agentOutdated: false,
      modelProxy: false, modelDirect: false, modelSource: 'direct' as const,
      dshUpdate: null, retry: null,
    })

    // Idle: nothing worth saying, so no sub-line at all.
    const idle = await render({
      state: async () => ({
        hosts: [hostFor('idle')], mirroredWorkspaceIds: [], mirroredWorkspaces: [],
      }),
    })
    await settle(idle.renderer, text => text.includes('dshr-host-row'))
    assert.equal(JSON.stringify(idle.renderer.toJSON()).includes('dshr-host-sub'), false,
      'an idle host has no facts, so it must not print "未连接"')

    // Installing: the phase explains why the row looks stuck, so keep it.
    const installing = await render({
      state: async () => ({
        hosts: [hostFor('installing')], mirroredWorkspaceIds: [], mirroredWorkspaces: [],
      }),
    })
    await settle(installing.renderer, text => text.includes('dshr-host-row'))
    assert.ok(JSON.stringify(installing.renderer.toJSON()).includes('phase.installing'),
      'a transitional phase must still be spelled out')
  })

  it('expands a disconnected host without asking for its workspaces', async () => {
    let workspaceCalls = 0
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-idle', label: 'Idle', sshTarget: 'idle',
          sshPort: null, remoteAgentPort: null, autoConnect: true,
          createdAt: 'now', updatedAt: 'now', hasToken: true,
          phase: 'idle', localPort: null, localUrl: null,
          hostInfo: null, workspaceCount: null, error: null, errorCode: null,
          connectedAt: null, detail: null, errorUi: null, agentOutdated: false,
          modelProxy: false, modelDirect: false, modelSource: 'direct',
          dshUpdate: null, retry: null,
        }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
      workspaces: async () => { workspaceCalls += 1; return { workspaces: [] } },
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    // Opening the row of a host that is not connected must not trigger a
    // request that can only fail with "host is not connected".
    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })

    assert.equal(workspaceCalls, 0, 'no workspace request for a disconnected host')
    const json = JSON.stringify(renderer.toJSON())
    assert.equal(json.includes('dshr-banner-error'), false,
      'expanding a disconnected host must not raise a page-level error')
  })

  it('does not raise a banner when an automatic workspace load fails', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-fail', label: 'Failing', sshTarget: 'failing',
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
      // The host reports connected but the agent call fails anyway.
      workspaces: async () => { throw new Error('host is not connected') },
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    await settle(renderer, () => true, 10)

    // A background load the user did not request stays quiet; the row still
    // shows its own state.
    assert.equal(JSON.stringify(renderer.toJSON()).includes('dshr-banner-error'), false,
      'a failed automatic load must not surface as a page banner')
  })

  it('offers a folder browser beside the workspace path field', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-browse', label: 'Browser', sshTarget: 'browser',
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
      workspaces: async () => ({ workspaces: [] }),
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    await settle(renderer, text => text.includes('dshr-workspace-add'))

    const texts = renderer.root.findAllByType('button')
      .map(entry => entry.children.map(child => typeof child === 'string' ? child : '').join(''))
    assert.ok(texts.includes('settings.browseWorkspace'),
      'the path field needs a browse action so it is not typing-only')
    assert.ok(texts.includes('settings.addWorkspace'), 'adding still works directly')
  })

  it('names a new workspace after its folder', async () => {
    const created: { path: string; title?: string }[] = []
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-title', label: 'Titled', sshTarget: 'titled',
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
      workspaces: async () => ({ workspaces: [] }),
      createWorkspace: async (_hostId: string, input: { path: string; title?: string }) => {
        created.push(input)
        return { workspaceId: 'ws-new', title: input.title ?? '', path: input.path, sessionIds: [] }
      },
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    await settle(renderer, text => text.includes('dshr-workspace-add'))

    // Type a nested path, then add it.
    const input = renderer.root.findAllByType('input')
      .find(node => node.props?.placeholder === 'settings.workspacePathPlaceholder')
    assert.ok(input, 'the path field must exist')
    await act(async () => { input!.props.onChange({ target: { value: '/home/alice/projects/trunk/' } }) })
    const add = renderer.root.findAllByType('button')
      .find(entry => entry.children.some(child => String(child) === 'settings.addWorkspace'))
    await act(async () => { await add!.props.onClick() })

    assert.equal(created.length, 1)
    assert.equal(created[0]?.path, '/home/alice/projects/trunk/')
    // Trailing slash must not become the name.
    assert.equal(created[0]?.title, 'trunk', 'the folder name becomes the title')
  })

  it('shows no status sentence once a host is connected', async () => {
    const base = {
      sshPort: null, remoteAgentPort: 1, autoConnect: true,
      createdAt: 'now', updatedAt: 'now', hasToken: true,
      localPort: 2, localUrl: 'http://127.0.0.1:2',
      hostInfo: null, workspaceCount: 0, error: null, errorCode: null,
      connectedAt: 'now', errorUi: null, agentOutdated: false,
      dshUpdate: null, retry: null,
    }

    // Connected: the dot, the summary row and the model-source line already say
    // everything, so a "已连接；..." sentence is redundant.
    const connected = await render({
      state: async () => ({
        hosts: [
          { ...base, id: 'h-proxy', label: 'P', sshTarget: 'p', phase: 'connected', modelProxy: true, modelDirect: false, modelSource: 'proxy', detail: 'connectedProxy' },
          { ...base, id: 'h-direct', label: 'D', sshTarget: 'd', phase: 'connected', modelProxy: false, modelDirect: true, modelSource: 'direct', detail: 'connectedDirect' },
          { ...base, id: 'h-remote', label: 'R', sshTarget: 'r', phase: 'connected', modelProxy: false, modelDirect: false, modelSource: 'direct', detail: null },
        ],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
    })
    await settle(connected.renderer, text => text.includes('dshr-host-row'))
    const connectedText = JSON.stringify(connected.renderer.toJSON())
    for (const key of ['detail.connectedProxy', 'detail.connectedDirect', 'detail.connectedRemote']) {
      assert.equal(connectedText.includes(key), false, `${key} must not be rendered`)
    }

    // A transitional phase still explains itself, since the dot cannot.
    const working = await render({
      state: async () => ({
        hosts: [{ ...base, id: 'h-inst', label: 'I', sshTarget: 'i', phase: 'installing', modelProxy: false, modelDirect: false, modelSource: 'direct', detail: 'installing' }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
    })
    await settle(working.renderer, text => text.includes('dshr-host-row'))
    const row = working.renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    await settle(working.renderer, text => text.includes('dshr-host-detail'))
    assert.ok(JSON.stringify(working.renderer.toJSON()).includes('detail.installing'),
      'a progress sentence still shows while the host is working')
  })

  it('offers no separate expand button on the row', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-no-caret', label: 'No caret', sshTarget: 'no-caret',
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

    // The row itself toggles, so a dedicated chevron would be a second control
    // for the same thing.
    const expanders = renderer.root.findAllByType('button').filter(entry =>
      entry.props['aria-label'] === 'settings.expandWorkspaces'
      || entry.props['aria-label'] === 'settings.collapseWorkspaces')
    assert.equal(expanders.length, 0, 'the row must not carry a separate expand button')

    // Expanding still works through the row.
    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    assert.ok(row, 'the summary row must exist')
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    assert.ok(JSON.stringify(renderer.toJSON()).includes('dshr-host-detail'),
      'clicking the row still opens the details')
  })

  it('does not expand the host when the menu trigger is clicked', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-menu', label: 'Hosted', sshTarget: 'hosted',
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

    const trigger = renderer.root.findAllByType('button')
      .find(entry => entry.props['aria-haspopup'] === 'menu')
    assert.ok(trigger, 'the overflow trigger must exist')

    // The trigger lives inside the row, whose click expands the host. Clicking
    // it must open the menu only, or the row and the menu both react at once.
    let propagated = false
    await act(async () => {
      trigger!.props.onClick({
        stopPropagation() { propagated = true },
        preventDefault() {},
      })
    })
    assert.equal(propagated, true, 'the trigger must stop the click from reaching the row')
    assert.equal(JSON.stringify(renderer.toJSON()).includes('dshr-host-detail'), false,
      'the host must stay collapsed when only the menu was opened')
    assert.ok(JSON.stringify(renderer.toJSON()).includes('dshr-menu'),
      'the menu itself must open')
  })

  it('lists workspaces without a session tree or new-session button', async () => {
    const { renderer } = await render({
      state: async () => ({
        hosts: [{
          id: 'host-ws', label: 'With ws', sshTarget: 'with-ws',
          sshPort: null, remoteAgentPort: 1, autoConnect: true,
          createdAt: 'now', updatedAt: 'now', hasToken: true,
          phase: 'connected', localPort: 2, localUrl: 'http://127.0.0.1:2',
          hostInfo: null, workspaceCount: 1, error: null, errorCode: null,
          connectedAt: 'now', detail: null, errorUi: null, agentOutdated: false,
          modelProxy: false, modelDirect: true, modelSource: 'direct',
          dshUpdate: null, retry: null,
        }],
        mirroredWorkspaceIds: [],
        mirroredWorkspaces: [],
      }),
      workspaces: async () => ({
        workspaces: [{
          workspaceId: 'ws-1', title: 'trunk',
          path: '/home/alice/projects/trunk', sessionIds: ['a', 'b'],
        }],
      }),
    })
    await settle(renderer, text => text.includes('dshr-host-row'))

    // Expand the host so the workspace summary renders.
    const row = renderer.root.findAll(node =>
      node.props?.className === 'dshr-host-row' && typeof node.props?.onClick === 'function')[0]
    await act(async () => { await row!.props.onClick({ preventDefault() {} }) })
    await settle(renderer, text => text.includes('dshr-workspace-list'))

    const json = JSON.stringify(renderer.toJSON())
    assert.ok(json.includes('dshr-workspace-list'), 'workspaces are listed')
    // Settings summarises workspaces; sessions are opened in the conversation view.
    assert.equal(json.includes('dshr-sessions'), false, 'no session tree here')
    assert.equal(json.includes('settings.newSession'), false, 'no new-session button here')
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
