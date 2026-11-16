import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { fromOptions, renderBootstrapScript, renderSystemdUnit, shellPath } from '../src/bootstrap.ts'
import { commandPlan, plannedTarballName, tarballNameForVersion } from '../src/commands.ts'
import { HELP, parseArgs, resolveScpBinary, UsageError } from '../src/options.ts'
import { parseTarget, scpArgs, sshArgs, type ScpOptions, type SshOptions } from '../src/ssh.ts'

const baseArgs = ['plan', '--target', 'example-host'] as const

describe('installer options', () => {
  it('parses commands and defaults', () => {
    const options = parseArgs(baseArgs)
    assert.equal(options.command, 'plan')
    assert.equal(options.target, 'example-host')
    assert.equal(options.profile, 'web')
    assert.equal(options.port, 0)
    assert.equal(options.start, 'systemd')
    assert.equal(options.dshVersion, '0.2.2-rc.2')
    assert.equal(options.nodeVersion, '22.19.0')
    assert.equal(options.autoInstallNode, true)
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
    // Direct mode does write the key to the remote host, so help must not
    // claim the key is never copied; it has to name both modes instead.
    assert.doesNotMatch(HELP, /never copies model API keys/)
    assert.match(HELP, /direct \(default\)/)
    assert.match(HELP, /proxy/)
    assert.match(HELP, /DEEPSEEK_API_KEY/)
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

  it('builds the scp argv with an upper-case port flag', () => {
    const options: ScpOptions = {
      binary: 'scp',
      strictHostKeyChecking: 'accept-new',
      verbose: false,
      timeoutMs: 30_000,
    }
    const args = scpArgs(parseTarget('alice@example-host:2222'), options, '/tmp/a.tgz', '/tmp/b.tgz')
    // scp uses -P while ssh uses -p; mixing them silently uploads to the wrong port.
    assert.ok(args.includes('-P'))
    assert.ok(!args.includes('-p'))
    // The upload must not block on a prompt or a dead connection.
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('ConnectTimeout=30'))
    assert.deepEqual(args.slice(-2), ['/tmp/a.tgz', 'alice@example-host:/tmp/b.tgz'])
  })
})

describe('scp binary pairing', () => {
  it('keeps the bare scp on PATH for a bare ssh', () => {
    assert.equal(resolveScpBinary('ssh', undefined), 'scp')
    assert.equal(resolveScpBinary('ssh', ''), 'scp')
    assert.equal(resolveScpBinary('ssh', '   '), 'scp')
  })

  it('pairs a custom ssh path with its existing sibling scp', { skip: process.platform === 'win32' }, () => {
    const binary = resolveScpBinary('/opt/openssh/bin/ssh', undefined, path => path === '/opt/openssh/bin/scp')
    assert.equal(binary, '/opt/openssh/bin/scp')
  })

  it('keeps the ssh extension on Windows', () => {
    const binary = resolveScpBinary('C:\\OpenSSH\\ssh.exe', undefined, path => path === 'C:\\OpenSSH\\scp.exe')
    assert.equal(binary, 'C:\\OpenSSH\\scp.exe')
  })

  it('keeps a relative ssh path usable', { skip: process.platform === 'win32' }, () => {
    assert.equal(resolveScpBinary('./ssh', undefined, path => path === './scp'), './scp')
    assert.equal(resolveScpBinary('a/../ssh', undefined, path => path === 'a/../scp'), 'a/../scp')
  })

  it('finds scp.exe for an extensionless Windows ssh path', () => {
    assert.equal(
      resolveScpBinary('C:\\OpenSSH\\ssh', undefined, path => path === 'C:\\OpenSSH\\scp.exe'),
      'C:\\OpenSSH\\scp.exe',
    )
    // When both spellings exist, the native executable wins over an
    // extensionless helper.
    assert.equal(
      resolveScpBinary('C:\\OpenSSH\\ssh', undefined, () => true),
      'C:\\OpenSSH\\scp.exe',
    )
  })

  it('keeps a POSIX path with a backslash on POSIX', { skip: process.platform === 'win32' }, () => {
    assert.equal(
      resolveScpBinary('/srv/odd\\dir/ssh', undefined, path => path === '/srv/odd\\dir/scp'),
      '/srv/odd\\dir/scp',
    )
  })

  it('falls back to PATH scp when the sibling is missing', () => {
    // A custom build may ship ssh alone; that must not break the upload that
    // used to work through the system scp.
    assert.equal(resolveScpBinary('/opt/openssh/bin/ssh', undefined, () => false), 'scp')
  })

  it('lets an explicit scp win', () => {
    assert.equal(resolveScpBinary('/opt/openssh/bin/ssh', '/usr/bin/scp'), '/usr/bin/scp')
    assert.equal(resolveScpBinary('ssh', '  /usr/bin/scp  '), '/usr/bin/scp')
  })

  it('exposes the pairing through the parsed options', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scp-pair-'))
    try {
      writeFileSync(join(dir, 'ssh'), '')
      writeFileSync(join(dir, 'scp'), '')
      assert.equal(parseArgs([...baseArgs, '--ssh', join(dir, 'ssh')]).scpBinary, join(dir, 'scp'))
      rmSync(join(dir, 'scp'))
      assert.equal(parseArgs([...baseArgs, '--ssh', join(dir, 'ssh')]).scpBinary, 'scp')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    assert.equal(parseArgs([...baseArgs]).scpBinary, 'scp')
    assert.equal(parseArgs([...baseArgs, '--scp', '/usr/bin/scp']).scpBinary, '/usr/bin/scp')
  })

  it('documents the flag in help', () => {
    assert.match(HELP, /--scp/u)
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
      nodeVersion: '22.19.0',
      autoInstallNode: true,
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(unit, /Environment="DSH_HOME=\$DSH_HOME"/)
    assert.match(unit, /PATH=.*:\$PATH/)
    assert.match(unit, /ExecStart="\$DSH_BIN" web --host 127\.0\.0\.1 --port \$PORT --no-open/)
  })

  it('renders proxy env only when configured', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, installDir: '/opt/dsh', dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', nodeVersion: '22.19.0', autoInstallNode: true, start: 'nohup',
      agentTarball: '/tmp/a.tgz', modelBaseUrl: 'http://127.0.0.1:47821', modelApiKey: 'placeholder',
    })
    assert.match(script, /DEEPSEEK_BASE_URL="\$MODEL_BASE_URL" DEEPSEEK_API_KEY="\$MODEL_API_KEY" nohup/)
  })

  it('exports a remote install proxy for bootstrap downloads', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, installDir: '/opt/dsh', dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', nodeVersion: '22.19.0', autoInstallNode: true, start: 'nohup',
      agentTarball: '/tmp/a.tgz', proxyUrl: 'http://127.0.0.1:17890', noProxy: '127.0.0.1,localhost',
    })
    assert.match(script, /PROXY_URL='http:\/\/127\.0\.0\.1:17890'/)
    assert.match(script, /export HTTP_PROXY="\$PROXY_URL"/)
    assert.match(script, /npm_config_proxy="\$PROXY_URL"/)
    assert.match(script, /install proxy configured/)
  })

  it('passes the runtime proxy into the systemd service environment', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, installDir: '/opt/dsh', dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', nodeVersion: '22.19.0', autoInstallNode: true, start: 'systemd',
      agentTarball: '/tmp/a.tgz', proxyUrl: 'http://127.0.0.1:7891', noProxy: '127.0.0.1,localhost',
    })
    assert.match(script, /PROXY_ENV_LINES=/)
    assert.match(script, /Environment=\\"HTTP_PROXY=\$PROXY_URL\\"/)
    assert.match(script, /\$\{PROXY_ENV_LINES\}/)
  })

  it('stops the service and replaces DSH for a manual upgrade', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, installDir: '/opt/dsh', dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.3', pnpmVersion: '11.21.0', nodeVersion: '22.19.0',
      autoInstallNode: true, upgrade: true, start: 'systemd', agentTarball: '/tmp/a.tgz',
    })
    assert.match(script, /DSH_UPGRADE=1/)
    assert.match(script, /stopping the remote DSH service before upgrading/)
    assert.match(script, /systemctl --user stop dsh-remote-agent\.service/)
    assert.match(script, /rm -f "\$STATE_FILE"/)
    assert.match(script, /if \[ "\$DSH_UPGRADE" -eq 1 \] \|\| \[ ! -x "\$DSH_BIN" \]; then/)
    assert.match(script, /upgrading @deepseek-ai\/dsh to \$DSH_VERSION/)
    assert.match(script, /npm install --prefix "\$INSTALL_DIR".*"@deepseek-ai\/dsh@\$DSH_VERSION"/)
  })

  it('keeps a fresh install from replacing an existing DSH', () => {
    const script = renderBootstrapScript({
      profile: 'web', port: 0, installDir: '/opt/dsh', dshHome: '/srv/dsh',
      dshVersion: '0.2.1-rc.2', pnpmVersion: '11.21.0', nodeVersion: '22.19.0',
      autoInstallNode: true, start: 'nohup', agentTarball: '/tmp/a.tgz',
    })
    assert.match(script, /DSH_UPGRADE=0/)
    assert.match(script, /if \[ "\$DSH_UPGRADE" -eq 1 \] \|\| \[ ! -x "\$DSH_BIN" \]; then/)
  })

  it('renders the bootstrap script and never embeds a token', () => {
    const script = fromOptions(options, '/tmp/agent.tgz')
    assert.match(script, /set -euo pipefail/)
    assert.match(script, /AUTO_INSTALL_NODE=1/)
    assert.match(script, /umask 077/)
    assert.match(script, /chmod 600 "\$UNIT_DIR\/dsh-remote-agent\.service"/)
    assert.match(script, /NODE_VERSION='22\.19\.0'/)
    assert.match(script, /install_node\(\)/)
    assert.match(script, /SHASUMS256\.txt/)
    assert.match(script, /--strip-components=1/)
    assert.match(script, /npm install --prefix "\$INSTALL_DIR"/)
    assert.match(script, /cp -f "\$AGENT_TARBALL" "\$AGENT_ARTIFACT"/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_ARTIFACT"/)
    assert.match(script, /systemd/)
    assert.doesNotMatch(script, /token/i)
    assert.match(script, /remote-agent\/agent\.json/)
  })

  it('prefers the scoped npm agent and keeps the bundled fallback', () => {
    const script = fromOptions({ ...parseArgs(baseArgs), agentPackageSpec: '@goldenpigeon/dsh-remote-agent@0.2.2' }, '/tmp/agent.tgz')
    assert.match(script, /AGENT_NPM_SPEC='@goldenpigeon\/dsh-remote-agent@0\.2\.2'/)
    assert.match(script, /plugin --profile "\$PROFILE" add "\$AGENT_NPM_SPEC"/)
    assert.match(script, /npm agent unavailable; installing the bundled agent/)
  })

  it('migrates legacy agent profile entries before installing', () => {
    const script = fromOptions(parseArgs(baseArgs), '/tmp/agent.tgz')
    assert.match(script, /DSH_REMOTE_MIGRATE/)
    assert.match(script, /delete data.dependencies\['dsh-remote-agent'\]/)
    assert.match(script, /removed the legacy dsh-remote-agent profile entry/)
    assert.match(script, /pnpm-lock.yaml.legacy-backup/)
  })

  it('supports nohup and none start modes', () => {
    const nohup = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'nohup']), '/tmp/agent.tgz')
    assert.match(nohup, /nohup "\$DSH_BIN" web/)
    assert.doesNotMatch(nohup, /DEEPSEEK_BASE_URL=/)
    const none = fromOptions(parseArgs(['plan', '--target', 'example-host', '--start', 'none']), '/tmp/agent.tgz')
    assert.match(none, /start mode none/)
    assert.doesNotMatch(none, /systemctl --user enable/)
    const systemd = fromOptions(options, '/tmp/agent.tgz')
    assert.match(systemd, /systemctl --user restart dsh-remote-agent\.service/)
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
      nodeVersion: '22.19.0',
      autoInstallNode: true,
      start: 'systemd',
      agentTarball: '/tmp/agent.tgz',
    })
    assert.match(script, /PROFILE='remote'/)
    assert.match(script, /PORT='9090'/)
    assert.match(script, /DSH_HOME='\/srv\/dsh-home'/)
  })

  it('names the planned tarball after the real agent version', () => {
    assert.equal(tarballNameForVersion('9.9.9'), '/tmp/dsh-remote-agent-9.9.9.tgz')
    // An unreadable manifest must drop the version rather than invent one.
    assert.equal(tarballNameForVersion(undefined), '/tmp/dsh-remote-agent.tgz')
    // Read the manifest directly: comparing plannedTarballName() against
    // agentVersion() would pass even if agentVersion() regressed to undefined.
    const manifest = JSON.parse(readFileSync(new URL('../../remote-agent/package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(plannedTarballName(), `/tmp/dsh-remote-agent-${manifest.version}.tgz`)
  })

  it('uses the real name in the plan output', () => {
    const script = commandPlan(parseArgs(baseArgs))
    assert.ok(script.includes(`AGENT_TARBALL='${plannedTarballName()}'`), script.slice(0, 600))
  })
})
