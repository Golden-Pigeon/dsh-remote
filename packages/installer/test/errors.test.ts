import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BOOTSTRAP_EXIT_CODES,
  InstallerError,
  describeBootstrapExit,
  installerErrorForExit,
} from '../src/errors.ts'
import { renderBootstrapScript } from '../src/bootstrap.ts'

/** Intentional `exit N` statements the bootstrap script can return. */
function scriptedExitCodes(): number[] {
  const script = renderBootstrapScript({
    profile: 'web',
    port: 0,
    installDir: '/opt/dsh',
    dshHome: '/srv/dsh',
    dshVersion: '0.2.2-rc.3',
    pnpmVersion: '11.21.0',
    nodeVersion: '22.19.0',
    autoInstallNode: true,
    start: 'systemd',
    agentTarball: '/tmp/a.tgz',
  })
  const codes = new Set<number>()
  // Codes appear both as a bare `exit 24` line and inline as `… || exit 25`.
  for (const match of script.matchAll(/\bexit (\d+)\b/gu)) codes.add(Number(match[1]))
  return [...codes].sort((left, right) => left - right)
}

describe('bootstrap exit codes', () => {
  it('describes every code the script actually returns', () => {
    const scripted = scriptedExitCodes()
    assert.ok(scripted.length > 0, 'expected the script to contain exit statements')
    for (const code of scripted) {
      const entry = describeBootstrapExit(code)
      assert.notEqual(entry, undefined, `exit ${String(code)} has no documented cause`)
      assert.ok(entry!.message.length > 0)
    }
  })

  it('keeps the table free of codes the script never returns', () => {
    const scripted = new Set(scriptedExitCodes())
    for (const entry of BOOTSTRAP_EXIT_CODES) {
      assert.ok(scripted.has(entry.code), `exit ${String(entry.code)} is documented but unused`)
    }
  })

  it('maps each code to a distinct installer code', () => {
    const codes = BOOTSTRAP_EXIT_CODES.map(entry => entry.installerCode)
    assert.equal(new Set(codes).size, codes.length)
  })

  it('returns undefined for codes the script does not produce', () => {
    assert.equal(describeBootstrapExit(0), undefined)
    assert.equal(describeBootstrapExit(1), undefined)
    assert.equal(describeBootstrapExit(130), undefined)
  })
})

describe('InstallerError', () => {
  it('carries the exit code and cause in its message', () => {
    const error = installerErrorForExit(23)
    assert.ok(error instanceof InstallerError)
    assert.equal(error.installerCode, 'install/npm-missing')
    assert.equal(error.exitCode, 23)
    assert.match(error.message, /npm/u)
  })

  it('appends remote detail when one is available', () => {
    const error = installerErrorForExit(22, 'found v18.20.0')
    assert.match(error!.message, /found v18\.20\.0/u)
  })

  it('leaves unknown exit codes to the caller', () => {
    assert.equal(installerErrorForExit(7), undefined)
    assert.equal(installerErrorForExit(7, 'segfault'), undefined)
  })
})
