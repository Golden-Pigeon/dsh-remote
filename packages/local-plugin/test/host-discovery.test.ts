import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { RemoteHostsService } from '../src/service.ts'
import type { HostRecord } from '../src/hosts/types.ts'
import { HostStore } from '../src/hosts/store.ts'

const temporary: string[] = []

after(async () => {
  await Promise.all(temporary.map(dir => rm(dir, { recursive: true, force: true })))
})

/** Minimal Cordis stand-in: the discovery path must not need more than this. */
function fakeContext(warnings: string[] = []) {
  return {
    logger: {
      info() {},
      warn: (...args: unknown[]) => { warnings.push(args.join(' ')) },
      error() {},
      debug() {},
    },
  } as never
}

/** Build a service over an isolated state dir and an isolated ssh config. */
async function fixture(options: {
  readonly configText?: string
  readonly records?: readonly HostRecord[]
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dshr-discovery-'))
  temporary.push(home)
  const sshConfig = join(home, 'ssh-config')
  if (options.configText !== undefined) await writeFile(sshConfig, options.configText)
  const stateDir = join(home, 'remote')
  if (options.records !== undefined && options.records.length > 0) {
    const store = new HostStore(`${stateDir}/hosts.json`)
    for (const record of options.records) await store.add(record)
  }
  const config = resolveConfig(
    { stateDir, sshConfigPath: sshConfig, autoProvision: false },
    { DSH_HOME: home },
  )
  const service = new RemoteHostsService(fakeContext(), config, { localDshVersion: '0.2.2-rc.3' })
  await service.start()
  return { service, home, sshConfig }
}

function record(overrides: Partial<HostRecord> = {}): HostRecord {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: 'native1-51c053f7',
    label: 'native1',
    sshTarget: 'native1',
    sshPort: null,
    remoteAgentPort: 33157,
    token: '0123456789abcdef',
    autoConnect: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('SSH config discovery through the service', () => {
  it('lists the aliases from the config without starting any connection', async () => {
    const { service } = await fixture({
      configText: [
        'Host *.corp.example.com',
        '  User root',
        'Host container_os4_host1_bob native1',
        '  HostName 192.0.2.16',
        '  User bob',
        '  Port 36000',
        'Host plain',
      ].join('\n'),
    })
    try {
      const result = await service.discover()
      // `native1` is a second name for the machine on the previous line, so the
      // two become one entry with a primary alias and a tag — not two rows.
      assert.deepEqual(result.hosts.map(host => host.alias), ['container_os4_host1_bob', 'plain'])
      assert.deepEqual(result.hosts[0]?.aliases, ['native1'])
      assert.deepEqual(result.hosts[1]?.aliases, [], 'a lone alias carries no tags')
      assert.deepEqual(result.skipped.map(entry => entry.alias), ['*.corp.example.com'])
      // Discovery is a read: every host stays idle and no tunnel exists.
      assert.ok(service.list().every(host => host.phase === 'idle'))
      assert.equal(service.list().length, 0, 'discovery must not register anything')
    } finally {
      await service.dispose()
    }
  })

  it('marks an already-registered destination and leaves the rest unregistered', async () => {
    const { service } = await fixture({
      configText: 'Host native1\n  User bob\nHost native2\n  User bob\n',
      records: [record()],
    })
    try {
      const result = await service.discover(true)
      const byAlias = new Map(result.hosts.map(host => [host.alias, host]))
      assert.equal(byAlias.get('native1')?.registeredHostId, 'native1-51c053f7')
      assert.equal(byAlias.get('native2')?.registeredHostId, null)
    } finally {
      await service.dispose()
    }
  })

  it('recognises a machine registered under a sibling alias', async () => {
    // The user added `native1`, but this config declares the same machine with a
    // longer primary alias. Matching only the primary would offer to add it
    // again, and the registry would reject the duplicate.
    const { service } = await fixture({
      configText: 'Host docker_os4_native1_user00 native1\n  HostName 21.91.16.78\n  User user00\n  Port 36000\n',
      records: [record({ sshTarget: 'native1' })],
    })
    try {
      const result = await service.discover(true)
      assert.equal(result.hosts.length, 1)
      assert.equal(result.hosts[0]?.alias, 'docker_os4_native1_user00')
      assert.deepEqual(result.hosts[0]?.aliases, ['native1'])
      assert.equal(result.hosts[0]?.registeredHostId, 'native1-51c053f7',
        'a sibling alias in the registry must mark the whole group as added')
    } finally {
      await service.dispose()
    }
  })

  it('falls back to the alias when the config declares no HostName', async () => {
    const { service } = await fixture({ configText: 'Host bare-host\n  User bob\n' })
    try {
      const result = await service.discover()
      assert.equal(result.hosts[0]?.hostname, 'bare-host')
      assert.equal(result.hosts[0]?.canonical, 'bare-host')
    } finally {
      await service.dispose()
    }
  })

  it('returns an empty inventory when no config exists', async () => {
    const { service } = await fixture()
    try {
      const result = await service.discover()
      assert.deepEqual(result.hosts, [])
      assert.equal(result.error, null)
    } finally {
      await service.dispose()
    }
  })

  it('invalidates the cached scan when a host is registered', async () => {
    const { service } = await fixture({ configText: 'Host alpha\n  User bob\n' })
    try {
      const before = await service.discover()
      assert.equal(before.hosts[0]?.registeredHostId, null)
      const added = await service.add({ sshTarget: 'alpha', autoConnect: false })
      // The `add` path must drop the cache, otherwise the panel keeps offering a
      // host the registry already owns.
      const after = await service.discover()
      assert.equal(after.hosts[0]?.registeredHostId, added.id)
    } finally {
      await service.dispose()
    }
  })

  it('reuses the cached scan unless a refresh is requested', async () => {
    const { service, sshConfig } = await fixture({ configText: 'Host cached-host\n  User bob\n' })
    try {
      const first = await service.discover()
      assert.equal(first.hosts.length, 1)
      // A config edited inside the TTL must not be observed without a refresh.
      await writeFile(sshConfig, 'Host cached-host\nHost second-host\n')
      const cached = await service.discover()
      assert.deepEqual(cached.hosts.map(host => host.alias), ['cached-host'])
      const refreshed = await service.discover(true)
      assert.deepEqual(refreshed.hosts.map(host => host.alias), ['cached-host', 'second-host'])
    } finally {
      await service.dispose()
    }
  })
})
