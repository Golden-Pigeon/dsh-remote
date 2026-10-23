import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { singleFlight } from '../src/host-api/inflight.ts'

describe('host API singleFlight', () => {
  it('runs concurrent work for one key once and shares the result', async () => {
    const pending = new Map<string, Promise<number>>()
    let calls = 0
    let release!: (value: number) => void
    const gate = new Promise<number>(resolve => { release = resolve })
    const task = (): Promise<number> => {
      calls += 1
      return gate
    }
    const first = singleFlight(pending, 'host:workspace', task)
    const second = singleFlight(pending, 'host:workspace', task)
    assert.equal(first, second)
    await Promise.resolve()
    assert.equal(calls, 1)
    release(42)
    assert.deepEqual(await Promise.all([first, second]), [42, 42])
    assert.equal(pending.size, 0)
  })

  it('allows a fresh run after the previous one settles', async () => {
    const pending = new Map<string, Promise<number>>()
    let calls = 0
    const task = async (): Promise<number> => {
      calls += 1
      return calls
    }
    assert.equal(await singleFlight(pending, 'k', task), 1)
    assert.equal(await singleFlight(pending, 'k', task), 2)
    assert.equal(calls, 2)
    assert.equal(pending.size, 0)
  })

  it('releases the key after a rejection', async () => {
    const pending = new Map<string, Promise<number>>()
    const failing = async (): Promise<number> => { throw new Error('boom') }
    await assert.rejects(singleFlight(pending, 'k', failing), /boom/)
    assert.equal(pending.size, 0)
    assert.equal(await singleFlight(pending, 'k', async () => 7), 7)
  })
})
