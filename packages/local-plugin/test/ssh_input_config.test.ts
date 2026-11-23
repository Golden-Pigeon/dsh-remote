import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseSshConfig, scanSshHosts } from '../src/ssh/config.ts'
import { parseSshInput } from '../src/ssh/target.ts'

describe('SSH input parsing', () => {
  it('keeps a plain destination unchanged', () => {
    const parsed = parseSshInput('user@example-host:2222')
    assert.equal(parsed.target.canonical, 'user@example-host:2222')
    assert.deepEqual(parsed.sshArgs, [])
  })

  it('extracts options, user, and port from a full ssh command', () => {
    const parsed = parseSshInput(
      'ssh -p 2200 -l alice -i /tmp/key -o "ProxyCommand=ssh jump nc %h %p" host',
    )
    assert.equal(parsed.target.user, 'alice')
    assert.equal(parsed.target.port, 2200)
    assert.equal(parsed.target.host, 'host')
    assert.deepEqual(parsed.sshArgs, ['-i', '/tmp/key', '-o', 'ProxyCommand=ssh jump nc %h %p'])
  })

  it('preserves jump and boolean options', () => {
    const parsed = parseSshInput('ssh -4 -T -J jump-host target')
    assert.deepEqual(parsed.sshArgs, ['-4', '-T', '-J', 'jump-host'])
    assert.equal(parsed.target.canonical, 'target')
  })

  it('accepts attached port/user options and keeps other argv intact', () => {
    const parsed = parseSshInput('ssh -p2222 -lalice -F "/tmp/ssh config" host')
    assert.equal(parsed.target.canonical, 'alice@host:2222')
    assert.deepEqual(parsed.sshArgs, ['-F', '/tmp/ssh config'])
  })

  it('preserves empty quoted option values', () => {
    const parsed = parseSshInput('ssh -o "" host')
    assert.deepEqual(parsed.sshArgs, ['-o', ''])
    assert.equal(parsed.target.canonical, 'host')
  })

  it('rejects remote commands and incompatible managed options', () => {
    assert.throws(() => parseSshInput('ssh host uptime'), /remote command/i)
    assert.throws(() => parseSshInput('ssh -N host'), /incompatible/i)
    assert.throws(() => parseSshInput('ssh "host'), /unterminated/i)
    assert.throws(() => parseSshInput('user@host extra'), /starting with "ssh"/i)
  })
})

describe('SSH config discovery', () => {
  it('lists concrete aliases, keeps aliases distinct, and skips wildcard options', async () => {
    const text = [
      'Host alpha beta',
      '  HostName one.example',
      'Host *.example',
      '  User wildcard-user',
      'Host gamma',
      'Match host delta',
      '  User ignored',
      'Host epsilon',
      'Include extra.conf',
    ].join('\n')
    const parsed = await parseSshConfig(text, '/home/test/.ssh/config', async (pattern) => {
      assert.equal(pattern, 'extra.conf')
      return [{ path: '/home/test/.ssh/extra.conf', text: 'Host included\n' }]
    })
    assert.deepEqual(parsed.hosts.map(host => host.alias), ['alpha', 'beta', 'gamma', 'epsilon', 'included'])
    assert.deepEqual(parsed.skipped, [{ alias: '*.example', reason: 'wildcard' }])
  })

  it('expands wildcard directories and bracket classes in Include paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-glob-'))
    try {
      mkdirSync(join(dir, 'conf.d', 'a'), { recursive: true })
      mkdirSync(join(dir, 'conf.d', 'b'), { recursive: true })
      writeFileSync(join(dir, 'conf.d', 'a', 'one.conf'), 'Host one\n')
      writeFileSync(join(dir, 'conf.d', 'b', 'two.conf'), 'Host two\n')
      writeFileSync(join(dir, 'conf.d', 'host1.conf'), 'Host bracket\n')
      writeFileSync(join(dir, 'conf.d', 'hostx.conf'), 'Host not-matched\n')
      writeFileSync(join(dir, 'config'), [
        'Include "conf.d/*/*.conf"',
        'Include "conf.d/host[0-9].conf"',
      ].join('\n'))
      const result = await scanSshHosts({ configPath: join(dir, 'config'), homeDir: dir })
      assert.deepEqual(result.hosts, ['one', 'two', 'bracket'])
      assert.equal(result.error, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts quoted Include paths containing spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-space-'))
    try {
      const includeDir = join(dir, 'conf dir')
      mkdirSync(includeDir)
      writeFileSync(join(includeDir, 'extra.conf'), 'Host spaced-include\n')
      writeFileSync(join(dir, 'config'), `Include "${includeDir}/*.conf"`)
      const result = await scanSshHosts({ configPath: join(dir, 'config'), homeDir: dir })
      assert.deepEqual(result.hosts, ['spaced-include'])
      assert.equal(result.error, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads Included files and excludes wildcard aliases from scan results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-config-'))
    try {
      mkdirSync(join(dir, 'conf.d'))
      writeFileSync(join(dir, 'conf.d', 'extra.conf'), 'Host from-include\n')
      writeFileSync(join(dir, 'config'), [
        'Host direct',
        'Host *.wild',
        'Include conf.d/*.conf',
      ].join('\n'))
      const result = await scanSshHosts({ configPath: join(dir, 'config'), homeDir: dir })
      assert.deepEqual(result.hosts, ['direct', 'from-include'])
      assert.equal(result.error, null)
      assert.deepEqual(result.skipped, [{ alias: '*.wild', reason: 'wildcard' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
