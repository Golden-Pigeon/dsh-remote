import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { RemoteHostsService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

describe('plugin settings', () => {
  it('uses the bundle default when no file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-default-'))
    try {
      const store = new SettingsStore(join(dir, 'settings.json'), { copyModelKey: true })
      assert.deepEqual(await store.load(), { copyModelKey: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists and reloads an explicit choice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-save-'))
    try {
      const path = join(dir, 'settings.json')
      const store = new SettingsStore(path, { copyModelKey: true })
      await store.setCopyModelKey(false)
      assert.deepEqual(await store.load(), { copyModelKey: false })
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { copyModelKey: false })
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
      const store = new SettingsStore(path, { copyModelKey: true })
      writeFileSync(path, '{')
      assert.deepEqual(await store.load(), { copyModelKey: true })
      writeFileSync(path, '{"copyModelKey":"no"}')
      assert.deepEqual(await store.load(), { copyModelKey: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('copy-model-key service setting', () => {
  it('exposes the effective setting and persists changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-service-'))
    try {
      const config = resolveConfig({ stateDir: dir, copyModelKey: true, autoProvision: false })
      let persisted: boolean | undefined
      const service = new RemoteHostsService({} as never, config, {
        localDshVersion: '0.2.2-rc.2',
        copyModelKey: false,
        persistCopyModelKey: async value => { persisted = value },
      })
      assert.equal(service.copyModelKey, false)
      assert.equal(service.state().settings.copyModelKey, false)
      assert.equal(service.state().settings.credentialProxy, false)
      await service.setCopyModelKey(true)
      assert.equal(service.copyModelKey, true)
      assert.equal(persisted, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
