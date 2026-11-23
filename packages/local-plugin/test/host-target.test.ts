import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../src/config.ts'
import { RemoteHostsService } from '../src/service.ts'

describe('SSH command host registration', () => {
  it('normalizes a full ssh command and persists its options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-target-'))
    try {
      const config = resolveConfig({ stateDir: dir, autoProvision: false })
      const service = new RemoteHostsService({} as never, config, { localDshVersion: '0.2.2-rc.3' })
      assert.deepEqual(service.validateTarget('ssh -p 2222 -i /tmp/key user@example-host'), {
        canonical: 'user@example-host:2222',
        host: 'example-host',
        user: 'user',
        port: 2222,
      })
      const view = await service.add({
        sshTarget: 'ssh -p 2222 -i /tmp/key user@example-host',
        label: 'command-host',
        autoConnect: false,
      })
      assert.equal(view.sshTarget, 'user@example-host:2222')
      assert.equal(view.sshPort, 2222)
      const saved = JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8')) as {
        hosts: Array<{ sshTarget: string; sshPort: number | null; sshArgs?: string[] }>
      }
      assert.equal(saved.hosts[0]?.sshTarget, 'user@example-host:2222')
      assert.equal(saved.hosts[0]?.sshPort, 2222)
      assert.deepEqual(saved.hosts[0]?.sshArgs, ['-i', '/tmp/key'])
      await service.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
