import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareVersions, dshUpdateFor, parseVersion } from '../src/version.ts'

describe('version compare', () => {
  it('orders release versions numerically', () => {
    assert.equal(compareVersions('0.2.1', '0.2.2'), -1)
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
    assert.equal(compareVersions('v0.2.1', '0.2.1'), 0)
  })

  it('orders prereleases before the matching release', () => {
    assert.equal(compareVersions('0.2.1-rc.2', '0.2.1'), -1)
    assert.equal(compareVersions('0.2.1', '0.2.1-rc.3'), 1)
  })

  it('orders prerelease identifiers', () => {
    assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.10'), -1)
    assert.equal(compareVersions('0.2.1-alpha', '0.2.1-beta'), -1)
    assert.equal(compareVersions('0.2.1-rc.1', '0.2.1-rc'), 1)
  })

  it('ignores build metadata', () => {
    assert.equal(compareVersions('0.2.1-rc.3+build.1', '0.2.1-rc.3'), 0)
  })

  it('returns undefined for unknown versions', () => {
    assert.equal(parseVersion('unknown'), undefined)
    assert.equal(compareVersions('unknown', '0.2.1'), undefined)
    assert.equal(compareVersions('0.2', '0.2.1'), undefined)
  })

  it('reports an update only when the remote version is older', () => {
    assert.deepEqual(dshUpdateFor('0.2.1-rc.2', '0.2.1-rc.3'), {
      remoteVersion: '0.2.1-rc.2',
      localVersion: '0.2.1-rc.3',
    })
    assert.equal(dshUpdateFor('0.2.1-rc.3', '0.2.1-rc.3'), undefined)
    assert.equal(dshUpdateFor('0.2.1', '0.2.1-rc.3'), undefined)
    assert.equal(dshUpdateFor('unknown', '0.2.1-rc.3'), undefined)
    assert.equal(dshUpdateFor('0.2.1-rc.2', undefined), undefined)
  })
})
