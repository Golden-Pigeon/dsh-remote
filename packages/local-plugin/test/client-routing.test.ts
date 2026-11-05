import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installNativeWorkspaceRouting } from '../src/client/routing.ts'

Object.defineProperty(globalThis, 'document', { value: { createElement: () => ({ style: {}, append() {}, remove() {} }), body: { append() {} } }, configurable: true })
Object.defineProperty(globalThis, 'window', { value: { setTimeout: () => 0 }, configurable: true })

interface ServiceMock {
  startSession(workspaceId?: unknown, options?: { agentPreset?: string }): void
  openWorkspace(
    workspaceId: unknown,
    beforeOpen?: (sessionId: string) => void,
    options?: { agentPreset?: string },
  ): Promise<void>
  openSession(sessionId: string): void
}

function service(calls: { localOpen?: unknown; opened?: string; before?: string }, target = 'local-workspace'): ServiceMock {
  const result: ServiceMock = {
    startSession(workspaceId, options) {
      void this.openWorkspace(workspaceId ?? target, undefined, options)
    },
    async openWorkspace(workspaceId, beforeOpen, options) {
      calls.localOpen = { workspaceId, options }
      void beforeOpen
    },
    openSession(sessionId) { calls.opened = sessionId },
  }
  return result
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('native new-session routing', () => {
  it('opens a blank session with the selected preset for a mirrored workspace', async () => {
    const calls: { localOpen?: unknown; opened?: string; before?: string } = {}
    const ctx = { uiWorkspace: service(calls) }
    let blank: { hostId: string; input: unknown } | undefined
    const api = {
      state: async () => ({
        mirroredWorkspaces: [{ id: 'local-workspace', hostId: 'remote-host', title: 'Remote' }],
        hosts: [{ id: 'remote-host', phase: 'connected' }],
      }),
      startBlankSession: async (hostId: string, input: unknown) => {
        blank = { hostId, input }
        return { localSessionId: 'local-session' }
      },
      openSession: (sessionId: string) => { calls.opened = sessionId },
    }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession('local-workspace', { agentPreset: 'ptc' })
    await settle()
    assert.equal(calls.localOpen, undefined)
    assert.deepEqual(blank, {
      hostId: 'remote-host',
      input: { localWorkspaceId: 'local-workspace', agentPreset: 'ptc' },
    })
    assert.equal(calls.opened, 'local-session')
  })

  it('leaves a non-mirrored workspace on the native path with its options', async () => {
    const calls: { localOpen?: unknown; opened?: string; before?: string } = {}
    const ctx = { uiWorkspace: service(calls) }
    const api = { state: async () => ({ mirroredWorkspaces: [], hosts: [] }) }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession('local-workspace', { agentPreset: 'minimal' })
    await settle()
    assert.deepEqual(calls.localOpen, { workspaceId: 'local-workspace', options: { agentPreset: 'minimal' } })
    assert.equal(calls.opened, undefined)
  })

  it('routes the workspace resolved by a global New Session without private current-state access', async () => {
    const calls: { localOpen?: unknown; opened?: string; before?: string } = {}
    const ctx = { uiWorkspace: service(calls) }
    let blank: { hostId: string; input: unknown } | undefined
    const api = {
      state: async () => ({
        mirroredWorkspaces: [{ id: 'local-workspace', hostId: 'remote-host', title: 'Remote' }],
        hosts: [{ id: 'remote-host', phase: 'connected' }],
      }),
      startBlankSession: async (hostId: string, input: unknown) => {
        blank = { hostId, input }
        return { localSessionId: 'local-session' }
      },
      openSession: (sessionId: string) => { calls.opened = sessionId },
    }
    // The fake native service resolves the recent/current workspace exactly
    // like DSH: startSession(undefined) still calls openWorkspace('local-workspace').
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession(undefined, { agentPreset: 'ptc' })
    await settle()
    assert.deepEqual(blank, {
      hostId: 'remote-host',
      input: { localWorkspaceId: 'local-workspace', agentPreset: 'ptc' },
    })
    assert.equal(calls.opened, 'local-session')
  })

  it('routes an explicit startSession with draft options through the native resolver', async () => {
    const calls: { localOpen?: unknown; opened?: string; prepared?: string } = {}
    let blank: { hostId: string; input: unknown } | undefined
    const ctx = {
      uiWorkspace: {
        startSession(workspaceId?: unknown, options?: unknown): void {
          void this.openWorkspace(workspaceId ?? 'local-workspace', sessionId => { calls.prepared = sessionId }, options)
        },
        async openWorkspace(): Promise<void> {},
        openSession(sessionId: string) { calls.opened = sessionId },
      },
    }
    const api = {
      state: async () => ({
        mirroredWorkspaces: [{ id: 'local-workspace', hostId: 'remote-host', title: 'Remote' }],
        hosts: [{ id: 'remote-host', phase: 'connected' }],
      }),
      startBlankSession: async (hostId: string, input: unknown) => {
        blank = { hostId, input }
        return { localSessionId: 'local-session' }
      },
      openSession: (sessionId: string) => { calls.opened = sessionId },
    }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession('local-workspace', { prompt: 'draft text', agentPreset: 'ptc' })
    await settle()
    assert.deepEqual(blank, {
      hostId: 'remote-host',
      input: { localWorkspaceId: 'local-workspace', agentPreset: 'ptc' },
    })
    assert.equal(calls.opened, 'local-session')
    assert.equal(calls.prepared, 'local-session')
  })

  it('archives the blank when beforeOpen fails', async () => {
    const archived: string[] = []
    const calls: { opened?: string } = {}
    const ctx = {
      uiWorkspace: {
        startSession(): void {
          void this.openWorkspace('local-workspace', () => { throw new Error('draft failed') }).catch(() => {})
        },
        async openWorkspace(): Promise<void> {},
        async archiveSession(sessionId: string) { archived.push(sessionId) },
        openSession(sessionId: string) { calls.opened = sessionId },
      },
    }
    const api = {
      state: async () => ({
        mirroredWorkspaces: [{ id: 'local-workspace', hostId: 'remote-host', title: 'Remote' }],
        hosts: [{ id: 'remote-host', phase: 'connected' }],
      }),
      startBlankSession: async () => ({ localSessionId: 'local-session' }),
      openSession: (sessionId: string) => { calls.opened = sessionId },
    }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession(undefined)
    await settle()
    assert.deepEqual(archived, ['local-session'])
    assert.equal(calls.opened, undefined)
  })

  it('keeps the original path when no workspace can be resolved', async () => {
    const calls: { localOpen?: unknown; opened?: string; before?: string } = {}
    const original = {
      startSession(_workspaceId?: unknown, _options?: unknown): void {},
      openWorkspace: async (workspaceId: unknown) => { calls.localOpen = workspaceId },
    }
    const ctx = { uiWorkspace: original }
    const api = { state: async () => ({ mirroredWorkspaces: [], hosts: [] }) }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession(undefined, { agentPreset: 'ptc' })
    await settle()
    assert.equal(calls.localOpen, undefined)
    assert.equal(calls.opened, undefined)
  })
})
