import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

describe('terminal-controller client bundle', () => {
  it('registers the fork id and routes apply through the Session router', () => {
    assert.match(client, /id:`dsh-remote-terminal-controller`/)
    assert.match(client, /function apply\(ctx\)\{applyRouted\(ctx\)\}/)
    assert.ok(client.includes('new ClientTerminals(ctx, routed)'))
  })

  it('carries the 0.2.2-rc.2 roster and binding face the stock UI calls', () => {
    for (const method of ['watch(', 'boundTerminal(', 'bind(', 'isRepresented(']) {
      assert.ok(client.includes(method), 'missing ClientTerminals.' + method)
    }
  })
})
