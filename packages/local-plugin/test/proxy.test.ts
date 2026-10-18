import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { ModelCredentialProxy } from '../src/credentials/proxy.ts'
import { tunnelArgs } from '../src/ssh/tunnel.ts'
import { parseSshTarget } from '../src/ssh/target.ts'

const KEY = 'local-test-key-012345'
const PROXY_TOKEN = 'proxy-test-token-0123456789'

describe('model credential proxy', () => {
  const seen: Array<{ url: string; auth: string | undefined; apiKey: string | undefined }> = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? '/', auth: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  let upstreamUrl = ''
  let proxy: ModelCredentialProxy | undefined
  let proxyUrl = ''

  before(async () => {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const address = upstream.address() as { port: number }
    upstreamUrl = `http://127.0.0.1:${address.port}`
    proxy = new ModelCredentialProxy({ apiKey: KEY, upstreamBaseUrl: `${upstreamUrl}/anthropic`, isTokenValid: token => token === PROXY_TOKEN })
    proxyUrl = (await proxy.start()).baseUrl
  })

  after(async () => {
    await proxy?.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })

  it('injects the real key and forwards the path', async () => {
    const response = await fetch(`${proxyUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PROXY_TOKEN },
      body: JSON.stringify({ stream: false }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.url, '/anthropic/v1/messages?beta=true')
    assert.equal(seen[0]?.auth, `Bearer ${KEY}`)
    assert.equal(seen[0]?.apiKey, KEY)
  })

  it('rejects requests without a host proxy token', async () => {
    const before = seen.length
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false }),
    })
    assert.equal(response.status, 401)
    assert.equal(seen.length, before)
  })

  it('does not double a provider prefix already present on the request path', async () => {
    const response = await fetch(`${proxyUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PROXY_TOKEN },
      body: JSON.stringify({ stream: false }),
    })
    assert.equal(response.status, 200)
    assert.equal(seen.at(-1)?.url, '/anthropic/v1/messages')
  })
})

describe('tunnel reverse forwarding', () => {
  it('includes the model proxy reverse forward', () => {
    const args = tunnelArgs({
      sshBinary: 'ssh',
      target: parseSshTarget('example-host'),
      remotePort: 40000,
      connectTimeoutMs: 10_000,
      strictHostKeyChecking: 'accept-new',
      reverseForward: { remotePort: 47_821, localPort: 55_000 },
    }, 51_000)
    assert.ok(args.includes('-R'))
    assert.ok(args.includes('127.0.0.1:47821:127.0.0.1:55000'))
    assert.ok(args.includes('127.0.0.1:51000:127.0.0.1:40000'))
  })
})
