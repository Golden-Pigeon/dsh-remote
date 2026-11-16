import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createIncludeLoader,
  expandSshPath,
  isWildcardPattern,
  parseResolvedHost,
  parseSshConfig,
  resolveSshHost,
  scanSshConfig,
  splitConfigLine,
  type IncludeLoader,
  type RunSsh,
  type SshConfigFile,
} from '../src/ssh/config.ts'

/** Include loader backed by a fixed table. */
function table(files: Record<string, string>): IncludeLoader {
  return async (pattern): Promise<readonly SshConfigFile[]> => {
    const text = files[pattern]
    return text === undefined ? [] : [{ path: pattern, text }]
  }
}

const noIncludes: IncludeLoader = async () => []

describe('SSH config vocabulary', () => {
  it('splits keyword/value forms and ignores comments', () => {
    assert.deepEqual(splitConfigLine('Host foo'), { keyword: 'host', value: 'foo' })
    assert.deepEqual(splitConfigLine('  HostName\t1.2.3.4  '), { keyword: 'hostname', value: '1.2.3.4' })
    assert.deepEqual(splitConfigLine('Port=2222'), { keyword: 'port', value: '2222' })
    assert.deepEqual(splitConfigLine('User = alice'), { keyword: 'user', value: 'alice' })
    assert.deepEqual(splitConfigLine('  # Host ignored'), null)
    assert.deepEqual(splitConfigLine('   '), null)
    // A quote-wrapped value keeps its spaces but loses the quotes.
    assert.deepEqual(splitConfigLine('IdentityFile "~/my key"'), { keyword: 'identityfile', value: '~/my key' })
  })

  it('recognises wildcard patterns but not literal aliases', () => {
    assert.equal(isWildcardPattern('*'), true)
    assert.equal(isWildcardPattern('*.devcloud.woa.com'), true)
    assert.equal(isWildcardPattern('!bad'), true)
    assert.equal(isWildcardPattern('host?'), true)
    assert.equal(isWildcardPattern('native1'), false)
    assert.equal(isWildcardPattern('devcloud_64g_user00'), false)
  })
})

describe('SSH config parsing', () => {
  it('splits a multi-alias Host line and keeps declared values', async () => {
    const parsed = await parseSshConfig([
      'Host docker_os4_native1_user00 native1',
      '  HostName 21.91.16.78',
      '  User user00',
      '  Port 36000',
    ].join('\n'), '/home/u/.ssh/config', noIncludes)
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['docker_os4_native1_user00', 'native1'])
    assert.equal(parsed.hosts[0]?.hostname, '21.91.16.78')
    assert.equal(parsed.hosts[0]?.user, 'user00')
    assert.equal(parsed.hosts[0]?.port, 36000)
    // Registration stores the alias, so the canonical form is the alias itself.
    assert.equal(parsed.hosts[1]?.canonical, 'native1')
    assert.equal(parsed.skipped.length, 0)
  })

  it('skips wildcard defaults and negations instead of offering them', async () => {
    const parsed = await parseSshConfig([
      'Host *.devcloud.woa.com',
      '  User root',
      'Host *',
      '  ServerAliveInterval 15',
      'Host !blocked other',
      '  User bob',
    ].join('\n'), '/home/u/.ssh/config', noIncludes)
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['other'])
    assert.deepEqual(parsed.skipped.map(entry => entry.alias).sort(), ['!blocked', '*.devcloud.woa.com', '*'].sort())
    assert.ok(parsed.skipped.every(entry => entry.reason === 'wildcard'))
  })

  it('keeps the first value of a repeated key, matching ssh precedence', async () => {
    const parsed = await parseSshConfig([
      'Host first',
      '  User alice',
      '  User bob',
      '  HostName 10.0.0.1',
      '  HostName 10.0.0.2',
    ].join('\n'), '/home/u/.ssh/config', noIncludes)
    assert.equal(parsed.hosts[0]?.user, 'alice')
    assert.equal(parsed.hosts[0]?.hostname, '10.0.0.1')
  })

  it('does not let a Match block leak into an alias', async () => {
    const parsed = await parseSshConfig([
      'Host real',
      '  HostName 10.0.0.9',
      'Match host *.corp',
      '  User conditional',
      'Host second',
      '  User carol',
    ].join('\n'), '/home/u/.ssh/config', noIncludes)
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['real', 'second'])
    assert.equal(parsed.hosts[0]?.user, null, 'Match body must not apply to the previous host')
    assert.equal(parsed.hosts[1]?.user, 'carol')
  })

  it('includes other files and attributes their aliases to the included path', async () => {
    const parsed = await parseSshConfig([
      'Host *.any.woa.com',
      'Host *.devcloud.woa.com',
      'Include ~/.ssh/devcloud_config',
    ].join('\n'), '/home/u/.ssh/config', table({
      '~/.ssh/devcloud_config': 'Host included-host\n  HostName weyoungli-any198.devcloud.woa.com\n',
    }))
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['included-host'])
    assert.equal(parsed.hosts[0]?.source, '~/.ssh/devcloud_config')
    assert.equal(parsed.hosts[0]?.hostname, 'weyoungli-any198.devcloud.woa.com')
  })

  it('survives an include cycle and a missing include', async () => {
    const parsed = await parseSshConfig([
      'Host outer',
      'Include cycle',
    ].join('\n'), '/home/u/.ssh/config', table({
      cycle: 'Host cyclic\nInclude /home/u/.ssh/config\n',
    }))
    // The already-visited root file is not re-read, so this terminates.
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['cyclic', 'outer'])
  })

  it('reports aliases the registry would reject as unsupported', async () => {
    const parsed = await parseSshConfig([
      'Host ok-host',
      'Host -starts-with-dash',
    ].join('\n'), '/home/u/.ssh/config', noIncludes)
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['ok-host'])
    const unsupported = parsed.skipped.find(entry => entry.alias === '-starts-with-dash')
    assert.equal(unsupported?.reason, 'unsupported')
  })

  it('accepts every literal alias shape this machine actually uses', async () => {
    const aliases = [
      'native1', 'native2', 'native3', 'cloud32', 'cloud64',
      'devcloud_64g_user00', 'devcloud_64g_weyoungli', 'devcloud_32g_user00',
      'devcloud_32g_weyoungli', 'docker_os4_native1_user00', 'docker_os4_native3_user00',
      'devcloud_okar_weyoungli', 'docker_okar_okarinhuang', 'docker_git_svn_pack_user00',
      'docker_os4_native2_user00',
    ]
    const parsed = await parseSshConfig(
      aliases.map(alias => `Host ${alias}\n  User user00`).join('\n'),
      '/home/u/.ssh/config',
      noIncludes,
    )
    assert.deepEqual(parsed.hosts.map(host => host.alias), aliases)
    assert.deepEqual(parsed.skipped, [])
  })
})

describe('SSH config path expansion', () => {
  it('expands tilde and resolves relative includes against the declaring file', () => {
    assert.equal(expandSshPath('~/.ssh/config', '/base', '/home/u'), '/home/u/.ssh/config')
    assert.equal(expandSshPath('extra.conf', '/home/u/.ssh', '/home/u'), '/home/u/.ssh/extra.conf')
    assert.equal(expandSshPath('/etc/ssh/ssh_config', '/base', '/home/u'), '/etc/ssh/ssh_config')
  })
})

describe('ssh -G resolution', () => {
  it('takes the first value of each key and detects a jump host', () => {
    const resolved = parseResolvedHost([
      'host native1',
      'user user00',
      'hostname 21.91.16.78',
      'port 36000',
      'proxyjump none',
      'user ignored',
      'hostname ignored',
    ].join('\n'))
    assert.deepEqual(resolved, { hostname: '21.91.16.78', user: 'user00', port: 36000, proxyJump: false })
  })

  it('flags a real ProxyJump or ProxyCommand', () => {
    assert.equal(parseResolvedHost('hostname h\nproxyjump bastion\n')?.proxyJump, true)
    assert.equal(parseResolvedHost('hostname h\nproxycommand ssh -W %h:%p bastion\n')?.proxyJump, true)
    assert.equal(parseResolvedHost('no hostname here\n'), null)
  })

  it('passes -F only when an explicit config was configured', async () => {
    const calls: string[][] = []
    const runSsh: RunSsh = async args => {
      calls.push([...args])
      return { stdout: 'hostname 1.2.3.4\nuser alice\nport 22\n', stderr: '', code: 0 }
    }
    await resolveSshHost('alias', { sshBinary: 'ssh', configPath: null, timeoutMs: 1_000, runSsh })
    await resolveSshHost('alias', { sshBinary: 'ssh', configPath: '/tmp/cfg', timeoutMs: 1_000, runSsh })
    assert.deepEqual(calls, [['-G', 'alias'], ['-F', '/tmp/cfg', '-G', 'alias']])
  })

  it('returns null when ssh fails, so the caller can fall back', async () => {
    const failing: RunSsh = async () => ({ stdout: '', stderr: 'boom', code: 255 })
    assert.equal(await resolveSshHost('alias', { sshBinary: 'ssh', configPath: null, timeoutMs: 1_000, runSsh: failing }), null)
    const throwing: RunSsh = async () => { throw new Error('spawn failed') }
    assert.equal(await resolveSshHost('alias', { sshBinary: 'ssh', configPath: null, timeoutMs: 1_000, runSsh: throwing }), null)
  })
})

describe('SSH config scan', () => {
  it('overlays resolved values on the declared ones and bounds concurrency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshr-sshcfg-'))
    try {
      const configPath = join(dir, 'config')
      await writeFile(configPath, [
        'Host alpha',
        '  HostName declared-alpha',
        '  User declared',
        'Host beta',
        '  HostName declared-beta',
        'Host gamma',
        '  HostName declared-gamma',
      ].join('\n'))
      let inFlight = 0
      let peak = 0
      const runSsh: RunSsh = async args => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        const alias = args[args.length - 1]
        return { stdout: `hostname ${alias}.example\nuser alice\nport 2222\n`, stderr: '', code: 0 }
      }
      const scan = await scanSshConfig({
        configPath,
        sshBinary: 'ssh',
        timeoutMs: 1_000,
        homeDir: dir,
        concurrency: 2,
        runSsh,
        loadInclude: noIncludes,
      })
      assert.equal(scan.error, null)
      // `ssh -G` is authoritative for what the connection will actually use.
      assert.deepEqual(scan.hosts.map(host => host.hostname), ['alpha.example', 'beta.example', 'gamma.example'])
      assert.ok(scan.hosts.every(host => host.user === 'alice' && host.port === 2222))
      assert.ok(peak <= 2, `expected at most 2 concurrent ssh calls, saw ${peak}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the declared values when ssh -G cannot resolve an alias', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshr-sshcfg-'))
    try {
      const configPath = join(dir, 'config')
      await writeFile(configPath, 'Host alpha\n  HostName declared-alpha\n  User declared\n')
      const scan = await scanSshConfig({
        configPath,
        sshBinary: 'ssh',
        timeoutMs: 1_000,
        homeDir: dir,
        runSsh: async () => ({ stdout: '', stderr: 'no', code: 255 }),
        loadInclude: noIncludes,
      })
      assert.equal(scan.hosts[0]?.hostname, 'declared-alpha')
      assert.equal(scan.hosts[0]?.user, 'declared')
      assert.equal(scan.hosts[0]?.proxyJump, false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a missing config as an empty inventory, not an error', async () => {
    const result = await scanSshConfig({
      configPath: '/definitely/not/a/config',
      sshBinary: 'ssh',
      timeoutMs: 1_000,
      homeDir: '/home/u',
      loadInclude: noIncludes,
    })
    assert.deepEqual(result.hosts, [])
    assert.deepEqual(result.skipped, [])
    assert.equal(result.error, null)
  })

  it('surfaces an unreadable config as an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshr-sshcfg-'))
    try {
      // A directory in the config's place fails with something other than ENOENT.
      const asDirectory = join(dir, 'config')
      await mkdir(asDirectory)
      const scan = await scanSshConfig({
        configPath: asDirectory,
        sshBinary: 'ssh',
        timeoutMs: 1_000,
        homeDir: dir,
        loadInclude: noIncludes,
      })
      assert.deepEqual(scan.hosts, [])
      assert.ok(scan.error !== null, 'an unreadable config must be reported')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('default include loader', () => {
  it('returns nothing for a missing file instead of throwing', async () => {
    const load = createIncludeLoader('/home/u')
    assert.deepEqual(await load('/definitely/not/here', '/home/u'), [])
    assert.deepEqual(await load('globs-nomatch-*', '/definitely/not/a/dir'), [])
  })
})
