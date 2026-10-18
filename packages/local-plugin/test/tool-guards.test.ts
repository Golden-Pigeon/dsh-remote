import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteToolGuards } from '../src/tools.ts'

describe('remote host tool guards', () => {
  it('asks before host-writing tools and delegates other tools', async () => {
    let listener: ((exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      on: (_event: string, callback: typeof listener) => {
        listener = callback
        return () => undefined
      },
    }
    installRemoteToolGuards(ctx as never)
    assert.ok(listener)
    const ask = await listener!({ name: 'remote_host_add' }, async () => ({ kind: 'allow' }))
    assert.equal((ask as { kind?: string }).kind, 'ask')
    const allow = await listener!({ name: 'remote_workspaces_list' }, async () => ({ kind: 'allow' }))
    assert.deepEqual(allow, { kind: 'allow' })
  })
})
