import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { LocalError } from '../src/errors.ts'
import { hostIdFor, isHostId } from '../src/hosts/id.ts'
import { HostStore, isHostRecord } from '../src/hosts/store.ts'
import type { HostRecord } from '../src/hosts/types.ts'
import { discoveryCommand, shellQuote } from '../src/ssh/probe.ts'
import { parseSshTarget, validateHostLabel } from '../src/ssh/target.ts'
import { allocateLocalPort, tunnelArgs } from '../src/ssh/tunnel.ts'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-local-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SSH target', () => {
  it('parses the accepted forms', () => {
    assert.deepEqual(parseSshTarget('example-host'), {
      raw: 'example-host',
      user: null,
      host: 'example-host',
      port: null,
      destination: 'example-host',
      canonical: 'example-host',
    })
    const withPort = parseSshTarget('alice@10.0.0.5:2222')
    assert.equal(withPort.destination, 'alice@10.0.0.5')
    assert.equal(withPort.port, 2222)
    assert.equal(withPort.canonical, 'alice@10.0.0.5:2222')
    const url = parseSshTarget('ssh://alice@example-host.example:22')
    assert.equal(url.destination, 'alice@example-host.example')
    assert.equal(url.canonical, 'alice@example-host.example:22')
  })

  it('rejects option injection, whitespace, and malformed ports', () => {
    assert.throws(() => parseSshTarget('-oProxyCommand=evil'), LocalError)
    assert.throws(() => parseSshTarget('user@host name'), LocalError)
    assert.throws(() => parseSshTarget('user@host:0'), LocalError)
    assert.throws(() => parseSshTarget('user@host:70000'), LocalError)
    assert.throws(() => parseSshTarget('ssh://user@host:abc'), LocalError)
    assert.throws(() => parseSshTarget('@host'), LocalError)
  })

  it('validates labels and derives stable ids', () => {
    assert.equal(validateHostLabel('  Example GPU  '), 'Example GPU')
    assert.throws(() => validateHostLabel(''), LocalError)
    const first = hostIdFor('alice@example-host:22', 'Example host')
    assert.equal(first, hostIdFor('alice@example-host:22', 'Example host'))
    assert.ok(isHostId(first))
    assert.notEqual(first, hostIdFor('alice@example-host:23', 'Example host'))
  })
})

describe('discovery command', () => {
  it('quotes literal paths and expands HOME for tilde paths', () => {
    assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
    assert.equal(discoveryCommand('~/.dsh/remote-agent/agent.json'), 'cat -- "$HOME/.dsh/remote-agent/agent.json" 2>/dev/null || true')
    assert.equal(discoveryCommand('/srv/agent.json'), `cat -- '/srv/agent.json' 2>/dev/null || true`)
  })
})

describe('tunnel argv', () => {
  it('binds loopback only and forwards to the remote loopback port', () => {
    const args = tunnelArgs({
      sshBinary: 'ssh',
      target: parseSshTarget('alice@example-host:2222'),
      remotePort: 41234,
      connectTimeoutMs: 15_000,
      strictHostKeyChecking: 'accept-new',
    }, 51000)
    assert.ok(args.includes('-N'))
    assert.ok(args.includes('ExitOnForwardFailure=yes'))
    assert.ok(args.includes('127.0.0.1:51000:127.0.0.1:41234'))
    assert.equal(args[args.length - 1], 'alice@example-host')
    assert.ok(args.includes('2222'))
  })

  it('allocates a usable loopback port', async () => {
    const port = await allocateLocalPort()
    assert.ok(port > 0 && port < 65_536)
  })
})

describe('config', () => {
  it('resolves state and SSH defaults', () => {
    const config = resolveConfig({}, { DSH_HOME: '/srv/dsh' })
    assert.equal(config.stateDir, '/srv/dsh/remote')
    assert.equal(config.sshBinary, 'ssh')
    assert.equal(config.reconnect, true)
    assert.equal(config.credentialProxy, false)
    assert.equal(config.copyModelKey, true)
    assert.equal(config.remoteModelBaseUrl, 'https://api.deepseek.com/anthropic')
    assert.throws(() => resolveConfig({ strictHostKeyChecking: 'bogus' }), /strictHostKeyChecking/)
  })
})

describe('host store', () => {
  const record: HostRecord = {
    id: 'example-host-1234abcd',
    label: 'Example host',
    sshTarget: 'alice@example-host:22',
    sshPort: 22,
    remoteAgentPort: 41234,
    token: '0123456789abcdef',
    autoConnect: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('round-trips records with mode 0600', async () => {
    const dir = await tempDir()
    const file = join(dir, 'hosts.json')
    const store = new HostStore(file)
    await store.add(record)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const loaded = await store.load()
    assert.deepEqual(loaded.hosts, [record])
    assert.deepEqual(loaded.warnings, [])

    const updated = await store.update(record.id, { label: 'Example host 2' })
    assert.equal(updated.label, 'Example host 2')
    assert.equal((await store.load()).hosts[0]?.label, 'Example host 2')

    assert.equal(await store.remove(record.id), true)
    assert.equal(await store.remove(record.id), false)
    assert.deepEqual((await store.load()).hosts, [])
  })

  it('rejects duplicate ids and destinations', async () => {
    const dir = await tempDir()
    const store = new HostStore(join(dir, 'hosts.json'))
    await store.add(record)
    await assert.rejects(store.add(record), /already exists/)
    await assert.rejects(store.add({ ...record, id: 'other-00000000' }), /already exists/)
  })

  it('skips malformed entries with a warning', async () => {
    const dir = await tempDir()
    const file = join(dir, 'hosts.json')
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({
      version: 1,
      hosts: [record, { id: 'bad id' }],
    })))
    const loaded = await new HostStore(file).load()
    assert.equal(loaded.hosts.length, 1)
    assert.equal(loaded.warnings.length, 1)
    assert.equal(isHostRecord(record), true)
    assert.equal(isHostRecord({ ...record, token: 'short' }), false)
  })

  it('does not expose the token in a view', async () => {
    const { toHostView, idleRuntime } = await import('../src/hosts/types.ts')
    const view = toHostView(record, idleRuntime())
    assert.equal('token' in view, false)
    assert.equal(view.hasToken, true)
    assert.equal(view.dshUpdate, null)
    assert.equal(view.retry, null)
    assert.equal(JSON.stringify(view).includes('0123456789abcdef'), false)
  })

  it('reads a valid JSON document from disk', async () => {
    const dir = await tempDir()
    const file = join(dir, 'hosts.json')
    await new HostStore(file).add(record)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.hosts[0].id, record.id)
  })
})
