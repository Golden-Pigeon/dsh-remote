import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { InstallerError } from '../src/errors.ts'
import { provisionRemoteAgent, type ProvisionRemoteOptions } from '../src/provision.ts'

/** These fixtures are POSIX shell scripts; the Windows runner is out of scope. */
const skip = process.platform === 'win32'

function executable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function baseOptions(dir: string, scpBinary: string, sshBinary: string): ProvisionRemoteOptions {
  return {
    target: 'alice@example-host:2222',
    agentTarballPath: join(dir, 'agent.tgz'),
    sshBinary,
    scpBinary,
    strictHostKeyChecking: 'accept-new',
    profile: 'web',
    port: 7731,
    installDir: '/opt/dsh',
    dshHome: '/srv/dsh',
    dshVersion: '0.2.2-rc.3',
    pnpmVersion: '11.21.0',
    nodeVersion: '22.19.0',
    autoInstallNode: true,
    start: 'nohup',
  }
}

describe('programmatic provisioning', { skip }, () => {
  it('uses the supplied scp/ssh binaries and forwards the port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-provision-'))
    try {
      const argsPath = join(dir, 'scp-args.txt')
      const stdinPath = join(dir, 'ssh-stdin.txt')
      const scp = executable(join(dir, 'scp'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nexit 0\n`)
      const ssh = executable(join(dir, 'ssh'), `#!/bin/sh\ncat > '${stdinPath}'\nexit 0\n`)
      const options = baseOptions(dir, scp, ssh)
      writeFileSync(options.agentTarballPath, 'tarball')
      const progress: string[] = []

      const result = await provisionRemoteAgent({ ...options, onProgress: line => progress.push(line) })

      const scpArgs = readFileSync(argsPath, 'utf8').trim().split('\n')
      // These assertions fail if either binary is ignored: the real host does
      // not exist, and the real scp would never write this capture file.
      assert.ok(scpArgs.includes(options.agentTarballPath))
      assert.ok(scpArgs.some(arg => arg.startsWith('alice@example-host:/tmp/dsh-remote-agent-')))
      assert.ok(scpArgs.includes('-P'))
      assert.ok(scpArgs.includes('2222'))

      const script = readFileSync(stdinPath, 'utf8')
      assert.match(script, /PORT='7731'/u)
      assert.match(script, /AGENT_TARBALL='\/tmp\/dsh-remote-agent-/u)
      assert.deepEqual(progress.slice(0, 2), [
        'dsh-remote: uploading agent package',
        'dsh-remote: agent package uploaded',
      ])
      assert.ok(result.remoteTarball.startsWith('/tmp/dsh-remote-agent-'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid port before uploading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-provision-port-'))
    try {
      const argsPath = join(dir, 'scp-args.txt')
      const scp = executable(join(dir, 'scp'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nexit 0\n`)
      const ssh = executable(join(dir, 'ssh'), '#!/bin/sh\ncat > /dev/null\nexit 0\n')
      const options = baseOptions(dir, scp, ssh)
      writeFileSync(options.agentTarballPath, 'tarball')

      await assert.rejects(
        provisionRemoteAgent({ ...options, port: 70_000 }),
        /port must be an integer between 0 and 65535/u,
      )
      assert.equal(existsSync(argsPath), false, 'the upload must not run with an invalid port')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a known bootstrap exit as a typed installer error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-provision-exit-'))
    try {
      const scp = executable(join(dir, 'scp'), '#!/bin/sh\nexit 0\n')
      const ssh = executable(
        join(dir, 'ssh'),
        "#!/bin/sh\ncat > /dev/null\necho 'dsh-remote: installing @deepseek-ai/dsh@0.2.2-rc.3' >&2\nexit 24\n",
      )
      const options = baseOptions(dir, scp, ssh)
      writeFileSync(options.agentTarballPath, 'tarball')

      await assert.rejects(provisionRemoteAgent(options), (error: unknown) => {
        assert.ok(error instanceof InstallerError)
        assert.equal(error.installerCode, 'install/dsh-missing')
        assert.equal(error.exitCode, 24)
        assert.match(error.message, /installing @deepseek-ai\/dsh@/u)
        return true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the scp failure instead of a generic bootstrap error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-provision-upload-'))
    try {
      const scp = executable(join(dir, 'scp'), "#!/bin/sh\necho 'scp: permission denied' >&2\nexit 1\n")
      const ssh = executable(join(dir, 'ssh'), '#!/bin/sh\ncat > /dev/null\nexit 0\n')
      const options = baseOptions(dir, scp, ssh)
      writeFileSync(options.agentTarballPath, 'tarball')

      await assert.rejects(provisionRemoteAgent(options), /scp failed with 1: scp: permission denied/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
