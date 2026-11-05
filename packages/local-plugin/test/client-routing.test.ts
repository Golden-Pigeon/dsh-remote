import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installNativeWorkspaceRouting } from '../src/client/routing.ts'

Object.defineProperty(globalThis, 'document', { value: { createElement: () => ({ style: {}, append() {}, remove() {} }), body: { append() {} } }, configurable: true })
Object.defineProperty(globalThis, 'window', { value: { setTimeout: () => 0 }, configurable: true })

describe('native new-session routing', () => {
  it('opens a blank session with the selected preset for a mirrored workspace', async () => {
    let original: { workspaceId?: unknown; options?: unknown } | undefined
    let blank: { hostId: string; input: unknown } | undefined
    let opened: string | undefined
    const ctx = {
      uiWorkspace: {
        startSession(workspaceId?: unknown, options?: unknown) {
          original = { workspaceId, options }
        },
        openSession(sessionId: string) { opened = sessionId },
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
      openSession: (sessionId: string) => { opened = sessionId },
    }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession('local-workspace', { agentPreset: 'ptc' })
    for (let attempt = 0; attempt < 20 && opened === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.equal(original, undefined)
    assert.deepEqual(blank, {
      hostId: 'remote-host',
      input: { localWorkspaceId: 'local-workspace', agentPreset: 'ptc' },
    })
    assert.equal(opened, 'local-session')
  })

  it('leaves a non-mirrored workspace on the native path with its options', async () => {
    let called: { workspaceId?: unknown; options?: unknown } | undefined
    const ctx = {
      uiWorkspace: {
        startSession(workspaceId?: unknown, options?: unknown) { called = { workspaceId, options } },
      },
    }
    const api = { state: async () => ({ mirroredWorkspaces: [], hosts: [] }) }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession('local-workspace', { agentPreset: 'minimal' })
    for (let attempt = 0; attempt < 20 && called === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.deepEqual(called, { workspaceId: 'local-workspace', options: { agentPreset: 'minimal' } })
  })
  it('resolves the current mirrored workspace for a global new-session action', async () => {
    let blank: { hostId: string; input: unknown } | undefined
    let opened: string | undefined
    const ctx = {
      uiWorkspace: {
        startSession() {},
        mainReference: { sessionId: 'session-current' },
        workspaces: {
          list: {
            getSnapshot: () => ({
              items: [{ workspaceId: 'local-workspace', sessionIds: ['session-current'] }],
            }),
          },
        },
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
      openSession: (sessionId: string) => { opened = sessionId },
    }
    installNativeWorkspaceRouting(ctx as never, api as never, (key: string) => key)
    ctx.uiWorkspace.startSession(undefined, { agentPreset: 'ptc' })
    for (let attempt = 0; attempt < 20 && opened === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.deepEqual(blank, {
      hostId: 'remote-host',
      input: { localWorkspaceId: 'local-workspace', agentPreset: 'ptc' },
    })
    assert.equal(opened, 'local-session')
  })

})
