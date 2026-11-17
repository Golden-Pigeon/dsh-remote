import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstallerError, installerErrorForExit, renderBootstrapScript } from '@dsh-remote/installer'
import { agentPackageSpecFor, agentVersionIsOlder, agentVersionMatches, agentVersionTransition, installerCodeOf, installerUi, PROVISION_PROGRESS, progressForLine, resolveRemoteDshVersion } from '../src/remote/provisioner.ts'

describe('agent install target', () => {
  it('uses npm only for stable releases', () => {
    assert.equal(agentPackageSpecFor('0.2.10'), '@goldenpigeon/dsh-remote-agent@0.2.10')
    assert.equal(agentPackageSpecFor('0.2.10-rc.1'), undefined)
    assert.equal(agentPackageSpecFor(undefined), undefined)
  })

  it('requires the installed agent to match the requested version', () => {
    assert.equal(agentVersionMatches('0.2.10', '0.2.10'), true)
    assert.equal(agentVersionMatches('v0.2.10+build.7', '0.2.10'), true)
    assert.equal(agentVersionMatches('0.2.10-rc.1', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', '0.2.10'), false)
    assert.equal(agentVersionMatches('0.2.9', undefined), true)
    assert.equal(agentVersionIsOlder('0.2.9', '0.2.10'), true)
    assert.equal(agentVersionIsOlder('0.2.10', '0.2.10'), false)
    assert.equal(agentVersionIsOlder('0.2.11', '0.2.10'), false)
  })

  it('waits for an old pid but fails on a newly started wrong-version agent', () => {
    assert.equal(agentVersionTransition('0.2.9', 100, '0.2.10', true, 100), 'wait')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, 100), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', true, undefined), 'mismatch')
    assert.equal(agentVersionTransition('0.2.9', 200, '0.2.10', false, undefined), 'wait')
    assert.equal(agentVersionTransition('0.2.10', 200, '0.2.10', true, 100), 'ready')
  })
})

describe('remote DSH version selection', () => {
  it('follows the local runtime when no version is configured', () => {
    assert.equal(resolveRemoteDshVersion('', '0.2.2-rc.3'), '0.2.2-rc.3')
    assert.equal(resolveRemoteDshVersion(undefined, '0.2.2-rc.3'), '0.2.2-rc.3')
  })

  it('pins an explicitly configured version', () => {
    assert.equal(resolveRemoteDshVersion('0.2.2-rc.2', '0.2.2-rc.3'), '0.2.2-rc.2')
  })

  it('lets a manual upgrade override the configured version', () => {
    assert.equal(resolveRemoteDshVersion('0.2.2-rc.2', '0.2.2-rc.2', '0.2.2-rc.3'), '0.2.2-rc.3')
  })

  it('falls back when the local runtime version is unknown', () => {
    assert.equal(resolveRemoteDshVersion('', undefined), '0.2.2-rc.2')
  })
})

describe('installer failure surfacing', () => {
  it('reads the installer code off a bootstrap failure', () => {
    assert.equal(installerCodeOf(installerErrorForExit(23)), 'install/npm-missing')
    assert.equal(installerCodeOf(installerErrorForExit(22)), 'install/node-outdated')
  })

  it('ignores failures that carry no installer code', () => {
    assert.equal(installerCodeOf(new Error('ssh: connection refused')), undefined)
    assert.equal(installerCodeOf('a string'), undefined)
    assert.equal(installerCodeOf(installerErrorForExit(7)), undefined)
  })

  it('recognises a failure from a second copy of the installer module', () => {
    // The plugin can load the installer twice (source plus built bundle), which
    // breaks `instanceof`; the structural check must still recover the code.
    const foreign = Object.assign(new Error('remote install failed: no npm'), {
      installerCode: 'install/npm-missing',
      exitCode: 23,
    })
    assert.ok(!(foreign instanceof InstallerError))
    assert.equal(installerCodeOf(foreign), 'install/npm-missing')
    // Anything unknown is ignored rather than trusted.
    assert.equal(installerCodeOf({ installerCode: 'install/not-a-real-code' }), undefined)
    assert.equal(installerCodeOf({ installerCode: 42 }), undefined)
  })

  it('names the actionable causes instead of one generic message', () => {
    const keyFor = (exit: number): string => installerUi(installerErrorForExit(exit)).key
    assert.equal(keyFor(21), 'error.agentInstallNodeMissing')
    assert.equal(keyFor(22), 'error.agentInstallNodeOutdated')
    assert.equal(keyFor(23), 'error.agentInstallNoNpm')
    assert.equal(keyFor(24), 'error.agentInstallDshMissing')
    assert.equal(keyFor(25), 'error.agentInstallNodeDownloadFailed')
  })

  it('keeps the generic message for anything unmapped', () => {
    assert.equal(installerUi(new Error('boom')).key, 'error.agentInstallFailed')
    // 26 (profile migration) is deliberately generic: the log carries the fix.
    assert.equal(installerUi(installerErrorForExit(26)).key, 'error.agentInstallFailed')
  })

  it('tells the operator which Node.js version is required', () => {
    const ui = installerUi(installerErrorForExit(22))
    assert.equal(ui.params?.required, '22.19.0')
  })
})

describe('provision progress mapping', () => {
  it('does not jump to the final stage when the npm agent is installed', () => {
    assert.equal(progressForLine('dsh-remote: installed agent from npm'), 'agentInstalling')
    assert.equal(progressForLine('dsh-remote: installed node.js'), 'nodeInstalled')
    assert.equal(progressForLine('dsh-remote: installed'), 'installed')
  })
  // The two upload lines are emitted by provisionRemoteAgent itself, not by the
  // bootstrap script; installer/test/provision.test.ts covers those.
  const SCRIPT_ONLY = PROVISION_PROGRESS.filter(([needle]) =>
    needle !== 'uploading agent package' && needle !== 'agent package uploaded')

  function render(start: 'systemd' | 'nohup', upgrade: boolean): string {
    return renderBootstrapScript({
      profile: 'web',
      port: 0,
      installDir: '$HOME/.local/share/dsh-remote',
      dshHome: '$HOME/.dsh',
      dshVersion: '0.2.2-rc.3',
      pnpmVersion: '11.21.0',
      nodeVersion: '22.19.0',
      autoInstallNode: true,
      upgrade,
      start,
      agentTarball: '/tmp/a.tgz',
    })
  }

  const cases: readonly (readonly [string, 'systemd' | 'nohup', boolean, readonly string[]])[] = [
    ['systemd fresh install', 'systemd', false, ['starting dsh web under nohup']],
    ['systemd upgrade', 'systemd', true, ['starting dsh web under nohup']],
    ['nohup fresh install', 'nohup', false, ['restarting systemd user unit']],
  ]

  for (const [label, start, upgrade, excluded] of cases) {
    it(`maps every stage the script prints (${label})`, () => {
      const lines = render(start, upgrade)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.includes('dsh-remote:'))
      for (const [needle, stage] of SCRIPT_ONLY) {
        if (excluded.includes(needle)) continue
        const matches = lines.filter(line => line.toLowerCase().includes(needle))
        assert.ok(matches.length > 0, `${label}: the script never prints "${needle}"`)
        // At least one matching line must map to the stage. This catches a
        // broader earlier needle stealing the match (for example "installed"
        // matching "installed node.js") and a missing final line.
        assert.ok(
          matches.some(line => progressForLine(line) === stage),
          `${label}: "${needle}" does not map to ${stage} (got ${String(progressForLine(matches[0]!))})`,
        )
      }
    })
  }
})
