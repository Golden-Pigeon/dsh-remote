import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { idleRuntime, toHostView, type HostRecord } from '../src/hosts/types.ts'
import { isHostRecord } from '../src/hosts/store.ts'
import { RemoteHostsService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

function record(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-fixture',
    label: 'Fixture',
    sshTarget: 'example-host',
    sshPort: null,
    remoteAgentPort: null,
    token: null,
    autoConnect: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('plugin settings', () => {
  it('uses the bundle defaults when no file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-default-'))
    try {
      const store = new SettingsStore(join(dir, 'settings.json'), { copyModelKey: true, credentialProxy: false })
      assert.deepEqual(store.load(), { copyModelKey: true, credentialProxy: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists and reloads both choices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-save-'))
    try {
      const path = join(dir, 'settings.json')
      const store = new SettingsStore(path, { copyModelKey: true, credentialProxy: false })
      await store.setCopyModelKey(false)
      await store.setCredentialProxy(true)
      assert.deepEqual(store.load(), { copyModelKey: false, credentialProxy: true })
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { copyModelKey: false, credentialProxy: true })
      if (process.platform !== 'win32') {
        assert.equal(statSync(path).mode & 0o777, 0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back on malformed or non-boolean values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-bad-'))
    try {
      const path = join(dir, 'settings.json')
      const store = new SettingsStore(path, { copyModelKey: true, credentialProxy: false })
      writeFileSync(path, '{')
      assert.deepEqual(store.load(), { copyModelKey: true, credentialProxy: false })
      writeFileSync(path, '{"copyModelKey":"no","credentialProxy":1}')
      assert.deepEqual(store.load(), { copyModelKey: true, credentialProxy: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('global and per-host model settings', () => {
  it('uses the global defaults when a host has no override', () => {
    const view = toHostView(record(), idleRuntime(), { credentialProxy: true, copyModelKey: false })
    assert.equal(view.modelSource, 'proxy')
    assert.equal(view.modelSourceOverride, null)
    assert.equal(view.copyModelKey, false)
    assert.equal(view.copyModelKeyOverride, null)
  })

  it('lets the per-host choice win over the global default', () => {
    const view = toHostView(
      record({ modelSource: 'direct', copyModelKey: true }),
      idleRuntime(),
      { credentialProxy: true, copyModelKey: false },
    )
    assert.equal(view.modelSource, 'direct')
    assert.equal(view.modelSourceOverride, 'direct')
    assert.equal(view.copyModelKey, true)
    assert.equal(view.copyModelKeyOverride, true)
  })

  it('validates persisted overrides', () => {
    assert.equal(isHostRecord(record({ modelSource: null, copyModelKey: null })), true)
    assert.equal(isHostRecord(record({ modelSource: 'proxy', copyModelKey: false })), true)
    assert.equal(isHostRecord({ ...record(), modelSource: 'bogus' }), false)
    assert.equal(isHostRecord({ ...record(), copyModelKey: 'yes' }), false)
  })

  it('exposes and persists the global source and copy choice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-service-'))
    try {
      const config = resolveConfig({ stateDir: dir, copyModelKey: true, credentialProxy: false, autoProvision: false })
      let persistedCopy: boolean | undefined
      let persistedProxy: boolean | undefined
      const service = new RemoteHostsService({} as never, config, {
        localDshVersion: '0.2.2-rc.2',
        copyModelKey: false,
        persistCopyModelKey: async value => { persistedCopy = value },
        credentialProxy: true,
        persistCredentialProxy: async value => { persistedProxy = value },
      })
      assert.equal(service.copyModelKey, false)
      assert.equal(service.credentialProxy, true)
      assert.deepEqual(service.state().settings, { copyModelKey: false, credentialProxy: true })
      await service.setCopyModelKey(true)
      await service.setCredentialProxy(false)
      assert.equal(persistedCopy, true)
      assert.equal(persistedProxy, false)
      assert.deepEqual(service.state().settings, { copyModelKey: true, credentialProxy: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists per-host overrides without changing the global defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-host-'))
    try {
      const config = resolveConfig({
        stateDir: dir,
        autoProvision: false,
        copyModelKey: false,
        credentialProxy: true,
      })
      const service = new RemoteHostsService({} as never, config, {
        localDshVersion: '0.2.2-rc.2',
        copyModelKey: false,
        credentialProxy: true,
      })
      const added = await service.add({ sshTarget: 'fixture.example', autoConnect: false })
      assert.equal(added.modelSource, 'proxy')
      assert.equal(added.modelSourceOverride, null)
      assert.equal(added.copyModelKey, false)
      assert.equal(added.copyModelKeyOverride, null)

      const direct = await service.setHostModelSource(added.id, 'direct')
      assert.equal(direct.modelSource, 'direct')
      assert.equal(direct.modelSourceOverride, 'direct')
      assert.equal(direct.copyModelKey, false)

      const copied = await service.setHostCopyModelKey(added.id, true)
      assert.equal(copied.copyModelKey, true)
      assert.equal(copied.copyModelKeyOverride, true)

      const reset = await service.setHostModelSource(added.id, null)
      assert.equal(reset.modelSource, 'proxy')
      assert.equal(reset.modelSourceOverride, null)

      const saved = JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8')) as {
        hosts: Array<{ modelSource?: string | null; copyModelKey?: boolean | null }>
      }
      assert.equal(saved.hosts[0]?.modelSource, null)
      assert.equal(saved.hosts[0]?.copyModelKey, true)
      await service.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
