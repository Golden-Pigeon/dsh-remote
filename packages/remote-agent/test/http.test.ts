import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { RemoteAgentClient } from '@dsh-remote/protocol'
import { handleAgentRequest } from '../src/http.ts'
import type { RemoteAgentService } from '../src/service.ts'
import { RemoteTerminalManager } from '../src/terminal.ts'

describe('agent HTTP file and terminal surface', () => {
  let server: Server
  let baseUrl: string
  let dir: string
  const manager = new RemoteTerminalManager()
  const token = 'http-test-token'
  const service = {
    admitsPeer: () => true,
    token,
    terminals: manager,
  } as unknown as RemoteAgentService

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-agent-http-'))
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    server = createServer((req, res) => {
      void handleAgentRequest({ logger: { warn() {} } } as never, service, req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    manager.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('serves file, directory, and watch requests', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const file = join(dir, 'a.txt')
    assert.equal((await client.fileStat(file)).bytes, 14)
    assert.equal((await client.fileRead(file, 2, 1)).text, 'two')
    assert.equal((await client.fileList(dir)).entries[0]?.name, 'a.txt')
    assert.equal((await client.listDirectories(dir)).entries.length, 0)
    const controller = new AbortController()
    const frames = []
    for await (const frame of client.followFileChanges(file, controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) {
        controller.abort()
        break
      }
    }
    assert.equal(frames[0]?.kind, 'ready')
    assert.equal(frames[1]?.kind, 'change')
  })

  it('serves terminal create, attach, input, list, and close', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const info = await client.createTerminal({ id: 'http-t1', cwd: dir, cols: 80, rows: 24 })
    assert.equal(info.state, 'running')
    const controller = new AbortController()
    const output: string[] = []
    const reader = (async () => {
      for await (const frame of client.attachTerminal('http-t1', controller.signal)) {
        if (frame.type === 'output') output.push(frame.data)
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 300))
    await client.terminalInput('http-t1', { type: 'write', data: 'printf "agent-http-ok\\n"\n' })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.ok(output.join('').includes('agent-http-ok'))
    assert.equal((await client.listTerminals())[0]?.id, 'http-t1')
    await client.renameTerminal('http-t1', 'renamed')
    await client.closeTerminal('http-t1')
    await reader
  })
})
