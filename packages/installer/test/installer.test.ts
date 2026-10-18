import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fromOptions, renderBootstrapScript, renderSystemdUnit, shellPath } from '../src/bootstrap.ts'
import { HELP, parseArgs, UsageError } from '../src/options.ts'
import { parseTarget, sshArgs, type SshOptions } from '../src/ssh.ts'

const baseArgs = ['plan', '--target', 'example-host'] as const

describe('installer options', () => {
  it('parses commands and defaults', () => {
    const options = parseArgs(baseArgs)
    assert.equal(options.command, 'plan')
    assert.equal(options.target, 'example-host')
    assert.equal(options.profile, 'web')
    assert.equal(options.port, 0)
    assert.equal(options.start, 'systemd')
    assert.equal(options.dshVersion, '0.2.1-rc.2')
    assert.equal(options.strictHostKeyChecking, 'accept-new')
  })

  it('accepts a positional target and explicit flags', () => {
    const options = parseArgs(['discover', 'alice@example-host:2222', '--json', '--start', 'nohup', '--port', '8080'])
    assert.equal(options.command, 'discover')
    assert.equal(options.target, 'alice@example-host:2222')
    assert.equal(options.json, true)
    assert.equal(options.start, 'nohup')
    assert.equal(options.port, 8080)
  })

  it('rejects missing targets and malformed values', () => {
    assert.throws(() => parseArgs(['install']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--port', 'x']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--start', 'bogus']), UsageError)
    assert.throws(() => parseArgs([...baseArgs, '--nope']), UsageError)
  })

  it('documents the security model in help', () => {
    assert.match(HELP, /never copies model API keys/)
    assert.match(HELP, /127\.0\.0\.1/)
  })
})

describe('SSH target parsing', () => {
  it('accepts aliases, user@host, ports, and URLs', () => {
    assert.equal(parseTarget('example-host').canonical, 'example-host')
    assert.equal(parseTarget('alice@example-host:2222').canonical, 'alice@example-host:2222')
    assert.equal(parseTarget('ssh://alice@example-host:22').canonical, 'alice@example-host:22')
  })

  it('rejects option and shell injection', () => {
    assert.throws(() => parseTarget('-oProxyCommand=x'))
    assert.throws(() => parseTarget('alice@example-host;rm -rf /'))
    assert.throws(() => parseTarget('alice@example-host:0'))
  })

  it('builds argv without a shell', () => {
    const options: SshOptions = {
      binary: 'ssh',
      strictHostKeyChecking: 'accept-new',
      timeoutMs: 15_000,
      verbose: false,
    }
    const args = sshArgs(parseTarget('alice@example-host:2222'), options)
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('StrictHostKeyChecking=accept-new'))
    assert.deepEqual(args.slice(-2), ['-p', '2222'])
  })
})

describe('bootstrap rendering', () => {
  const options = parseArgs(['plan', '--target', 'example-host', '--port', '8080'])

  it('renders a systemd unit with runtime-expanded paths', () => {
    const unit = renderSystemdUnit({
      profile: 'web',
      port: 8080,
      installDir: '$HOME/.local/share/dsh-remote',
      dshHome: '$HOME/.dsh',
      dshVersion: '0.2.1-rc.2',
      pnpmVersion: '11.21.0',
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(unit, /Environment="DSH_HOME=\$DSH_HOME"/)
    assert.match(unit, /ExecStart="\$DSH_BIN" web --host 127\.0\.0\.1 --port \$PORT --no-open/)
  })

  it('renders the bootstrap script and never embeds a token', () => {
    const script = fromOptions(options, '/tmp/agent.tgz')
    assert.match(script, /set -euo pipefail/)
    assert.match(script, /npm install --prefix "\$INSTALL_DIR"/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_TARBALL"/)
    assert.match(script, /systemd/)
    assert.doesNotMatch(script, /token/i)
    assert.match(script, /remote-agent\/agent\.json/)
  })

  it('supports nohup and none start modes', () => {
    const nohup = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'nohup']), '/tmp/agent.tgz')
    assert.match(nohup, /nohup "\$DSH_BIN" web/)
    const none = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'none']), '/tmp/agent.tgz')
    assert.match(none, /start mode none/)
    assert.doesNotMatch(none, /systemctl --user enable/)
  })

  it('expands tilde paths only at remote runtime', () => {
    assert.equal(shellPath('$HOME/.dsh'), `"$HOME/"'.dsh'`)
    assert.equal(shellPath('/srv/dsh'), `'/srv/dsh'`)
    assert.equal(shellPath('~'), '"$HOME"')
  })

  it('keeps the rendered port and profile', () => {
    const script = renderBootstrapScript({
      profile: 'remote',
      port: 9090,
      installDir: '/opt/dsh',
      dshHome: '/srv/dsh-home',
      dshVersion: '0.2.1-rc.2',
      pnpmVersion: '11.21.0',
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(script, /PROFILE='remote'/)
    assert.match(script, /PORT='9090'/)
    assert.match(script, /DSH_HOME='\/srv\/dsh-home'/)
  })
})
